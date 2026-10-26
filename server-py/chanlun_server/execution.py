"""Order execution model (shared by the batch runner and the stepper).

Execution conventions — identical to ``server/engine/backtestExecution.ts``:

1. Signals are produced from data up to and including the current bar, and are
   filled at **that bar's close** (late-session / closing-auction model). No
   component may read bar ``i + 1``; prefix-invariance tests detect violations.

2. Limit-up/limit-down blocking uses the current close vs. the previous close
   (information visible at the close): a close sealed at limit-up cannot be
   bought, a close sealed at limit-down cannot be sold.

3. Fixed stop-loss is an intraday stop order: the trigger price
   (cost * (1 - pct)) is armed once the position is open; if the bar's low
   touches it the fill happens at the trigger price, at the open when the bar
   gapped below, and is deferred when the bar is limit-down all day.

4. T+1: shares bought today cannot be sold today. The intraday stop runs before
   today's buy fill, so structurally only pre-existing shares can be sold.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

from .fees import (
    DEFAULT_COMMISSION_RATE,
    DEFAULT_MIN_COMMISSION,
    calc_a_stock_fees,
    limit_down_price,
    limit_up_price,
    resolve_order_shares,
)
from .metrics import next_trade_id
from .models import Account, Decision, Diagnostic, Kline, Position, Trade


# ---------------------------------------------------------------------------
# 账户 / 持仓状态
# ---------------------------------------------------------------------------


def create_initial_account(initial_cash: float, currency: str) -> Account:
    return Account(initial_cash=initial_cash, cash=initial_cash, equity=initial_cash, currency=currency)


def create_initial_position() -> Position:
    return Position()


def update_account_after_trade(account: Account, position: Position, current_price: float) -> Account:
    market_value = position.shares * current_price
    return Account(
        initial_cash=account.initial_cash,
        cash=account.cash,
        equity=account.cash + market_value,
        currency=account.currency,
    )


def update_position_after_buy(position: Position, shares: int, price: float) -> Position:
    total_cost = position.average_cost * position.shares + price * shares
    total_shares = position.shares + shares
    average_cost = total_cost / total_shares if total_shares > 0 else 0.0
    market_value = total_shares * price
    unrealized_pnl = market_value - total_cost
    unrealized_pnl_percent = (unrealized_pnl / total_cost) * 100.0 if total_cost > 0 else 0.0
    return Position(
        shares=total_shares,
        average_cost=average_cost,
        market_value=market_value,
        unrealized_pnl=unrealized_pnl,
        unrealized_pnl_percent=unrealized_pnl_percent,
    )


def update_position_after_sell(position: Position, shares: int, price: float):
    """Return ``(new_position, realized_pnl)``; pnl is before fees."""
    sell_value = shares * price
    cost_basis = shares * position.average_cost
    realized_pnl = sell_value - cost_basis

    remaining_shares = position.shares - shares
    market_value = remaining_shares * price
    remaining_cost = remaining_shares * position.average_cost
    unrealized_pnl = market_value - remaining_cost
    unrealized_pnl_percent = (unrealized_pnl / remaining_cost) * 100.0 if remaining_cost > 0 else 0.0

    return (
        Position(
            shares=remaining_shares,
            average_cost=position.average_cost,
            market_value=market_value,
            unrealized_pnl=unrealized_pnl,
            unrealized_pnl_percent=unrealized_pnl_percent,
        ),
        realized_pnl,
    )


# ---------------------------------------------------------------------------
# 决策执行: 当根收盘价成交
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class ExecutionResult:
    account: Account
    position: Position
    fee: float = 0.0
    trade: Optional[Trade] = None
    diagnostics: List[Diagnostic] = field(default_factory=list)


def execute_decision_at_close(
    decision: Decision,
    bar: Kline,
    prev_close: Optional[float],
    symbol: str,
    account: Account,
    position: Position,
    commission_rate: float = DEFAULT_COMMISSION_RATE,
    min_commission: float = DEFAULT_MIN_COMMISSION,
    strategy_label: str = "",
) -> ExecutionResult:
    """Fill a BUY/SELL at ``bar.close`` after checking limits, cash and holdings."""
    diagnostics: List[Diagnostic] = []
    price = bar.close

    order = resolve_order_shares(decision, account, position, price)
    for warning in order.warnings:
        diagnostics.append(Diagnostic(message=warning, level="warning", date=bar.date))
    if order.shares <= 0:
        return ExecutionResult(account=account, position=position, diagnostics=diagnostics)

    # --- 涨跌停拦截 ---
    if prev_close is not None and prev_close > 0:
        if decision.action == "BUY" and price >= limit_up_price(prev_close, symbol):
            diagnostics.append(
                Diagnostic(
                    level="warning",
                    date=bar.date,
                    message=(
                        "Buy blocked: 收盘封涨停, 无法按收盘价买入 "
                        f"(close {price:.2f} >= limit-up {limit_up_price(prev_close, symbol):.2f}), 交易作废"
                    ),
                )
            )
            return ExecutionResult(account=account, position=position, diagnostics=diagnostics)
        if decision.action == "SELL" and price <= limit_down_price(prev_close, symbol):
            diagnostics.append(
                Diagnostic(
                    level="warning",
                    date=bar.date,
                    message=(
                        "Sell blocked: 收盘封跌停, 无法按收盘价卖出 "
                        f"(close {price:.2f} <= limit-down {limit_down_price(prev_close, symbol):.2f}), 交易作废"
                    ),
                )
            )
            return ExecutionResult(account=account, position=position, diagnostics=diagnostics)

    if decision.action == "BUY":
        # Shrink the order in whole lots until cash covers value + fees.
        buy_shares = order.shares
        cost = buy_shares * price
        fee = calc_a_stock_fees(cost, True, commission_rate, min_commission)
        while buy_shares >= 100 and cost + fee > account.cash:
            buy_shares -= 100
            cost = buy_shares * price
            fee = calc_a_stock_fees(cost, True, commission_rate, min_commission)
        if buy_shares <= 0 or cost + fee > account.cash:
            diagnostics.append(
                Diagnostic(
                    message="Buy skipped: 成交时可用资金不足 (含手续费)",
                    level="warning",
                    date=bar.date,
                )
            )
            return ExecutionResult(account=account, position=position, diagnostics=diagnostics)

        new_position = update_position_after_buy(position, buy_shares, price)
        new_account = Account(
            initial_cash=account.initial_cash,
            cash=account.cash - cost - fee,
            equity=account.equity,
            currency=account.currency,
        )
        new_account = update_account_after_trade(new_account, new_position, price)

        trade = Trade(
            id=next_trade_id(),
            type="BUY",
            signal_type=strategy_label,
            reason=decision.reason,
            confidence=decision.confidence,
            price=price,
            date=bar.date,
            shares=buy_shares,
            value=cost,
            fee=fee,
        )
        return ExecutionResult(
            account=new_account, position=new_position, fee=fee, trade=trade, diagnostics=diagnostics
        )

    # --- SELL ---
    sell_shares = min(order.shares, position.shares)
    if sell_shares <= 0:
        return ExecutionResult(account=account, position=position, diagnostics=diagnostics)

    sell_value = sell_shares * price
    fee = calc_a_stock_fees(sell_value, False, commission_rate, min_commission)
    new_position, realized_pnl = update_position_after_sell(position, sell_shares, price)
    new_account = Account(
        initial_cash=account.initial_cash,
        cash=account.cash + sell_value - fee,
        equity=account.equity,
        currency=account.currency,
    )
    new_account = update_account_after_trade(new_account, new_position, price)

    pnl_percent = (
        (realized_pnl / (sell_shares * new_position.average_cost)) * 100.0
        if new_position.average_cost > 0
        else 0.0
    )

    trade = Trade(
        id=next_trade_id(),
        type="SELL",
        signal_type=strategy_label,
        reason=decision.reason,
        confidence=decision.confidence,
        price=price,
        date=bar.date,
        shares=sell_shares,
        value=sell_value,
        fee=fee,
        pnl=realized_pnl,
        pnl_percent=pnl_percent,
    )
    return ExecutionResult(
        account=new_account, position=new_position, fee=fee, trade=trade, diagnostics=diagnostics
    )


# ---------------------------------------------------------------------------
# 固定止损: 盘中止损单
# ---------------------------------------------------------------------------


def execute_protective_stop(
    bar: Kline,
    prev_close: Optional[float],
    symbol: str,
    stop_loss_percent: float,
    sellable_shares: int,
    account: Account,
    position: Position,
    commission_rate: float = DEFAULT_COMMISSION_RATE,
    min_commission: float = DEFAULT_MIN_COMMISSION,
) -> ExecutionResult:
    """Intraday stop order.

    - gap down (open <= stop)      → fill at the open (worse price)
    - touched intraday             → fill at the stop price
    - limit-down all day           → cannot sell, defer to the next session
    """
    diagnostics: List[Diagnostic] = []

    if sellable_shares <= 0 or position.shares <= 0:
        return ExecutionResult(account=account, position=position, diagnostics=diagnostics)

    stop_price = position.average_cost * (1 - stop_loss_percent / 100.0)
    if not (stop_price > 0):
        return ExecutionResult(account=account, position=position, diagnostics=diagnostics)

    if bar.low > stop_price:
        return ExecutionResult(account=account, position=position, diagnostics=diagnostics)

    if prev_close is not None and prev_close > 0:
        limit_down = limit_down_price(prev_close, symbol)
        if bar.high <= limit_down:
            diagnostics.append(
                Diagnostic(
                    level="warning",
                    date=bar.date,
                    message=(
                        f"Stop-loss deferred: {bar.date} 一字跌停无法卖出 "
                        f"(high {bar.high:.2f} <= limit-down {limit_down:.2f}), 止损顺延至下一交易日"
                    ),
                )
            )
            return ExecutionResult(account=account, position=position, diagnostics=diagnostics)

    gapped_below = bar.open <= stop_price
    fill_price = bar.open if gapped_below else stop_price
    sell_shares = min(sellable_shares, position.shares)
    if sell_shares <= 0:
        return ExecutionResult(account=account, position=position, diagnostics=diagnostics)

    sell_value = sell_shares * fill_price
    fee = calc_a_stock_fees(sell_value, False, commission_rate, min_commission)
    new_position, realized_pnl = update_position_after_sell(position, sell_shares, fill_price)
    new_account = Account(
        initial_cash=account.initial_cash,
        cash=account.cash + sell_value - fee,
        equity=account.equity,
        currency=account.currency,
    )
    new_account = update_account_after_trade(new_account, new_position, fill_price)

    pnl_percent = (
        (realized_pnl / (sell_shares * new_position.average_cost)) * 100.0
        if new_position.average_cost > 0
        else 0.0
    )

    trade = Trade(
        id=next_trade_id(),
        type="SELL",
        signal_type="stop-loss",
        reason=f"触发固定止损 {stop_loss_percent}%",
        price=fill_price,
        date=bar.date,
        shares=sell_shares,
        value=sell_value,
        fee=fee,
        pnl=realized_pnl,
        pnl_percent=pnl_percent,
    )

    diagnostics.append(
        Diagnostic(
            level="warning",
            date=bar.date,
            message=f"Stop-loss triggered at {fill_price:.2f} (threshold {stop_price:.2f})",
        )
    )

    return ExecutionResult(
        account=new_account, position=new_position, fee=fee, trade=trade, diagnostics=diagnostics
    )
