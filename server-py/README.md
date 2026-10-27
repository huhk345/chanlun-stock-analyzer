# Python server & backtest engine

The analysis and backtest backend: ChanLun structure recognition, the A-share
backtest engine, the strategy registry, the K-line data layer and the HTTP API the
React frontend talks to. The default engine has zero third-party runtime
dependencies; the optional `backtrader` engine adds exactly one.

It began as a behavioural port of the former TypeScript backend (`server/`, since
retired) and that fidelity is still pinned by a recorded golden fixture: the same
bars must produce the same trade ledger, down to the fee on each fill.

```
server-py/
├── chanlun_server/
│   ├── chanlun.py          # 合并K线 → 分型 → 笔 → 线段 → 中枢 → 买卖点
│   ├── kline_utils.py      # 日期/交易日/新鲜度/列式解析
│   ├── sources.py          # 腾讯行情 (主) + TickFlow (兜底), 限速与域名轮换
│   ├── klines.py           # 本地缓存 + 增量更新 + 除权校验 + 并发去重
│   ├── fees.py             # 佣金/印花税/过户费, 涨跌停, 委托股数, 决策校验
│   ├── execution.py        # 收盘价成交 / 盘中止损 / T+1
│   ├── runner.py           # 批量回测 (逐根, 因果) — native 引擎
│   ├── bt_engine.py        # 同一策略契约跑在 backtrader 上 — backtrader 引擎
│   ├── timeline.py         # 逐日模拟: 单日快照 + 时间轴 + 磁盘缓存
│   ├── stepper.py          # 逐步回测: 录一次, 之后按索引导航
│   ├── metrics.py          # 夏普/最大回撤/账本工具
│   ├── indicators.py       # MA/BOLL/MACD/RSI/ATR 快照
│   ├── strategies/         # ma-cross · macd-trend · chanlun-weekly-daily-thermometer
│   ├── sandbox.py          # 用户策略 (Python) 受限执行
│   ├── strategy_store.py   # data/user-strategies/*.json 持久化
│   ├── pool.py             # 选股池等权组合回测 (任务模型)
│   ├── progress.py         # 单次回测的阶段进度
│   ├── service.py          # 回测/逐步回测的会话编排 + 引擎分发
│   └── http_api.py         # 路由 (纯函数) + ThreadingHTTPServer
├── tests/
│   ├── part1_unit/         # 纯函数
│   ├── part2_integration/  # 引擎 + 路由 + 缓存, 进程内
│   └── part3_e2e/          # 真实进程 + 真实 HTTP
└── run_tests.py            # 三阶段测试运行器
```

## Quick start

```bash
# from the repository root
python3 -m venv server-py/.venv
server-py/.venv/bin/pip install -r server-py/requirements-dev.txt

cd server-py
.venv/bin/python -m chanlun_server serve        # http://127.0.0.1:8899
.venv/bin/python run_tests.py                   # all three test parts
```

Or through the existing package scripts:

```bash
pnpm run py:setup     # create the venv + install pytest
pnpm run server:py    # start the Python backend on :8899
pnpm run test:py      # three-part test run
```

The default (`native`) runtime has **zero third-party dependencies** — everything
above runs on the standard library. `pytest` is only needed for the test suite,
and `backtrader` only for `engine=backtrader`:

```bash
.venv/bin/pip install backtrader      # optional
```

Point the frontend at it by setting `ANALYSIS_API_TARGET=http://127.0.0.1:8899`
(Vite dev proxy), or `VITE_ANALYSIS_API_URL` for a direct base URL. The browser
code is unchanged: the JSON contract is identical.

## CLI

```bash
python -m chanlun_server backtest --symbol 600519.SH --strategy chanlun-weekly-daily-thermometer \
    --cash 100000 --stop-loss 8 --out report.json

# same run on the open-source framework engine
python -m chanlun_server backtest --symbol 600519.SH --strategy ma-cross --engine backtrader

python -m chanlun_server chanlun --symbol 000001.SZ     # 结构摘要
python -m chanlun_server strategies                     # 策略元数据
python -m chanlun_server pool --strategy ma-cross --indexes hs300,zz500
```

