#!/usr/bin/env python3
"""股票池共享资金逐日组合模拟 (backtrader 执行层)。

信号由 TypeScript 策略引擎按「只用截至当根的数据」预先生成;
本脚本只负责组合层逐日撮合, 不使用任何未来数据:
  - 共享现金, 多标的同时持仓, 仓位上限 / 单只仓位比例
  - 信号当日收盘价成交 (cerebro.broker.set_coc(True))
  - A 股费用: 佣金 + 最低佣金 + 印花税(卖出) + 过户费
  - T+1: 当日买入的股份当日不可卖
  - 收盘价涨跌停拦截 (按标的涨跌幅限制)
  - 可选固定止损: 买入次日挂 Stop 单, 按盘中触发价成交
  - 基准: 默认沪深300全收益 (H00300), 可切换沪深300 / 池内等权买入持有
  - 组合权益曲线

用法:
  python runner.py --bundle <bundle_dir> --out <result.json>
进度通过 stdout 的 JSON 行输出, 供 Node 服务端读取。
"""

from __future__ import annotations

import argparse
import bisect
import csv
import datetime as dt
import json
import math
import os
import sys
import time
from collections import defaultdict
from datetime import timedelta

try:
    import backtrader as bt
except Exception as exc:  # pragma: no cover - 环境缺失时给出可读错误
    print(json.dumps({"type": "error", "message": f"backtrader 未安装: {exc}"}, ensure_ascii=False), flush=True)
    sys.exit(3)


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------

def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def read_json(path: str) -> dict:
    with open(path, 'r', encoding='utf-8') as fh:
        return json.load(fh)


def load_calendar(bundle: str) -> list[str]:
    path = os.path.join(bundle, 'calendar.csv')
    dates: list[str] = []
    with open(path, 'r', encoding='utf-8') as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            dates.append(row['date'])
    return dates


def append_line(path: str, line: str) -> None:
    with open(path, 'rb') as fh:
        fh.seek(0, os.SEEK_END)
        if fh.tell() > 0:
            fh.seek(-1, os.SEEK_END)
            tail = fh.read(1)
        else:
            tail = b'\n'
    with open(path, 'a', encoding='utf-8') as fh:
        if tail not in (b'\n', b'\r'):
            fh.write('\n')
        fh.write(line + '\n')


def append_finalization_bar(bundle: str, symbols: list[dict]) -> str | None:
    """追加一根「收盘后结算」的哨兵 K 线。

    backtrader 在下一根 bar 开始时才处理上一根提交的市价单, 因此区间最后一日的
    委托若没有后续 bar 就永远不会成交。这里给日历与每个标的补一根平价 bar:
      - 只用于撮合最后一日的委托;
      - 不参与信号、权益曲线与基准计算。
    """
    cal_path = os.path.join(bundle, 'calendar.csv')
    with open(cal_path, 'r', encoding='utf-8') as fh:
        rows = list(csv.DictReader(fh))
    if not rows:
        return None
    last_date = rows[-1]['date']
    sentinel = (dt.date.fromisoformat(last_date) + timedelta(days=1)).isoformat()

    append_line(cal_path, f'{sentinel},1,1,1,1,0')

    for s in symbols:
        path = os.path.join(bundle, s['file'])
        if not os.path.exists(path):
            continue
        with open(path, 'r', encoding='utf-8') as fh:
            lines = [ln for ln in fh.read().splitlines() if ln.strip()]
        if len(lines) < 2:
            continue
        header, body = lines[0], lines[1:]
        last = body[-1].split(',')
        if len(last) < 6 or last[0] >= sentinel:
            continue
        close = last[4]
        append_line(path, f'{sentinel},{close},{close},{close},{close},0')
    return sentinel


def load_bars(path: str) -> dict[str, float]:
    """date -> close, 用于基准与持仓估值。"""
    out: dict[str, float] = {}
    with open(path, 'r', encoding='utf-8') as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            try:
                out[row['date']] = float(row['close'])
            except (KeyError, TypeError, ValueError):
                continue
    return out


def build_index_benchmark(series: list[dict], dates: list[str], initial_cash: float) -> dict[str, float]:
    """用市场指数序列 (默认沪深300全收益 H00300) 构造基准净值曲线。

    指数序列按日期前向填充; 起始日早于序列起点时退化为序列首个可用点位。
    """
    if not dates or initial_cash <= 0 or not series:
        return {}
    pts = sorted(
        ((str(p.get('date')), float(p.get('value', 0))) for p in series if p.get('date')),
        key=lambda x: x[0],
    )
    if not pts:
        return {}

    keys = [d for d, _ in pts]
    idx = bisect.bisect_right(keys, dates[0]) - 1
    if idx < 0:
        idx = 0
    base = pts[idx][1]
    if base <= 0:
        return {}

    out: dict[str, float] = {}
    j = idx
    for date in dates:
        while j + 1 < len(pts) and pts[j + 1][0] <= date:
            j += 1
        out[date] = initial_cash * pts[j][1] / base
    return out


