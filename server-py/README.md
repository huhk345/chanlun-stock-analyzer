# Python server & backtest engine

A dependency-free Python rewrite of the Node backend (`server/`, ~12.6k lines of
TypeScript): ChanLun structure recognition, the A-share backtest engine, the
strategy registry, the K-line data layer and the same HTTP API the React frontend
already talks to.

The point is not a toy reimplementation — it is a **behavioural port**. The same
cached bars fed to both engines produce the same trade ledger, down to the fee on
each fill. That equivalence is asserted by the test suite
(`tests/part2_integration/test_ts_parity.py`) and by a recorded golden fixture.

```
server-py/
├── chanlun_server/
│   ├── chanlun.py          # 合并K线 → 分型 → 笔 → 线段 → 中枢 → 买卖点
│   ├── kline_utils.py      # 日期/交易日/新鲜度/列式解析
│   ├── sources.py          # 腾讯行情 (主) + TickFlow (兜底), 限速与域名轮换
│   ├── klines.py           # 本地缓存 + 增量更新 + 除权校验 + 并发去重
│   ├── fees.py             # 佣金/印花税/过户费, 涨跌停, 委托股数, 决策校验
│   ├── execution.py        # 收盘价成交 / 盘中止损 / T+1
│   ├── runner.py           # 批量回测 (逐根, 因果)
│   ├── stepper.py          # 逐步回测 (前进/后退/跳转/跑到结束)
│   ├── metrics.py          # 夏普/最大回撤/账本工具
│   ├── indicators.py       # MA/BOLL/MACD/RSI/ATR 快照
│   ├── strategies/         # ma-cross · macd-trend · chanlun-weekly-daily-thermometer
│   ├── sandbox.py          # 用户策略 (Python) 受限执行
│   ├── strategy_store.py   # data/user-strategies/*.json 持久化
│   ├── pool.py             # 选股池等权组合回测 (任务模型)
│   ├── progress.py         # 单次回测的阶段进度
│   ├── service.py          # 回测/逐步回测的会话编排
│   └── http_api.py         # 路由 (纯函数) + ThreadingHTTPServer
├── tests/
│   ├── part1_unit/         # 纯函数
│   ├── part2_integration/  # 引擎 + 路由 + 缓存, 进程内
│   └── part3_e2e/          # 真实进程 + 真实 HTTP
├── tools/ts_engine_dump.ts # 导出 TS 引擎结果, 供逐笔比对
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

The runtime itself has **zero third-party dependencies** — everything above runs
on the standard library. `pytest` is only needed for the test suite.

Point the frontend at it by setting `ANALYSIS_API_TARGET=http://127.0.0.1:8899`
(Vite dev proxy), or `VITE_ANALYSIS_API_URL` for a direct base URL. The browser
code is unchanged: the JSON contract is identical.

## CLI

```bash
python -m chanlun_server backtest --symbol 600519.SH --strategy chanlun-weekly-daily-thermometer \
    --cash 100000 --stop-loss 8 --out report.json

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
| `POST /api/backtest/run` | 单标的回测 (可带 `progressId`) |
| `GET /api/backtest/progress/:id` | 阶段进度 |
| `POST /api/backtest/stepper` (+ `/step`, `/run-all`, `/trades`, `DELETE`) | 逐步回测会话 |
| `POST /api/backtest/pool` (+ `/:id`, `/symbol/:symbol`, `/trades`, `/cancel`) | 选股池等权组合 |

Deliberately **not** ported (see "Differences" below): the `/ws` ChanLun scan
socket, `/api/scan/cache` (returns an explicit stub), and `/api/simulation/*`
(shared-cash backtrader runs, which already execute in Python via
`scripts/backtrader/runner.py`).

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
  unit           95      0      0    0.52s   ok
  integration    91      0      0   13.63s   ok
  e2e            14      0      0    1.55s   ok
  ────────────────────────────────────────────────────────────
  total         200      0      0   15.69s
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
- *Stepper parity*: `run_all()` reproduces `run_backtest()` trade for trade;
  forward/backward/jump are pure replays that never drift.
- *Prefix invariance*: truncating the series at several cuts reproduces the full
  run's trades and equity exactly — the standard detector for look-ahead. Run for
  every builtin strategy, with and without a stop-loss, on synthetic **and** real
  fixture data.
- *Golden parity*: a recorded 921-bar real fixture whose expected ledger came from
  the TypeScript engine must match exactly (date, side, price, shares, value, fee,
  signal label, final balance, equity length).
- *Cross-engine parity* (`parity` marker, needs `node_modules/.bin/tsx`): spawns
  the TS engine through `tools/ts_engine_dump.ts` and diffs the ledgers live.
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

## Differences from the Node server

| Area | Node | Python | Why |
| --- | --- | --- | --- |
| User strategies | JS in `node:vm` | Python in an AST-whitelisted sandbox | No stdlib VM; records with `language != "python"` are skipped with a warning |
| User indicators | JS compiled per request | Not executed; builtin MA/BOLL/MACD still injected | Same reason; `indicatorCodes` is accepted and ignored |
| BS-point scan | `/ws` WebSocket + `.cache/scan` | Not ported (`/api/scan/cache` is a stub) | Large subsystem; single-symbol analysis covers the same algorithms |
| Pool simulation | backtrader via Python subprocess | Not ported | Already Python (`scripts/backtrader/runner.py`); keep one owner |
| Progress polling | In-memory registry | Same | — |

Everything else — structures, BS points, fees, fills, stepper semantics, strategy
metadata, pool aggregation — is a straight port.

## Notes

- The K-line cache format is byte-compatible with the Node server
  (`.cache/klines/<symbol>_<period>_<adjust>.json`), so both can share a cache
  directory.
- `get_klines` is safe to call from multiple threads: identical in-flight requests
  collapse into one upstream call.
- The thermometer strategy ships with the market-strength series
  (`strategies/data/market_strength.json`, 4586 rows, 2007-12-04 → 2026-10-20)
  converted from the TS module.