## API surface

Ported 1:1 (same paths, same JSON keys, same status codes):

| Endpoint | Notes |
| --- | --- |
| `GET /api/health` | + `engine: "python"`, `strategies` count |
| `GET /api/klines` | Tencent → TickFlow fallback, disk cache, incremental |
| `POST /api/chanlun/analyze` | 结构 + 买卖点 |
| `POST /api/chanlun/bspoints` | 笔 + 买卖点 (轻量) |
| `GET/POST /api/strategies`, `/api/strategies/user`, `/api/strategies/import` | 注册表 + 持久化 |
| `GET /api/strategies/:id/source`, `DELETE /api/strategies/:id` | 源码 / 删除 |
| `POST /api/backtest/run` | 单标的回测 (可带 `progressId`, `engine`: `native` \| `backtrader`) |
| `GET /api/backtest/progress/:id` | 阶段进度 |
| `POST /api/backtest/stepper` (+ `/step`, `/run-all`, `/trades`, `/timeline`, `DELETE`) | 逐日模拟会话 (`engine`: `native` \| `backtrader`) |
| `POST /api/backtest/pool` (+ `/:id`, `/symbol/:symbol`, `/trades`, `/cancel`) | 选股池等权组合 |

Deliberately **not** ported (see "Differences" below): the `/ws` ChanLun scan
socket, `/api/scan/cache` (returns an explicit stub), and `/api/simulation/*`
(shared-cash backtrader runs, retired along with the Node backend).

## Execution model

Identical to `server/engine/backtestExecution.ts`:

1. **Signals are causal.** The strategy receives `klines[:i+1]` only and is filled
   at *that bar's close* (late-session / closing-auction model).
2. **Limit checks use the close.** A close sealed at limit-up cannot be bought; a
   close sealed at limit-down cannot be sold.
3. **Fixed stop-loss is an intraday stop order.** Touched → filled at the trigger
   price; gapped below → filled at the open; limit-down all day → deferred.
4. **T+1.** The stop runs before the buy fill, so same-day shares are unsellable.
5. **A-share costs.** 佣金 (min ¥5) + 印花税 0.1% (sell) + 过户费 0.001% (both
   sides); buys are floored to 100-share lots.

## Two engines, one strategy contract

A strategy is a callable `decide(ctx) -> Decision`, where `Decision` is
`{action: "BUY" | "SELL" | "HOLD", amount: {unit: "cash" | "shares" | "percent", value}, reason?}`.
Both engines drive that same callable and return the same `BacktestResult`:

| `engine` | Module | Notes |
| --- | --- | --- |
| `native` (default) | `runner.py` | hand-rolled bar loop; zero dependencies; the reference ledger |
| `backtrader` | `bt_engine.py` | [backtrader](https://www.backtrader.com/) `Cerebro` + `Strategy`; `pip install backtrader` |

`POST /api/backtest/run` and `POST /api/backtest/pool` accept `engine`; the
response echoes the engine actually used. Unknown values are a `400`.

How the backtrader side is wired (`bt_engine.py`):

- **`KlineFeed`** — a `bt.feeds.DataBase` subclass that streams `models.Kline`
  objects directly, so no pandas/numpy is pulled in.
- **`AStockCommission`** — a `CommInfoBase` whose `_getcommission` delegates to
  `fees.calc_a_stock_fees`, so the broker's cash bookkeeping carries the same
  minimum commission, sell-side stamp duty and transfer fee as the native engine.
- **`StrategyAdapter`** — owns an append-only `list[Kline]`; on each bar it
  appends the bar, recomputes ChanLun structures and the indicator snapshot from
  that buffer, calls `decide(ctx)`, then sizes the order with the shared
  `fees.resolve_order_shares` (so 100-share lots and percent sizing are identical)
  and submits a market order. `broker.set_coc(True)` fills it at the signal bar's
  close; order cash checks are done by the engine, hence `set_checksubmit(False)`.
- **Stop-loss** — a standing `bt.Order.Stop` armed in the same `next()` that opens
  the position, so it is first evaluated on the following bar, exactly like the
  native intraday stop. It is re-armed (cancel + replace) whenever the position
  size or average cost changes.
- **Sentinel bar** — one duplicate bar is appended after the real series so an
  order signalled on the final bar can settle (backtrader fills at the start of
  the next cycle). The adapter ignores it for strategy and ChanLun purposes.

Both engines are pinned to each other by
`tests/part2_integration/test_backtrader_engine.py`: identical trades (date, side,
shares, price, value, fee, label), identical equity curve, with and without a
stop-loss, on synthetic data and on the recorded golden fixture.

`stepper.py` (day-by-day stepping) stays native-only — it needs a rewound engine
state, which backtrader does not expose.

## Day-by-day simulation

`POST /api/backtest/stepper` opens a simulation, `GET .../timeline` returns the
whole thing, `POST .../step` moves the cursor. The design point: **the run is
recorded once, then navigated by index.**

```
create  → one pass over the cached bars, one DaySnapshot per trading day
          (decision, fills, account, position, mark-to-market equity,
           indicators, ChanLun summary)          ≈ 2 s for 900 bars
timeline→ all rows + the whole ledger, one payload (~200 KB)   ≈ 10 ms
step    → index lookup, forward/backward/jump all the same     ≈ 10 µs
reopen  → the recording is cached on disk, no pass at all      ≈ 20 ms
```

Why it matters: the previous stepper *re-ran* the strategy on every move, so
jumping from day 0 to day 900 meant 900 strategy calls — each with a fresh
ChanLun pass over the prefix — i.e. seconds per jump. Now the only expensive
thing is the first pass, which is the same cost as the batch backtest you were
going to run anyway.

The recording hook (`on_bar`) is implemented by both engines, so a simulation can
be replayed day by day on `native` or `backtrader` with an identical ledger.

Recordings live in `.cache/timelines/<key>.json`, keyed by symbol, engine,
strategy source hash, params, fees, stop-loss, the bar window and the last few
closes (so an ex-rights re-base invalidates them). Pass `"refresh": true` to force
a fresh pass.

Each day state carries, in addition to the classic step fields:

| Field | Meaning |
| --- | --- |
| `equity` | mark-to-market equity at that day's close (cash + shares × close) |
| `indicators` | MA5/10/20/60, BOLL, MACD as computed for that bar |
| `chanlun` | compact structure summary: merged/fractions/strokes/segments/hubs + last hub bounds |

## The three-part test framework

The suite is split by **what a failure tells you**, not by file. Each part is a
separate pytest invocation with its own marker, driven by `run_tests.py`.

| Part | Marker | Scope | Runs | Typical time |
| --- | --- | --- | --- | --- |
| 1 · unit | `unit` | pure functions — ChanLun, fees, metrics, indicators, sandbox, models | no IO, no clock, no network | ~0.5 s |
| 2 · integration | `integration` | engine + registry + router + cache wired together, in-process | temp dirs, fake upstream | ~14 s |
| 3 · e2e | `e2e` | real `python -m chanlun_server serve` subprocess over a socket | ephemeral port, seeded cache | ~1.5 s |

```bash
python run_tests.py                 # all three
python run_tests.py --part 1        # fastest feedback loop
python run_tests.py --part 3 -v     # full pytest output
python run_tests.py --no-parity     # skip the JS-engine comparison
python run_tests.py --live          # also hit real market data
```

```
  layer       tests   fail   skip     time   status
  ────────────────────────────────────────────────────────────
  unit           95      0      0    0.35s   ok
  integration   121      0      0   30.06s   ok
  e2e            14      0      0    0.95s   ok
  ────────────────────────────────────────────────────────────
  total         230      0      0   31.36s
```

### What each part actually proves

**Part 1 — unit.** Containment merging, fractal/stroke alternation, hub bounds,
BS-point dedupe and `confirmed_only` subset semantics, fee arithmetic, limit
prices per board, lot rounding, JS-compatible rounding (`round_half_up` vs
banker's), Sharpe/drawdown formulas, indicator causality, Beijing trading-day
clock, sandbox rejection of imports/`open`/dunder access.

**Part 2 — integration.**

- *Execution model*: same-bar close fills, T+1 blocking a same-day stop, gap
  fills at the open, limit-down deferral, limit-up blocking a buy, ledger
  invariants (price inside `[low, high]`, cash never negative, whole lots).
- *Stepper parity*: `run_all()` reproduces `run_backtest()` trade for trade on
  both engines; forward/backward/jump are pure replays that never drift, and a
  call-counting test asserts navigation never invokes the strategy again.
- *Prefix invariance*: truncating the series at several cuts reproduces the full
  run's trades and equity exactly — the standard detector for look-ahead. Run for
  every builtin strategy, with and without a stop-loss, on synthetic **and** real
  fixture data.
- *Golden parity*: a recorded 921-bar real fixture whose expected ledger came from
  the original TypeScript engine must match exactly (date, side, price, shares,
  value, fee, signal label, final balance, equity length). This is what keeps the
  port honest now that the TS engine is gone.
- *Engine parity*: the backtrader adapter must reproduce the native ledger trade
  for trade — all three builtin strategies across seeds, the golden fixture, and
  the stop-loss ledger — plus its own coverage of the fee `CommInfo`, the
  strategy-owned K-line buffer, ChanLun/indicator snapshots, T+1 stop timing and
  the `engine` switch on the HTTP layer.
- *Data layer*: cache freshness, "verified today" short-circuit, incremental
  merge, ex-rights full refresh, window backfill, concurrent request dedupe.
- *Router*: every endpoint, validation errors, 404/405, progress and session
  lifecycle, pool job completion.

**Part 3 — e2e.** The same API through a real socket: JSON encoding, CORS
headers, `OPTIONS` preflight, malformed-body handling, worker-thread survival
after bad requests, 16 concurrent requests, the user-strategy round trip, and the
CLI reading the same cache.

Tests never touch the network by default. `live`-marked tests are skipped unless
`--live` is passed.

## Differences from the retired Node server

| Area | Node (retired) | Python | Why |
| --- | --- | --- | --- |
| User strategies | JS in `node:vm` | Python in an AST-whitelisted sandbox | No stdlib VM; records with `language != "python"` are skipped with a warning |
| User indicators | JS compiled per request | Not executed; builtin MA/BOLL/MACD still injected | Same reason; `indicatorCodes` is accepted and ignored |
| BS-point scan | `/ws` WebSocket + `.cache/scan` | Not ported (`/api/scan/cache` is a stub) | Large subsystem; single-symbol analysis covers the same algorithms |
| Pool simulation | backtrader subprocess | Not ported | Shared-cash simulation was retired with the Node backend; `POST /api/backtest/pool` covers equal-weight pool backtests |

Everything else — structures, BS points, fees, fills, stepper semantics, strategy
metadata, pool aggregation — is a straight port.

## Notes

- The K-line cache lives in `.cache/klines/<symbol>_<period>_<adjust>.json`
  (`symbol`/`period`/`adjust`/`updatedAt`/`klines`/`historyComplete`), so an
  existing cache directory from the Node build is reused as-is.
- `get_klines` is safe to call from multiple threads: identical in-flight requests
  collapse into one upstream call.
- The thermometer strategy ships with the market-strength series
  (`strategies/data/market_strength.json`, 4586 rows, 2007-12-04 → 2026-10-20).