def build_benchmark(bundle: str, symbols: list[dict], dates: list[str], initial_cash: float) -> dict[str, float]:
    """等权买入持有: 首个交易日等权买入所有当日有行情的标的, 之后持有。"""
    if not dates or initial_cash <= 0:
        return {}
    closes = {s['symbol']: load_bars(os.path.join(bundle, s['file'])) for s in symbols}
    first = dates[0]
    picked = [s['symbol'] for s in symbols if closes.get(s['symbol'], {}).get(first, 0) > 0]
    if not picked:
        return {d: initial_cash for d in dates}

    budget = initial_cash / len(picked)
    shares = {sym: budget / closes[sym][first] for sym in picked}
    last = {sym: closes[sym][first] for sym in picked}

    out: dict[str, float] = {}
    for date in dates:
        total = 0.0
        for sym in picked:
            price = closes[sym].get(date)
            if price and price > 0:
                last[sym] = price
            total += shares[sym] * last[sym]
        out[date] = total
    return out


# ---------------------------------------------------------------------------
# A 股费用
# ---------------------------------------------------------------------------

class AShareCommission(bt.CommInfoBase):
    """佣金 (含最低) + 印花税 (仅卖出) + 过户费。"""

    params = (
        ('commission', 0.00025),
        ('mincommission', 5.0),
        ('stamp', 0.001),
        ('transfer', 0.00001),
        ('stocklike', True),
        ('commtype', bt.CommInfoBase.COMM_PERC),
        ('percabs', True),
    )

    def _getcommission(self, size, price, pseudoexec):
        value = abs(size) * price
        if value <= 0:
            return 0.0
        commission = max(value * self.p.commission, self.p.mincommission)
        stamp = value * self.p.stamp if size < 0 else 0.0
        return commission + stamp + value * self.p.transfer


# ---------------------------------------------------------------------------
# 组合策略
# ---------------------------------------------------------------------------

