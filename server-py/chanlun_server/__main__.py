"""CLI entry point: ``python -m chanlun_server <command>``.

    serve       启动 HTTP 服务 (默认)
    backtest    单标的一次性回测, 输出 JSON 报告
    chanlun     对给定标的打印缠论结构摘要
    strategies  列出已注册策略
    pool        跑一次选股池等权回测 (等待完成)
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict, List

from . import config
from .chanlun import run_chanlun_pipeline
from .klines import get_klines
from .runner import run_backtest
from .strategies import find_strategy, list_strategy_summaries


def _cmd_serve(args: argparse.Namespace) -> int:
    from .http_api import serve

    serve(args.host, args.port)
    return 0


def _load_klines(symbol: str, period: str, adjust: str, force: bool) -> List[Any]:
    result = get_klines(symbol, period, 500, adjust, force)
    return result.klines


def _cmd_backtest(args: argparse.Namespace) -> int:
    strategy = find_strategy(args.strategy)
    if strategy is None:
        print(f"策略未找到: {args.strategy}", file=sys.stderr)
        print("可用: " + ", ".join(s["id"] for s in list_strategy_summaries()), file=sys.stderr)
        return 2

    klines = _load_klines(args.symbol, args.period, args.adjust, args.force)
    if args.start:
        klines = [k for k in klines if k.date >= args.start]
    if args.end:
        klines = [k for k in klines if k.date <= args.end]
    if not klines:
        print("没有可用的 K 线数据", file=sys.stderr)
        return 1

    output = run_backtest(
        klines=klines,
        symbol=args.symbol,
        strategy=strategy,
        initial_cash=args.cash,
        stop_loss_percent=args.stop_loss,
        commission_rate=args.commission,
        min_commission=args.min_commission,
        params=json.loads(args.params) if args.params else {},
    )
    report: Dict[str, Any] = {
        "symbol": args.symbol,
        "strategy": strategy.id,
        "klinesCount": len(klines),
        "dateRange": {"start": klines[0].date, "end": klines[-1].date},
        "result": output.result.to_dict(),
        "diagnostics": [d.to_dict() for d in output.diagnostics][:20],
    }
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(report, fh, ensure_ascii=False, indent=2)
        print(f"报告已写入 {args.out}")
    else:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def _cmd_chanlun(args: argparse.Namespace) -> int:
    klines = _load_klines(args.symbol, args.period, args.adjust, args.force)
    payload = run_chanlun_pipeline(klines)
    summary = {
        "symbol": args.symbol,
        "klines": len(klines),
        "mergedKlines": len(payload["mergedKlines"]),
        "fractions": len(payload["fractions"]),
        "strokes": len(payload["strokes"]),
        "segments": len(payload["segments"]),
        "hubs": len(payload["hubs"]),
        "bsPoints": [
            {"type": p["type"], "date": p["date"], "price": p["price"]} for p in payload["bsPoints"]
        ],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


def _cmd_strategies(args: argparse.Namespace) -> int:
    print(json.dumps(list_strategy_summaries(), ensure_ascii=False, indent=2))
    return 0


def _cmd_pool(args: argparse.Namespace) -> int:
    import time

    from .pool import request_pool_backtest

    payload = {
        "strategyId": args.strategy,
        "indexes": [i for i in args.indexes.split(",") if i],
        "custom": [s for s in (args.custom or "").split(",") if s],
        "initialCash": args.cash,
    }
    job, attached = request_pool_backtest(payload)
    print(f"任务 {job.id} 已启动 (attached={attached})")
    while job.state == "running":
        time.sleep(1.0)
        p = job.progress
        print(f"  进度 {p['done']}/{p['total']} ok={p['ok']} failed={p['failed']}")
    if job.summary is None:
        print(f"任务结束: {job.state} {job.error or ''}", file=sys.stderr)
        return 1
    summary = job.summary
    print(
        json.dumps(
            {
                "tested": summary["tested"],
                "totalReturnPercent": round(summary["totalReturnPercent"], 2),
                "buyHoldReturnPercent": round(summary["buyHoldReturnPercent"], 2),
                "maxDrawdownPercent": summary["maxDrawdownPercent"],
                "sharpeRatio": round(summary["sharpeRatio"], 3),
                "traded": summary["traded"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="chanlun_server", description="缠论量化工作台 Python 后端")
    sub = parser.add_subparsers(dest="command")

    serve = sub.add_parser("serve", help="启动 HTTP 服务")
    serve.add_argument("--host", default=config.HOST)
    serve.add_argument("--port", type=int, default=config.PORT)
    serve.set_defaults(func=_cmd_serve)

    bt = sub.add_parser("backtest", help="单标的回测")
    bt.add_argument("--symbol", required=True)
    bt.add_argument("--strategy", default="ma-cross")
    bt.add_argument("--period", default="1d", choices=["1d", "1w"])
    bt.add_argument("--adjust", default="forward")
    bt.add_argument("--cash", type=float, default=config.DEFAULT_INITIAL_CASH)
    bt.add_argument("--stop-loss", type=float, default=None)
    bt.add_argument("--commission", type=float, default=config.DEFAULT_COMMISSION_RATE)
    bt.add_argument("--min-commission", type=float, default=config.DEFAULT_MIN_COMMISSION)
    bt.add_argument("--params", default="")
    bt.add_argument("--start", default="")
    bt.add_argument("--end", default="")
    bt.add_argument("--force", action="store_true")
    bt.add_argument("--out", default="")
    bt.set_defaults(func=_cmd_backtest)

    cl = sub.add_parser("chanlun", help="打印缠论结构摘要")
    cl.add_argument("--symbol", required=True)
    cl.add_argument("--period", default="1d", choices=["1d", "1w"])
    cl.add_argument("--adjust", default="forward")
    cl.add_argument("--force", action="store_true")
    cl.set_defaults(func=_cmd_chanlun)

    st = sub.add_parser("strategies", help="列出策略")
    st.set_defaults(func=_cmd_strategies)

    pl = sub.add_parser("pool", help="选股池等权回测")
    pl.add_argument("--strategy", required=True)
    pl.add_argument("--indexes", default="hs300")
    pl.add_argument("--custom", default="")
    pl.add_argument("--cash", type=float, default=config.DEFAULT_INITIAL_CASH)
    pl.set_defaults(func=_cmd_pool)

    return parser


def main(argv: List[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "command", None):
        args = parser.parse_args(["serve"])
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
