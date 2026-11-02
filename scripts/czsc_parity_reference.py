#!/usr/bin/env python3
"""czsc 权威参考输出生成器（仅用于一致性核验，不参与生产计算）。

用途
----
读取 `.cache/klines/<symbol>_1d_forward.json` 中的原始 K 线，调用 PyPI 上的
czsc 原生实现（`czsc._native.CZSC`）计算：

  1. 笔（`CZSC.bi_list`）：sdt/edt/direction/high/low/length/power_*/
     以及起止分型的原始 K 线下标；
  2. 中枢（`get_zs_seq`）：全部序列 + 与 TS 同口径过滤后的中枢；
  3. cxt 买卖点信号：逐根 K 线增量 replay，记录每个信号第一次触发的
     笔下标（与 TS `BSPoint.strokeIndex` 对齐）；
  4. 教科书“特征序列分型法”线段（简化口径，不含缺口二次确认），
     作为 TS 线段实现的独立对照。

注意：`max_bi_num` 必须显式传大值，否则 czsc 默认 50 会截断历史并产生假差异。

用法
----
  .cache/parity-venv/bin/python scripts/czsc_parity_reference.py \
      --out reports/czsc-parity-reference.json
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

DEFAULT_SYMBOLS = ["000001.SZ", "600519.SH"]

# czsc 信号名 -> {v1 取值: 归一化类型}
SIGNAL_SPECS = [
    ("cxt_first_buy_V221126", {"一买": "B1"}),
    ("cxt_first_sell_V221126", {"一卖": "S1"}),
    ("cxt_second_bs_V230320", {"二买": "B2", "二卖": "S2"}),
    ("cxt_third_bs_V230318", {"三买": "B3", "三卖": "S3"}),
    # 仅作口径参考：V230319（结构判定 + 均线形态）与 V230228（多窗口三买）
    ("cxt_third_bs_V230319", {"三买": "B3@V230319", "三卖": "S3@V230319"}),
    ("cxt_third_buy_V230228", {"三买": "B3@V230228"}),
]


def fail(msg: str) -> None:
    print(msg, file=sys.stderr)
    raise SystemExit(1)


try:
    import czsc
    from czsc._native import CZSC, Freq, RawBar, get_zs_seq, resample_bars, signals
except ImportError as exc:  # pragma: no cover - 环境缺失时给出可执行提示
    fail(
        "无法导入 czsc。请先执行：\n"
        "  uv venv --python 3.11 .cache/parity-venv\n"
        "  uv pip install --python .cache/parity-venv/bin/python "
        "-i https://pypi.tuna.tsinghua.edu.cn/simple czsc==1.0.2\n"
        f"原始错误：{exc}"
    )


def fmt_dt(dt) -> str:
    return dt.strftime("%Y-%m-%d")


def norm_direction(direction) -> str:
    text = str(direction)
    if text in ("向上", "up"):
        return "up"
    if text in ("向下", "down"):
        return "down"
    raise ValueError(f"未知笔方向：{text}")


def norm_mark(mark) -> str:
    text = str(mark)
    if text in ("顶分型", "G"):
        return "G"
    if text in ("底分型", "D"):
        return "D"
    raise ValueError(f"未知分型标记：{text}")


def fx_raw_index(fx) -> int:
    """起止分型的原始 K 线下标。

    czsc 的 `NewBar.id` 是合并 K 线首个原始 K 线的 id，并不等于分型所在
    原始 K 线的下标；分型日期 `fx.dt` 对应的那根原始 K 线才是 TS
    `Fraction.originalIndex` 的口径，因此这里按 dt 匹配，并在候选里优先选择
    与分型极值一致的那一根。
    """
    mark = norm_mark(fx.mark)
    candidates = [rb for rb in fx.raw_bars if rb.dt == fx.dt]
    if not candidates:
        return int(fx.elements[1].id)
    if len(candidates) > 1:
        key = (lambda rb: rb.high) if mark == "G" else (lambda rb: rb.low)
        best = max(candidates, key=key) if mark == "G" else min(candidates, key=key)
        if (mark == "G" and best.high == fx.fx) or (mark == "D" and best.low == fx.fx):
            return int(best.id)
    return int(candidates[0].id)


def export_bi(bi) -> dict:
    return {
        "sdt": fmt_dt(bi.sdt),
        "edt": fmt_dt(bi.edt),
        "direction": norm_direction(bi.direction),
        "high": float(bi.high),
        "low": float(bi.low),
        "length": int(bi.length),
        "powerPrice": float(bi.power_price),
        "powerVolume": float(bi.power_volume),
        "fxA": {
            "mark": norm_mark(bi.fx_a.mark),
            "dt": fmt_dt(bi.fx_a.dt),
            "fx": float(bi.fx_a.fx),
            "high": float(bi.fx_a.high),
            "low": float(bi.fx_a.low),
            "rawIndex": fx_raw_index(bi.fx_a),
        },
        "fxB": {
            "mark": norm_mark(bi.fx_b.mark),
            "dt": fmt_dt(bi.fx_b.dt),
            "fx": float(bi.fx_b.fx),
            "high": float(bi.fx_b.high),
            "low": float(bi.fx_b.low),
            "rawIndex": fx_raw_index(bi.fx_b),
        },
    }


def bi_key(bi) -> tuple:
    return (bi.sdt, bi.edt, str(bi.direction), bi.fx_a.dt, bi.fx_b.dt)


def export_zs(zs, bi_index: dict) -> dict:
    first = bi_index[bi_key(zs.bis[0])]
    last = bi_index[bi_key(zs.bis[-1])]
    return {
        "startBi": first,
        "endBi": last,
        "bisCount": len(zs.bis),
        "sdt": fmt_dt(zs.sdt),
        "edt": fmt_dt(zs.edt),
        "zg": float(zs.zg),
        "zd": float(zs.zd),
        "gg": float(zs.gg),
        "dd": float(zs.dd),
        "valid": bool(zs.is_valid()),
    }


def textbook_segments(bis: list) -> list:
    """教科书"特征序列分型法"线段划分（简化口径）。

    与完整教科书规则的差异：本实现不做"缺口情形下的二次确认"，只按特征序列
    去包含后的分型确认线段终点。因此它是"教科书口径的近似基线"，用于量化
    TS 实现的偏离程度，而不是判定教科书正确性的权威实现。
    """
    n = len(bis)
    if n < 3:
        return []

    def bar(i: int) -> dict:
        return {"bi": i, "high": float(bis[i].high), "low": float(bis[i].low)}

    segments = []
    start = 0
    guard = 0
    while start <= n - 3 and guard <= n + 5:
        guard += 1
        direction = norm_direction(bis[start].direction)
        feats: list[dict] = []  # 特征序列：交替方向笔的 high/low
        end = None

        j = 0
        while True:
            bi_idx = start + 2 * j + 1
            if bi_idx >= n:
                break
            if norm_direction(bis[bi_idx].direction) == direction:
                break
            cur = bar(bi_idx)
            if feats:
                prev = feats[-1]
                has_include = (prev["high"] <= cur["high"] and prev["low"] >= cur["low"]) or (
                    prev["high"] >= cur["high"] and prev["low"] <= cur["low"]
                )
                if has_include:
                    if direction == "up":
                        high = max(prev["high"], cur["high"])
                        low = max(prev["low"], cur["low"])
                        keep = prev["bi"] if prev["high"] > cur["high"] else cur["bi"]
                    else:
                        high = min(prev["high"], cur["high"])
                        low = min(prev["low"], cur["low"])
                        keep = prev["bi"] if prev["low"] < cur["low"] else cur["bi"]
                    feats[-1] = {"bi": keep, "high": high, "low": low}
                else:
                    feats.append(cur)
            else:
                feats.append(cur)

            if len(feats) >= 3:
                a, b, c = feats[-3], feats[-2], feats[-1]
                if direction == "up" and b["high"] > a["high"] and b["high"] > c["high"] \
                        and b["low"] > a["low"] and b["low"] > c["low"]:
                    end = b["bi"] - 1
                    break
                if direction == "down" and b["high"] < a["high"] and b["high"] < c["high"] \
                        and b["low"] < a["low"] and b["low"] < c["low"]:
                    end = b["bi"] - 1
                    break
            j += 1

        if end is None:
            end = n - 1
        if end <= start:
            break
        segments.append(
            {
                "startBi": start,
                "endBi": end,
                "direction": direction,
                "startDate": fmt_dt(bis[start].sdt),
                "endDate": fmt_dt(bis[end].edt),
            }
        )
        # 下一段与上一段共享价格端点：上一段以第 end 笔结束，下一段从第 end+1 笔开始。
        start = end + 1

    return segments


def replay_signals(bars: list, max_bi_num: int, min_bi_len: int) -> tuple:
    """逐根 K 线增量 replay，记录每个信号首次触发时的笔下标。

    信号只依赖 `bi_list`（B3 的均线取自分型对应原始 K 线，不受后续 K 线影响），
    因此仅在 `bi_list` 状态变化时求值即可，避免重复计算。
    """
    if len(bars) < 3:
        return [], {}

    c = CZSC(bars[:2], max_bi_num=max_bi_num, min_bi_len=min_bi_len)
    events: dict[str, list] = {}
    states = []
    prev_key = None

    for i in range(2, len(bars)):
        c.update(bars[i])
        if not c.bi_list:
            continue
        last = c.bi_list[-1]
        key = (len(c.bi_list), last.sdt, last.edt)
        if key == prev_key:
            continue
        prev_key = key
        stroke_index = len(c.bi_list) - 1
        states.append(
            {
                "barIndex": i,
                "barDate": fmt_dt(bars[i].dt),
                "biCount": len(c.bi_list),
                "lastBiEdt": fmt_dt(last.edt),
            }
        )
        for name, mapping in SIGNAL_SPECS:
            try:
                sigs = signals.call_signal(name, c)
            except Exception as exc:  # 单个信号失败不影响其它构件核验
                events.setdefault("errors", []).append({"signal": name, "bar": i, "error": str(exc)})
                continue
            for sig in sigs:
                point_type = mapping.get(str(sig.v1))
                if not point_type:
                    continue
                bucket = events.setdefault(point_type, [])
                if any(x["strokeIndex"] == stroke_index for x in bucket):
                    continue
                bucket.append(
                    {
                        "type": point_type,
                        "signal": name,
                        "strokeIndex": stroke_index,
                        "strokeEdt": fmt_dt(last.edt),
                        "barIndex": i,
                        "barDate": fmt_dt(bars[i].dt),
                        "v1": str(sig.v1),
                        "v2": str(sig.v2),
                    }
                )
    return states, events


def load_klines(path: Path) -> list:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload["klines"]


def build_bars(symbol: str, klines: list, freq=Freq.D) -> list:
    bars = []
    for i, k in enumerate(klines):
        bars.append(
            RawBar(
                symbol,
                datetime.fromisoformat(k["date"]),
                freq,
                float(k["open"]),
                float(k["close"]),
                float(k["high"]),
                float(k["low"]),
                float(k.get("volume") or 0.0),
                float(k.get("amount") or 0.0),
                i,
            )
        )
    return bars


def export_freq(
    symbol: str,
    bars: list,
    args,
    extra: dict | None = None,
) -> dict:
    """对同一批 bars 输出笔/中枢/信号/教科书线段。"""
    c = CZSC(bars, max_bi_num=args.max_bi_num, min_bi_len=args.min_bi_len)
    c_default = CZSC(bars, min_bi_len=args.min_bi_len)

    bi_list = [export_bi(bi) for bi in c.bi_list]
    bi_index = {bi_key(bi): i for i, bi in enumerate(c.bi_list)}
    zs_all = [export_zs(zs, bi_index) for zs in get_zs_seq(c.bi_list)]
    zs_hubs = [z for z in zs_all if z["bisCount"] >= 3 and z["zg"] > z["zd"] and z["valid"]]
    states, events = replay_signals(bars, args.max_bi_num, args.min_bi_len)

    payload = {
        **(extra or {}),
        "barCount": len(bars),
        "biCount": len(bi_list),
        "defaultMaxBiNum": {
            "maxBiNum": 50,
            "biCount": len(c_default.bi_list),
            "barsRawCount": len(c_default.bars_raw),
            "firstBiSdt": fmt_dt(c_default.bi_list[0].sdt) if c_default.bi_list else None,
        },
        "untruncatedBarsRawCount": len(c.bars_raw),
        "biList": bi_list,
        "zsAll": zs_all,
        "zsHubs": zs_hubs,
        "signalStates": states,
        "signalEvents": events,
        "segmentsTextbook": textbook_segments(c.bi_list),
    }
    return payload


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbols", nargs="*", default=DEFAULT_SYMBOLS)
    parser.add_argument("--kline-dir", default=str(ROOT / ".cache/klines"))
    parser.add_argument("--out", default=str(ROOT / "reports/czsc-parity-reference.json"))
    parser.add_argument("--max-bi-num", type=int, default=100000)
    parser.add_argument("--min-bi-len", type=int, default=6)
    args = parser.parse_args()

    result = {
        "engine": {
            "reference": "czsc (PyPI native wheel)",
            "version": getattr(czsc, "__version__", "unknown"),
            "module": getattr(czsc, "__file__", "unknown"),
            "maxBiNum": args.max_bi_num,
            "minBiLen": args.min_bi_len,
            "signals": [name for name, _ in SIGNAL_SPECS],
            "generatedAt": datetime.now().isoformat(timespec="seconds"),
        },
        "symbols": {},
    }

    for symbol in args.symbols:
        path = Path(args.kline_dir) / f"{symbol}_1d_forward.json"
        if not path.exists():
            result["symbols"][symbol] = {"error": f"缺少数据文件：{path}"}
            continue

        klines = load_klines(path)
        bars = build_bars(symbol, klines)
        daily = export_freq(symbol, bars, args, {"klineCount": len(klines)})

        # 周线：完全走 czsc 自身的 resample 规则（周桶取周五，drop_unfinished=True）
        weekly_bars = resample_bars(bars, Freq.W, True)
        weekly_bars_keep_unfinished = resample_bars(bars, Freq.W, False)
        weekly = export_freq(
            symbol,
            weekly_bars,
            args,
            {
                "sourceDailyCount": len(klines),
                "klineCount": len(weekly_bars),
                "firstBarDate": fmt_dt(weekly_bars[0].dt) if weekly_bars else None,
                "lastBarDate": fmt_dt(weekly_bars[-1].dt) if weekly_bars else None,
                "lastDailyDate": fmt_dt(bars[-1].dt) if bars else None,
                "droppedIncompleteWeek": len(weekly_bars_keep_unfinished) != len(weekly_bars),
            },
        )

        # 未完成周边界核验：截掉最后一根日线后，czsc 应丢弃该周
        truncated_bars = bars[:-1]
        keep_unfinished = resample_bars(truncated_bars, Freq.W, False)
        drop_unfinished = resample_bars(truncated_bars, Freq.W, True)
        boundary = {
            "truncatedDailyCount": len(truncated_bars),
            "truncatedLastDailyDate": fmt_dt(truncated_bars[-1].dt) if truncated_bars else None,
            "weeklyCountKeepUnfinished": len(keep_unfinished),
            "weeklyCountDropUnfinished": len(drop_unfinished),
            "lastWeeklyDateKeepUnfinished": (
                fmt_dt(keep_unfinished[-1].dt) if keep_unfinished else None
            ),
            "lastWeeklyDateDropUnfinished": (
                fmt_dt(drop_unfinished[-1].dt) if drop_unfinished else None
            ),
        }
        weekly["boundaryCheck"] = boundary

        result["symbols"][symbol] = {"1d": daily, "1w": weekly}
        for freq_key, payload in (("1d", daily), ("1w", weekly)):
            print(
                f"{symbol} [{freq_key}]: bars={payload['klineCount']} bi={payload['biCount']} "
                f"zs_all={len(payload['zsAll'])} zs_hubs={len(payload['zsHubs'])} "
                f"segments(textbook)={len(payload['segmentsTextbook'])}"
            )
            for point_type in ("B1", "S1", "B2", "S2", "B3", "S3"):
                dates = [e["strokeEdt"] for e in payload["signalEvents"].get(point_type, [])]
                print(f"  {point_type}: {len(dates)} {dates}")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n已写入 {out}")


if __name__ == "__main__":
    main()