class PortfolioStrategy(bt.Strategy):
    params = (
        ('signals', None),
        ('scores', None),
        ('config', None),
        ('symbol_info', None),
        ('progress_total', 0),
        ('sentinel', None),
    )

    def __init__(self):
        self.cfg = self.p.config
        self.info = self.p.symbol_info
        self.signals = self.p.signals or {}
        # bundle 内按 symbol -> {date: signal} 存储, 逐日撮合时转成 date -> {symbol: signal}
        self.by_date: dict[str, dict[str, dict]] = defaultdict(dict)
        for sym, days in self.signals.items():
            for day, sig in (days or {}).items():
                self.by_date[day][sym] = sig
        # 逐日吸引力分数 (含 HOLD 日), 轮动时比较「候选 vs 持仓」
        self.score_dates: dict[str, list[str]] = {}
        self.score_values: dict[str, list[float]] = {}
        for sym, days in (self.p.scores or {}).items():
            items = sorted((str(d), float(v)) for d, v in (days or {}).items())
            self.score_dates[sym] = [d for d, _ in items]
            self.score_values[sym] = [v for _, v in items]
        self.progress_total = int(self.p.progress_total or 0)
        self.calendar = self.datas[0]
        self.feeds = {d._name: d for d in self.datas[1:]}

        self.last_close: dict[str, float] = {}
        self.equity_points: list[dict] = []

        self.positions_meta: dict[str, dict] = {}
        self.stop_orders: dict[str, object] = {}
        self.pending_buys: dict[str, dict] = {}
        self.pending_sells: dict[str, dict] = {}
        # 当日已提交但尚未被 broker 处理的市价单 (收盘价成交), 仅用于当日权益快照
        self.today_buys: dict[str, dict] = {}
        self.today_sells: dict[str, dict] = {}

        self.fills: list[dict] = []
        self.signal_log: list[dict] = []
        self.total_fees = 0.0
        self.exposure_sum = 0.0
        self.equity_days = 0
        self.positions_sum = 0

        self.symbol_stats: dict[str, dict] = defaultdict(lambda: {
            'buys': 0, 'sells': 0, 'closed': 0, 'wins': 0,
            'realized_pnl': 0.0, 'entry_value': 0.0, 'fees': 0.0,
        })
        self.failures: list[dict] = []
        self.progress_counter = 0

    # ------------------------------------------------------------------
    # 逐日主循环
    # ------------------------------------------------------------------

    def prenext(self):
        self._on_bar()

    def next(self):
        self._on_bar()

    def _on_bar(self):
        date = self.calendar.datetime.date(0).isoformat()
        if self.p.sentinel and date >= self.p.sentinel:
            # 哨兵日: 仅让 broker 结算上一交易日提交的委托, 不产生信号与权益点
            return
        self.today_buys.clear()
        self.today_sells.clear()

        # 1) 更新今日收盘价 (停牌标的沿用最近一次收盘)
        for sym, feed in self.feeds.items():
            if len(feed) == 0:
                continue
            if feed.datetime.date(0).isoformat() == date:
                self.last_close[sym] = float(feed.close[0])

        # 3) 当日信号 → 组合层撮合
        day_signals = self.by_date.get(date) or {}
        candidates: list[tuple[str, dict, dict]] = []
        for sym, sig in day_signals.items():
            feed = self.feeds.get(sym)
            if feed is None:
                self._log_signal(date, sym, sig, 'skipped', '标的未参与本次模拟')
                continue
            if len(feed) == 0 or feed.datetime.date(0).isoformat() != date:
                self._log_signal(date, sym, sig, 'skipped', '当日无行情 (停牌/未上市)')
                continue

            action = sig.get('action')
            close = float(feed.close[0])
            if action == 'BUY':
                rec = self._log_signal(date, sym, sig, 'skipped', '', price=close)
                if self._limit_hit(feed, sym, up=True):
                    rec['skipReason'] = '涨停无法买入'
                    continue
                if self.getposition(feed).size > 0 or sym in self.pending_buys:
                    rec['skipReason'] = '已持仓'
                    continue
                candidates.append((sym, rec, sig))
            elif action == 'SELL':
                rec = self._log_signal(date, sym, sig, 'skipped', '', price=close)
                if self._limit_hit(feed, sym, up=False):
                    rec['skipReason'] = '跌停无法卖出'
                    continue
                pos = self.getposition(feed)
                if pos.size <= 0:
                    rec['skipReason'] = '未持仓'
                    continue
                meta = self.positions_meta.get(sym)
                if meta and meta['entry_date'] == date:
                    rec['skipReason'] = 'T+1 当日买入不可卖'
                    continue
                self._cancel_stop(sym)
                order = self.sell(data=feed, size=pos.size)
                self.pending_sells[sym] = rec
                self.today_sells[sym] = {
                    'shares': abs(pos.size),
                    'price': close,
                    'fee': self._estimate_fee(abs(pos.size) * close, is_buy=False),
                }
            else:
                # HOLD 不入账本, 只保留可执行的 BUY/SELL
                continue

        # 4) 先按置信度排序, 再按现金/仓位上限分配
        self._execute_buys(date, candidates)

        # 5) 当日收盘权益: broker 已处理今日开盘前的历史挂单; 今日市价单在
        #    set_coc 下按今日收盘价成交, 但要到下一根才会进入 broker 账户, 这里手工折算。
        self._record_equity(date)

        self.progress_counter += 1
        if self.progress_counter % 20 == 0:
            emit({
                'type': 'progress', 'phase': 'simulating',
                'day': self.progress_counter, 'total': self.progress_total,
                'date': date, 'message': f'backtrader 逐日撮合 {date}',
            })

    def _execute_buys(self, date: str, candidates: list[tuple[str, dict, dict]]):
        if not candidates:
            return

        cfg = self.cfg
        max_positions = int(cfg.get('maxPositions', 10))
        position_pct = float(cfg.get('positionPercent', 10)) / 100.0

        held = sum(1 for feed in self.feeds.values()
                   if len(feed) > 0 and self.getposition(feed).size > 0)
        slots = max_positions - held - len(self.pending_buys)

        # 轮动: 仓位已满时, 用更强候选替换最弱持仓 (卖单先提交, 买单一根后结算时现金已到账)
        if slots <= 0 and bool(cfg.get('rotationEnabled')) and self.score_values:
            slots += self._try_rotate(date, candidates)

        if slots <= 0:
            for _sym, rec, _sig in candidates:
                rec['skipReason'] = '持仓已满'
            return

        equity = float(self.broker.getvalue())
        cash = float(self.broker.getcash())
        # 轮动换仓的卖单与买单同在今日收盘成交, 卖款先到账; 仅在轮动模式下把当日卖款计入预算,
        # 保持非轮动口径与此前完全一致。
        if cfg.get('rotationEnabled'):
            for o in self.today_sells.values():
                cash += o['shares'] * o['price'] - o['fee']
        candidates.sort(key=lambda item: (-self._candidate_score(item[0], item[2], date), item[0]))

        for sym, rec, sig in candidates:
            if slots <= 0:
                rec['skipReason'] = '持仓已满'
                continue
            feed = self.feeds[sym]
            price = float(feed.close[0])
            if price <= 0:
                rec['skipReason'] = '价格无效'
                continue

            budget = min(equity * position_pct, cash * 0.995)
            size = int(budget / price / 100) * 100
            while size >= 100:
                cost = size * price
                fee = self._estimate_fee(cost, is_buy=True)
                if cost + fee <= cash:
                    break
                size -= 100
            if size < 100:
                rec['skipReason'] = '可用资金不足 (不足一手)'
                continue

            cost = size * price
            fee = self._estimate_fee(cost, is_buy=True)
            self.buy(data=feed, size=size)
            cash -= cost + fee
            slots -= 1
            self.pending_buys[sym] = rec
            self.today_buys[sym] = {'shares': size, 'price': price, 'fee': fee}

            # 保护性止损: 本根提交, broker 在下一根开盘前用下一根的行情判定,
            # 因此天然满足 T+1; 若买单被拒, notify_order 会撤掉该止损。
            stop_pct = self.cfg.get('stopLossPercent')
            if stop_pct:
                self._place_stop(sym, feed, price, size, float(stop_pct))

    def _score_on(self, sym: str, date: str) -> float | None:
        """取该标的在 date 当日 (或最近一次) 的吸引力分数, 用于横截面比较。"""
        keys = self.score_dates.get(sym)
        if not keys:
            return None
        idx = bisect.bisect_right(keys, date) - 1
        if idx < 0:
            return None
        return self.score_values[sym][idx]

    def _candidate_score(self, sym: str, sig: dict, date: str) -> float:
        score = self._score_on(sym, date)
        if score is not None:
            return score
        return float(sig.get('confidence') or 0.0)

    def _try_rotate(self, date: str, candidates: list[tuple[str, dict, dict]]) -> int:
        """卖出分数最低的持仓, 为更高分的候选腾出名额; 返回释放的名额数。

        约束: T+1 (当日买入不可卖)、停牌无行情、已挂卖单的标的不重复卖。
        卖出与买入在同一根提交, backtrader 按提交顺序结算: 卖款先到账, 随后买单扣款。
        """
        delta = float(self.cfg.get('rotationMinScoreDelta', 1.0))
        max_per_day = int(self.cfg.get('rotationMaxPerDay', 2))

        sellable: list[tuple[float, str]] = []
        for sym, feed in self.feeds.items():
            if len(feed) == 0:
                continue
            if self.getposition(feed).size <= 0:
                continue
            if sym in self.pending_sells:
                continue
            meta = self.positions_meta.get(sym)
            if meta and meta['entry_date'] == date:
                continue  # T+1
            score = self._score_on(sym, date)
            if score is None:
                continue
            sellable.append((score, sym))
        if not sellable:
            return 0
        sellable.sort()

        freed = 0
        for sym, rec, sig in sorted(candidates, key=lambda it: -self._candidate_score(it[0], it[2], date)):
            if freed >= max_per_day:
                break
            if self.getposition(self.feeds[sym]).size > 0:
                continue
            cand_score = self._candidate_score(sym, sig, date)
            picked = None
            for idx, (weak_score, weak_sym) in enumerate(sellable):
                if weak_sym == sym:
                    continue
                if cand_score - weak_score >= delta:
                    picked = idx
                    break
            if picked is None:
                continue
            weak_score, weak_sym = sellable.pop(picked)
            feed = self.feeds[weak_sym]
            pos = self.getposition(feed)
            close = float(feed.close[0])
            if self._limit_hit(feed, weak_sym, up=False):
                sellable.insert(picked, (weak_score, weak_sym))
                continue
            reason = f'轮动换仓: {weak_sym} 分数 {weak_score:.2f} < 候选 {cand_score:.2f}'
            log = self._log_signal(date, weak_sym, {'action': 'SELL', 'reason': reason},
                                   'skipped', '', price=close)
            self._cancel_stop(weak_sym)
            self.sell(data=feed, size=pos.size)
            self.pending_sells[weak_sym] = log
            self.today_sells[weak_sym] = {
                'shares': abs(pos.size),
                'price': close,
                'fee': self._estimate_fee(abs(pos.size) * close, is_buy=False),
            }
            freed += 1
        return freed

    # ------------------------------------------------------------------
    # 成交回报
    # ------------------------------------------------------------------

    def notify_order(self, order):
        if order.status in (order.Submitted, order.Accepted):
            return

        sym = order.data._name
        if order.status == order.Completed:
            date = bt.num2date(order.executed.dt).date().isoformat()
            price = float(order.executed.price)
            size = int(order.executed.size)
            fee = float(order.executed.comm)
            self.total_fees += fee

            if size > 0:
                rec = self.pending_buys.pop(sym, None)
                self.positions_meta[sym] = {
                    'entry_date': date,
                    'entry_price': price,
                    'shares': abs(size),
                    'entry_fee': fee,
                    'reason': (rec or {}).get('reason') or '买入',
                }
                stats = self.symbol_stats[sym]
                stats['buys'] += 1
                stats['entry_value'] += abs(size) * price
                stats['fees'] += fee

                self.fills.append({
                    'date': date, 'symbol': sym, 'side': 'BUY', 'price': price,
                    'shares': abs(size), 'value': abs(size) * price, 'fee': fee,
                    'reason': (rec or {}).get('reason') or '买入',
                })
                if rec is not None:
                    rec['status'] = 'filled'
                    rec['skipReason'] = ''
                    rec['shares'] = abs(size)
                    rec['fee'] = fee

            else:
                rec = self.pending_sells.pop(sym, None)
                meta = self.positions_meta.pop(sym, None)
                is_stop = order.exectype in (bt.Order.Stop, bt.Order.StopLimit)

                pnl = None
                pnl_pct = None
                hold_days = None
                if meta:
                    shares = abs(size)
                    pnl = (price - meta['entry_price']) * shares - meta['entry_fee'] - fee
                    base = meta['entry_price'] * shares
                    pnl_pct = (pnl / base * 100.0) if base > 0 else 0.0
                    try:
                        entry_day = dt.date.fromisoformat(meta['entry_date'])
                        exit_day = dt.date.fromisoformat(date)
                        hold_days = max(0, (exit_day - entry_day).days)
                    except Exception:
                        hold_days = None

                    stats = self.symbol_stats[sym]
                    stats['sells'] += 1
                    stats['closed'] += 1
                    stats['fees'] += fee
                    stats['realized_pnl'] += pnl
                    if pnl > 0:
                        stats['wins'] += 1

                    reason = '触发止损' if is_stop else ((rec or {}).get('reason') or '卖出')
                    self.fills.append({
                        'date': date, 'symbol': sym, 'side': 'SELL', 'price': price,
                        'shares': shares, 'value': shares * price, 'fee': fee,
                        'reason': reason, 'pnl': pnl, 'pnlPercent': pnl_pct,
                        'holdDays': hold_days, 'entryDate': meta['entry_date'],
                    })

                if is_stop:
                    stop_rec = self._log_signal(date, sym, {'action': 'SELL', 'reason': '触发止损'}, 'filled', '', price=price)
                    stop_rec['shares'] = abs(size)
                    stop_rec['fee'] = fee
                    stop_rec['pnl'] = pnl
                    self.stop_orders.pop(sym, None)
                elif rec is not None:
                    rec['status'] = 'filled'
                    rec['skipReason'] = ''
                    rec['shares'] = abs(size)
                    rec['fee'] = fee
                    rec['pnl'] = pnl
                    # 若该卖单来自信号, 顺手撤掉仍在挂的止损
                    self._cancel_stop(sym)
                else:
                    self._log_signal(date, sym, {'action': 'SELL', 'reason': '卖出'}, 'filled', '', price=price)

        elif order.status in (order.Canceled, order.Margin, order.Rejected):
            is_stop = order.exectype in (bt.Order.Stop, bt.Order.StopLimit)
            if is_stop:
                if self.stop_orders.get(sym) is order:
                    self.stop_orders.pop(sym, None)
                return
            buy_rec = self.pending_buys.pop(sym, None)
            if buy_rec is not None:
                # 买单未成交, 撤掉随单提交的保护性止损, 避免裸卖
                self._cancel_stop(sym)
            rec = buy_rec or self.pending_sells.pop(sym, None)
            if rec is not None:
                rec['status'] = 'rejected'
                rec['skipReason'] = {
                    order.Canceled: '订单已撤销',
                    order.Margin: '保证金/资金不足',
                    order.Rejected: '订单被拒绝',
                }.get(order.status, '订单未成交')

    # ------------------------------------------------------------------
    # 权益结算 / 基准
    # ------------------------------------------------------------------

    def _record_equity(self, date: str):
        """按当日收盘价结算权益。

        broker 在此刻已处理完「今日开盘前」的挂单 (含昨日收盘价成交的市价单与今日触发的止损),
        但今日 `next()` 内新提交的市价单要到下一根才进入账户, 因此在快照中手工折算:
        买入扣现金/加持仓, 卖出加现金/减持仓 (费用与 broker 一致)。
        """
        cash = float(self.broker.getcash())
        for sym, o in self.today_buys.items():
            cash -= o['shares'] * o['price'] + o['fee']
        for sym, o in self.today_sells.items():
            cash += o['shares'] * o['price'] - o['fee']

        position_value = 0.0
        count = 0
        for sym, feed in self.feeds.items():
            if len(feed) == 0:
                continue
            size = int(self.getposition(feed).size)
            size += self.today_buys.get(sym, {}).get('shares', 0)
            size -= self.today_sells.get(sym, {}).get('shares', 0)
            if size <= 0:
                continue
            price = self.last_close.get(sym) or float(feed.close[0])
            position_value += size * price
            count += 1

        value = cash + position_value
        self.equity_points.append({
            'date': date,
            'value': value,
            'cash': cash,
            'positionValue': position_value,
            'positions': count,
        })
        self.exposure_sum += (position_value / value) if value > 0 else 0.0
        self.positions_sum += count
        self.equity_days += 1

    def stop(self):
        for sym, order in list(self.stop_orders.items()):
            if order is not None and order.alive():
                self.cancel(order)
            self.stop_orders.pop(sym, None)

    # ------------------------------------------------------------------
    # 辅助
    # ------------------------------------------------------------------

    def _log_signal(self, date: str, sym: str, sig: dict, status: str, reason: str, price: float | None = None) -> dict:
        rec = {
            'date': date,
            'symbol': sym,
            'action': sig.get('action'),
            'reason': sig.get('reason') or '',
            'confidence': sig.get('confidence'),
            'price': price if price is not None else float(sig.get('price') or 0),
            'status': status,
            'skipReason': reason,
        }
        self.signal_log.append(rec)
        return rec

    def _limit_hit(self, feed, sym: str, up: bool) -> bool:
        if len(feed) < 2:
            return False
        prev = float(feed.close[-1])
        if prev <= 0:
            return False
        pct = float((self.info.get(sym) or {}).get('limitPct', 0.1))
        close = float(feed.close[0])
        if up:
            return close >= prev * (1.0 + pct) - 1e-4
        return close <= prev * (1.0 - pct) + 1e-4

    def _estimate_fee(self, value: float, is_buy: bool) -> float:
        commission = max(value * float(self.cfg.get('commissionRate', 0.00025)),
                         float(self.cfg.get('minCommission', 5)))
        stamp = 0.0 if is_buy else value * float(self.cfg.get('stampDutyRate', 0.001))
        return commission + stamp + value * float(self.cfg.get('transferFeeRate', 0.00001))

    def _place_stop(self, sym: str, feed, entry_price: float, shares: int, pct: float):
        stop_price = round(entry_price * (1.0 - pct / 100.0), 2)
        if stop_price <= 0:
            return
        old = self.stop_orders.get(sym)
        if old is not None and old.alive():
            self.cancel(old)
        self.stop_orders[sym] = self.sell(
            data=feed, size=shares, exectype=bt.Order.Stop, price=stop_price,
        )

    def _cancel_stop(self, sym: str):
        order = self.stop_orders.get(sym)
        if order is not None and order.alive():
            self.cancel(order)
        self.stop_orders.pop(sym, None)

    def open_positions(self, final_equity: float) -> list[dict]:
        out: list[dict] = []
        for sym, meta in self.positions_meta.items():
            feed = self.feeds.get(sym)
            if feed is None or len(feed) == 0:
                continue
            size = int(self.getposition(feed).size)
            if size <= 0:
                continue
            price = float(self.last_close.get(sym) or feed.close[0])
            market_value = size * price
            pnl = (price - meta['entry_price']) * size - meta['entry_fee']
            base = meta['entry_price'] * size
            out.append({
                'symbol': sym,
                'shares': size,
                'avgCost': meta['entry_price'],
                'price': price,
                'marketValue': market_value,
                'weightPercent': (market_value / final_equity * 100.0) if final_equity > 0 else 0.0,
                'pnl': pnl,
                'pnlPercent': (pnl / base * 100.0) if base > 0 else 0.0,
                'entryDate': meta['entry_date'],
            })
        out.sort(key=lambda x: -x['marketValue'])
        return out


# ---------------------------------------------------------------------------
# 统计
# ---------------------------------------------------------------------------

def sharpe(values: list[float]) -> float:
    if len(values) < 3:
        return 0.0
    rets = []
    for i in range(1, len(values)):
        prev = values[i - 1]
        rets.append((values[i] - prev) / prev if prev > 0 else 0.0)
    if len(rets) < 2:
        return 0.0
    mean = sum(rets) / len(rets)
    var = sum((r - mean) ** 2 for r in rets) / len(rets)
    std = math.sqrt(var)
    return (mean / std) * math.sqrt(252) if std > 0 else 0.0


def max_drawdown(values: list[float]) -> float:
    peak = values[0] if values else 0.0
    worst = 0.0
    for v in values:
        if v > peak:
            peak = v
        elif peak > 0:
            worst = max(worst, (peak - v) / peak * 100.0)
    return worst


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--bundle', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()

    started = time.time()
    bundle = args.bundle
    cfg = read_json(os.path.join(bundle, 'config.json'))
    symbols = read_json(os.path.join(bundle, 'symbols.json'))
    signals = read_json(os.path.join(bundle, 'signals.json'))
    scores_path = os.path.join(bundle, 'scores.json')
    scores = read_json(scores_path) if os.path.exists(scores_path) else {}
    calendar = load_calendar(bundle)

    # 默认市场基准 (沪深300全收益/中证全债/PE/ERP 等) 由服务端预取, 缺失时回退池内等权
    baselines_path = os.path.join(bundle, 'baselines.json')
    baselines = read_json(baselines_path) if os.path.exists(baselines_path) else {}
    benchmark_id = baselines.get('benchmark') or 'hs300_tr'

    if not calendar:
        emit({'type': 'error', 'message': '交易日历为空'})
        return 2

    # 最后一根只用于撮合区间末日委托, 不参与信号/权益/基准
    sentinel = append_finalization_bar(bundle, symbols)
    real_days = len(calendar)

    symbol_info = {s['symbol']: s for s in symbols}
    initial_cash = float(cfg.get('initialCash', 100000))

    cerebro = bt.Cerebro(stdstats=False, runonce=False)
    cerebro.broker.setcash(initial_cash)
    # 信号当日收盘价成交
    cerebro.broker.set_coc(True)
    cerebro.broker.addcommissioninfo(AShareCommission(
        commission=float(cfg.get('commissionRate', 0.00025)),
        mincommission=float(cfg.get('minCommission', 5)),
        stamp=float(cfg.get('stampDutyRate', 0.001)),
        transfer=float(cfg.get('transferFeeRate', 0.00001)),
    ))

    def feed(path: str, name: str):
        return bt.feeds.GenericCSVData(
            dataname=path,
            dtformat='%Y-%m-%d',
            datetime=0, open=1, high=2, low=3, close=4, volume=5, openinterest=-1,
            timeframe=bt.TimeFrame.Days,
            name=name,
        )

    cerebro.adddata(feed(os.path.join(bundle, 'calendar.csv'), 'CALENDAR'))
    added = 0
    for s in symbols:
        path = os.path.join(bundle, s['file'])
        if not os.path.exists(path):
            continue
        cerebro.adddata(feed(path, s['symbol']))
        added += 1

    cerebro.addstrategy(PortfolioStrategy, signals=signals, scores=scores, config=cfg, symbol_info=symbol_info,
                        progress_total=real_days, sentinel=sentinel)
    emit({'type': 'progress', 'phase': 'simulating', 'day': 0, 'total': real_days,
          'date': calendar[0], 'message': f'backtrader 启动: {added} 个标的 / {real_days} 个交易日'})

    try:
        strategies = cerebro.run()
    except Exception as exc:
        emit({'type': 'error', 'message': f'backtrader 运行失败: {exc}'})
        return 1

    strat = strategies[0]
    final_equity = float(cerebro.broker.getvalue())
    final_cash = float(cerebro.broker.getcash())

    # 权益曲线: 按真实交易日补齐并合并基准 (排除哨兵日)
    points = {p['date']: p for p in strat.equity_points}
    dates = [d for d in calendar if d in points]
    if not dates:
        fallback = calendar[-2] if len(calendar) > 1 else calendar[-1]
        dates = [fallback]
        points.setdefault(fallback, {
            'date': fallback, 'value': final_equity, 'cash': final_cash,
            'positionValue': 0.0, 'positions': 0,
        })
    benchmark = build_benchmark(bundle, symbols, dates, initial_cash)
    if benchmark_id != 'equal_weight':
        index_series = (baselines.get('series') or {}).get(benchmark_id) or []
        benchmark = build_index_benchmark(index_series, dates, initial_cash) or benchmark
    equity = []
    for d in dates:
        p = points[d]
        equity.append({
            'date': d,
            'value': p['value'],
            'cash': p['cash'],
            'positionValue': p['positionValue'],
            'positions': p['positions'],
            'benchmark': benchmark.get(d, initial_cash),
        })

    values = [p['value'] for p in equity]
    # 把初始资金作为第 0 个点, 这样首日费用/收益也计入收益、回撤与夏普
    series = [initial_cash] + values
    days = max(1, len(series) - 1)
    total_return = (values[-1] - initial_cash) / initial_cash * 100.0 if initial_cash > 0 else 0.0
    annualized = ((values[-1] / initial_cash) ** (252.0 / days) - 1.0) * 100.0 if initial_cash > 0 and values[-1] > 0 else 0.0
    bench_return = ((equity[-1]['benchmark'] - initial_cash) / initial_cash * 100.0) if initial_cash > 0 else 0.0

    closed = [f for f in strat.fills if f['side'] == 'SELL' and f.get('pnl') is not None]
    wins = sum(1 for f in closed if f['pnl'] > 0)
    win_rate = (wins / len(closed) * 100.0) if closed else 0.0

    open_positions = strat.open_positions(final_equity)
    for p in open_positions:
        info = symbol_info.get(p['symbol']) or {}
        p['code'] = info.get('code')
        p['name'] = info.get('name')

    symbol_stats = []
    for sym, st in strat.symbol_stats.items():
        info = symbol_info.get(sym) or {}
        base = st['entry_value']
        symbol_stats.append({
            'symbol': sym,
            'code': info.get('code'),
            'name': info.get('name'),
            'industry': info.get('industry'),
            'buys': st['buys'],
            'sells': st['sells'],
            'closedTrades': st['closed'],
            'winRate': (st['wins'] / st['closed'] * 100.0) if st['closed'] else 0.0,
            'realizedPnl': st['realized_pnl'],
            'realizedReturnPercent': (st['realized_pnl'] / base * 100.0) if base > 0 else 0.0,
            'fees': st['fees'],
        })
    symbol_stats.sort(key=lambda x: -x['realizedPnl'])

    for f in strat.fills:
        info = symbol_info.get(f['symbol']) or {}
        f['code'] = info.get('code')
        f['name'] = info.get('name')
    for s in strat.signal_log:
        info = symbol_info.get(s['symbol']) or {}
        s['code'] = info.get('code')
        s['name'] = info.get('name')

    tested = sum(1 for s in symbols if os.path.exists(os.path.join(bundle, s['file'])))
    stats = {
        'initialCash': initial_cash,
        'finalEquity': final_equity,
        'totalReturnPercent': total_return,
        'annualizedReturnPercent': annualized,
        'benchmarkReturnPercent': bench_return,
        'excessReturnPercent': total_return - bench_return,
        'maxDrawdownPercent': max_drawdown(series),
        'sharpeRatio': sharpe(series),
        'fills': len(strat.fills),
        'closedTrades': len(closed),
        'winningTrades': wins,
        'winRate': win_rate,
        'totalFees': strat.total_fees,
        'avgPositions': (strat.positions_sum / strat.equity_days) if strat.equity_days else 0.0,
        'exposurePercent': (strat.exposure_sum / strat.equity_days * 100.0) if strat.equity_days else 0.0,
        'tradingDays': len(equity),
    }

    result = {
        'engine': {
            'name': 'backtrader',
            'version': getattr(bt, '__version__', 'unknown'),
            'python': sys.version.split()[0],
        },
        'stats': stats,
        'dateRange': {'start': equity[0]['date'], 'end': equity[-1]['date']},
        'equity': equity,
        'trades': strat.fills,
        'signals': strat.signal_log,
        'symbolStats': symbol_stats,
        'openPositions': open_positions,
        'diagnostics': [],
        'failures': strat.failures,
        'universeSize': len(symbols),
        'tested': tested,
        'signalCount': len(strat.signal_log),
        'meta': {
            'durationSec': round(time.time() - started, 3),
            'finalCash': final_cash,
            'calendarDays': real_days,
        },
    }

    with open(args.out, 'w', encoding='utf-8') as fh:
        json.dump(result, fh, ensure_ascii=False)

    emit({
        'type': 'done',
        'phase': 'simulating',
        'day': len(calendar),
        'total': len(calendar),
        'message': f'组合模拟完成: {stats["tradingDays"]} 个交易日, {stats["fills"]} 笔成交',
        'stats': {
            'finalEquity': final_equity,
            'totalReturnPercent': total_return,
            'closedTrades': len(closed),
        },
    })
    return 0


if __name__ == '__main__':
    sys.exit(main())
