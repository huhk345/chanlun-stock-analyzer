<div align="center">

# ChanLun Stock Analyzer

### 缠论量化工作台 · AI-Powered ChanLun Technical Analysis Platform

[![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript)](https://www.typescriptlang.org)
[![Vite 6](https://img.shields.io/badge/Vite-6-646CFF?logo=vite)](https://vitejs.dev)
[![Tailwind 4](https://img.shields.io/badge/Tailwind-4-06B6D4?logo=tailwindcss)](https://tailwindcss.com)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

</div>

---

## English

### Overview

ChanLun Stock Analyzer is a professional A-share technical analysis platform built on **ChanLun (缠论)** theory. It automatically identifies core market structures — fractions (分型), strokes (笔), segments (线段), and hubs (中枢) — and combines AI-powered multi-factor analysis to help traders objectively understand market trends, locate key support/resistance levels, and identify potential buy/sell signals.

### Key Features

- **ChanLun Structure Recognition** — Automatic identification of top/bottom fractions, strokes, segments, and multi-level hubs following the original ChanLun definitions
- **Buy/Sell Point & Divergence Detection** — Identifies 1st/2nd/3rd buy/sell points and top/bottom divergences with structured trading signals
- **AI Multi-Factor Analysis** — Powered by Google Gemini or OpenRouter, injects complete structured context into prompts for professional Chinese quantitative reports
- **Technical Indicators** — MA5/MA20, Bollinger Bands, MACD with interactive chart overlays
- **Stock Info Panel** — Displays industry, actual controller, and reduction plan announcements
- **Backtest Manager** — Local browser-persisted backtest tasks with Supabase cloud sync for logged-in users
- **Two Backtest Engines** — The same `BUY / SELL / HOLD + amount` strategy contract runs on a dependency-free native loop (`native`) or on [backtrader](https://www.backtrader.com/) (`engine: "backtrader"`). Both fill at the signal bar's close and apply A-share rules (T+1, 100-share lots, price-limit rejection, commission + stamp duty + transfer fee, optional fixed stop-loss), and a parity suite asserts the two produce an identical trade ledger
- **Day-by-Day Simulation** — One pass over the cached bars records every trading day (decision, fills, cash/position, mark-to-market equity, indicator snapshot, ChanLun summary), then you scrub, step and jump across the whole run instantly — navigation is an index lookup, not a re-run. Recordings are cached on disk, so re-opening the same simulation is instant
- **Pool Backtest** — Equal-weight backtest of one strategy across 沪深300 / 中证500, with an equity curve vs. an equal-weight buy-and-hold benchmark, KPI cards, trade ledger and per-symbol table
- **Rust Backtest Engine** — the same pool backtest on [barter-rs](https://github.com/barter-rs/barter-rs) 0.14: the framework feeds the pool day by day, the strategy answers `BUY / SELL / HOLD + amount`, an A-share execution layer fills it, and the whole run is recorded once then played back in `/simulation`
- **Search History** — Persistent stock search history with preset quick-access stocks
- **Resizable AI Rail** — Draggable side panel with persistent width, responsive mobile layout
- **Dark Theme** — Polished dark UI with smooth animations

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React 19 + TypeScript 5.8 |
| Build | Vite 6 + Tailwind CSS 4 |
| Charting | Lightweight Charts (TradingView) |
| Visualization | D3.js + Recharts |
| Icons & Motion | Lucide React + Motion |
| AI | Google Gemini / OpenRouter |
| Data | Tencent quote API (free, no key) · TickFlow API (fallback) |
| Auth & DB | Supabase |

### Getting Started

**Prerequisites:** Node.js 18+

1. **Clone the repository**
   ```bash
   git clone https://github.com/huhk345/chanlun-stock-analyzer.git
   cd chanlun-stock-analyzer
   ```

2. **Install dependencies**
   ```bash
   pnpm install
   ```

3. **Configure environment variables** — Copy `.env.example` to `.env.local` and fill in your API keys:
   ```bash
   cp .env.example .env.local
   ```
   | Variable | Required | Description |
   |----------|----------|-------------|
   | `VITE_TICKFLOW_API_KEY` | No | TickFlow API key — fallback K-line source only (Tencent is the default and needs no key) |
   | `KLINE_SOURCE` | No | `tencent` (default) or `tickflow` — force the K-line source |
   | `TENCENT_RPS` | No | Tencent global rate limit in requests/sec (default 15) |
   | `VITE_GEMINI_API_KEY` | Yes | Google Gemini API key from [AI Studio](https://aistudio.google.com/app/apikey) |
   | `VITE_OPENROUTER_API_KEY` | No | OpenRouter API key for multi-model support |

4. **Run the development server**
   ```bash
   pnpm run dev
   ```

5. Open [http://localhost:8888](http://localhost:8888) in your browser.

6. **Node analysis backend** — strategies and backtests run server-side:
   ```bash
   pnpm server   # tsx server/index.ts, listens on :8899
   ```
   HTTP endpoints: `GET /api/health`, `GET /api/klines`, `GET /api/scan/cache`, `POST /api/chanlun/analyze`, `POST /api/chanlun/bspoints`, `POST /api/backtest/run`, `POST /api/backtest/stepper` (+ `/step`, `/run-all`, `/trades`), and the strategy registry: `GET/POST /api/strategies`, `GET /api/strategies/user`, `GET /api/strategies/:id/source`, `DELETE /api/strategies/:id`, `POST /api/strategies/import`.

   **策略与回测引擎都在服务端** — the browser ships no strategy code and no backtest engine:

   | 层 | 位置 | 职责 |
   | --- | --- | --- |
   | 内置策略 | `server/strategies/*.ts` | 策略定义 (`id` / `name` / `decide`) + 数据 (`server/strategies/data/`) |
   | 用户策略 | `data/user-strategies/<id>.json` | AI 生成 / 手写的策略代码, 服务端持久化 (git 忽略) |
   | 策略注册表 | `server/strategies/index.ts` | 内置 + 自建合并, 供 `/api/strategies` 与回测解析 |
   | 回测引擎 | `server/engine/*.ts` | 撮合 (收盘价成交 / 涨跌停 / 止损 / T+1)、指标快照、单步回测 |
   | 沙箱 | `server/engine/userCodeSandbox.ts` | `node:vm` 执行用户策略代码 (禁 require/fetch/process, 5s 超时) |

   前端只保留 UI 与请求层 (`src/utils/backtestApi.ts`、`src/utils/strategyApi.ts`); 单步回测是有状态的服务端会话 (K 线与引擎状态留在内存, 30 分钟无访问回收)。用户自定义指标仍在浏览器侧维护 (图表要用), 回测时把选中的指标代码随请求上传, 由服务端沙箱编译。

   **缠论买卖点扫描 (`/indexes`) 完全在浏览器内完成, 不需要任何后端** — the browser fetches the K-lines, computes the ChanLun structures / BS-points and builds the signal rows itself (`src/utils/indexScan.ts`):
   ```text
   public/index-members.{hs300,zz500}.json  ->  universe
   fqkline 前复权 (日线 400 根 / 周线 300 根, 多源轮转)  ->  Kline[]
   utils/chanlun.ts computeStrokesAndBSPoints        ->  B1/B2/B3/S1/S2/S3
   最近 90 天窗口                                     ->  ScanSignalRow[]
   ```
   - 行情只用腾讯的两个域名, 按序轮转, 一个出现 501/403/断连就整轮剔除, 由另一个接手:
     `proxy.finance.qq.com/ifzqgtimg` (网页端 CDN, 带成交额) → `web.ifzq.gtimg.cn` (老接口)。
     两个都不可用时立即停止 (不再逐个标的空转), 回退本地缓存并在顶部提示。
   - 请求节奏刻意放慢: 2 路并发 + 500ms 间隔 (约 3 次/秒), 沪深300 全量约 2 分钟, 中证500 约 3 分钟;
     连续 15 次失败即熔断。
   - 结果按周期缓存于 `localStorage` (`chanlun_scan_local_daily` / `_weekly`), 只存信号行 (~150KB / 300 只); 再次扫描只重新拉取数据日期落后于最新交易日的标的, 已最新的标的零请求复用。

   Vite still proxies `/api` (and `/ws`) to the analysis backend for the single-stock analysis and backtest views; the 买卖点扫描 page no longer uses them. Override the backend address with `ANALYSIS_API_TARGET` (dev/preview proxy target) or the HTTP base URL with `VITE_ANALYSIS_API_URL`.

   > **The backend is no longer part of this repository.** `server-py/` has been removed; the frontend still talks to an analysis / backtest server on `:8899` over `/api` and `/ws`, so that server has to be started separately (the API contract below is unchanged).

   **Two interchangeable backtest engines** — the strategy contract (`decide(ctx) -> {action, amount, reason}`, where `action` is BUY / SELL / HOLD and `amount` is cash / shares / percent) is engine-agnostic. Pick one per request with `engine`:

   | `engine` | Implementation | Notes |
   | --- | --- | --- |
   | `native` (default) | hand-rolled bar loop | zero dependencies; the ledger pinned to the TypeScript golden fixture |
   | `backtrader` | [backtrader](https://www.backtrader.com/) | mature broker/order model from the framework; needs `pip install backtrader` |

   ```bash
   pip install backtrader                       # optional, only for engine=backtrader
   curl -s localhost:8899/api/backtest/run -H 'Content-Type: application/json' \
     -d '{"symbol":"300750.SZ","strategyId":"ma-cross","engine":"backtrader"}'
   ```

   Both engines fill at the signal bar's close (`broker.set_coc(True)` in backtrader), enforce 100-share lots, T+1, limit-up/limit-down rejection and the same commission + stamp-duty + transfer-fee model, and return the same `BacktestResult` JSON — switching engines changes features, not numbers.

   **The strategy owns its K-lines.** The backtrader adapter keeps an append-only `list[Kline]` and recomputes ChanLun + indicator snapshots from it on every bar, handing them to the strategy as `ctx.klines` / `ctx.chanlun` / `ctx.indicators`. A strategy never re-reads the feed and physically cannot see a future bar:

   ```python
   def decide(ctx):
       bars = ctx.klines                     # every bar up to and including this one
       if len(bars) < 30 or not ctx.chanlun.hubs:
           return Decision.hold()
       hub = ctx.chanlun.hubs[-1]
       close = ctx.current_kline.close
       if close > hub.zg and ctx.params["MA5"] > ctx.params["MA20"]:
           return Decision(action="BUY", amount={"unit": "shares", "value": 1000},
                           reason="站上中枢 + 均线多头")
       if close < hub.zd and ctx.position.shares > 0:
           return Decision(action="SELL", amount={"unit": "percent", "value": 100},
                           reason="跌破中枢")
       return Decision.hold()                # HOLD keeps the position untouched
   ```

   **Day-by-day simulation — recorded once, then scrubbed.** `POST /api/backtest/stepper` records the whole run in a single pass over the cached bars (one snapshot per trading day); `GET .../timeline` returns every day plus the full ledger; `POST .../step` only moves a cursor, so forward / backward / jump all cost the same:

   ```bash
   SID=$(curl -s localhost:8899/api/backtest/stepper -H 'Content-Type: application/json' \
     -d '{"symbol":"300750.SZ","strategyId":"ma-cross","engine":"backtrader"}' | jq -r .sessionId)
   curl -s localhost:8899/api/backtest/stepper/$SID/timeline | jq '.rows[0:3]'
   curl -s localhost:8899/api/backtest/stepper/$SID/step -H 'Content-Type: application/json' \
     -d '{"action":"jump","index":900}'
   ```

   On a 922-bar run: the recording pass takes ~1.9 s (the same cost as the batch backtest), the timeline payload is ~200 KB, a jump is ~10 µs server-side, and re-opening the same simulation hits the on-disk recording and returns in ~20 ms. Each day carries the decision, the fills, cash / position, mark-to-market equity, the indicator snapshot and a ChanLun summary, so the UI can show what happened on every single day without recomputing anything.

### Rust Backtest Engine (barter-rs)

The pool backtest also runs on a Rust engine built on [barter-rs](https://github.com/barter-rs/barter-rs)
0.14 — the open-source event-driven framework for live trading and backtesting. The split of
responsibilities is the point:

```text
public/index-members.*.json + .cache/klines/*.json
        │  pool members + cached daily bars
        ▼
   Rust data layer ──► barter Engine (HistoricalClock + EngineState)
                             │  MarketEvent<Candle>, one per symbol per day
                             ▼
                       AlgoStrategy ──► Strategy::on_day(ctx) -> Signal
                             │              BUY / SELL / HOLD + amount
                             ▼
                       OrderRequestOpen ──► A-share execution layer
                                           (lots · T+1 · limits · fees)
                             │
                             ▼
   DayRow recorder ◄── fills reported back as AccountEvent
```

**Why barter-rs.** It is the actively maintained Rust framework that actually ships an event
loop, pluggable strategy + execution, position tracking and a statistics package. Its own
`MockExchange` fills at the requested price and settles in quote currency only, so it cannot
express 100-share lots, T+1, price limits, stamp duty or transfer fees. So the engine is
barter's and the venue is `AShareBroker` — barter is designed for exactly this swap.

| Piece | Where | Role |
| --- | --- | --- |
| Data feed | `engine-rs/src/data.rs` | pool members + cached bars → aligned trading calendar |
| Strategy contract | `engine-rs/src/strategy.rs` | `on_day(&DayContext) -> Signal` (BUY/SELL/HOLD + amount) |
| Built-ins | `engine-rs/src/strategies.rs` | `ma-cross`, `donchian-breakout`, `rsi-reversion`, `momentum` |
| Engine adapter | `engine-rs/src/barter_engine.rs` | `AlgoStrategy` + `Ledger` (`GlobalData`) + `BarState` (`InstrumentData`) |
| A-share execution | `engine-rs/src/barter_engine.rs` | lots / T+1 / limits / commission + stamp duty + transfer fee |
| Recorder | `engine-rs/src/barter_engine.rs` | one `DayRow` per trading day (decision, fills, cash, equity) |
| HTTP | `engine-rs/src/api.rs` | axum: record once, then scrub by index |

**Run it**

```bash
pnpm start      # builds the Rust engine if needed, then runs engine (:8901) + Vite together
```

`pnpm start` is the one-command path: it compiles `engine-rs` when the binary is missing **or
older than its sources**, reuses an engine already listening on `:8901`, runs both processes with
prefixed logs, and stops both on Ctrl+C. Run the halves separately when you need to:

```bash
cargo build --release --manifest-path engine-rs/Cargo.toml
./engine-rs/target/release/chanlun-engine-rs --port 8901   # or: pnpm engine
pnpm dev                                                   # Vite proxies /api/rust → :8901
```

Open `/simulation`, pick a pool / strategy / capital and hit 运行模拟. The engine records the
whole run in one pass (300 symbols × 923 days ≈ 1.3 s, ~1.3 MB gzipped); the page then plays
it back day by day — play/pause, step, scrub, per-day signals with reasons, fills,
cash / position / equity, and the equal-weight buy-and-hold benchmark.

**HTTP contract**

| Endpoint | Meaning |
| --- | --- |
| `GET /api/rust/health` | framework version + engine liveness |
| `GET /api/rust/strategies` | strategy registry + parameter specs |
| `GET /api/rust/pools` | 沪深300 / 中证500 sizes |
| `GET /api/rust/pool/coverage` | per-pool cached / missing / incomplete counts + usable date span |
| `POST /api/rust/pool/update` | start a pool refresh (`incremental` or `full`) |
| `GET /api/rust/pool/update/:id` | refresh progress (counters, current symbol, errors) |
| `POST /api/rust/sim` | record a run, returns the full timeline |
| `GET /api/rust/sim/:id` | replay a recorded run |
| `POST /api/rust/sim/:id/step` | move the cursor (`next` / `prev` / `jump`) |

**Pool data maintenance.** The engine reads the same `.cache/klines/*_1d_forward.json`
the web app uses, and keeps it current against the free Tencent quote endpoint:

* **incremental** — fetch the last 40 bars, compare them against the cache, append only the
  bars after the last cached date.
* **full refresh** — re-pull the whole series from 2023-01-01. Triggered automatically when an
  overlapping bar no longer matches (a dividend / split / rights issue re-bases the 前复权
  series, so *every* historical price shifts).

Both run **automatically before every simulation** — there is no "update data" button to
forget. `POST /api/rust/sim` first refreshes whatever the run actually needs (stale tails, plus
one full rebuild for any member whose history starts late and is not a known late listing), then
loads the pool. The sweep is capped by a 25 s budget and a circuit breaker, so a blocked or slow
quote endpoint degrades to "run on cached bars" with the reason reported in `refresh` rather than
turning a 1-second simulation into a multi-minute wait. Pass `autoRefresh: false` to skip it.

The ex-rights rule is the important one: appending across an ex-rights date would silently
splice two incompatible price scales and corrupt every backtest touching that symbol, so the
whole series is rebuilt instead of patched. Two implementation notes, both learned the hard way:

* the endpoint caps a response at **640 bars** but honours the `end` date, so a full refresh
  pages backwards from today rather than asking for "everything";
* it sits behind a WAF that answers **HTTP 501** once a burst is too fast, so requests are
  paced globally (~10 rps, 4 concurrent) and a run aborts after 10 consecutive failures
  instead of grinding through hundreds of doomed requests.

`coverage` reports an `incomplete` count for members whose history starts later than the
analysis window; the automatic sweep heals those once (a symbol that really did list late is
remembered as such, so it is not re-fetched every run).

**Writing a strategy** — one method; the framework hands you bars through today plus the
account and position, and takes back an intent:

```rust
impl Strategy for MyStrategy {
    fn id(&self) -> &'static str { "my-strategy" }

    fn on_day(&mut self, ctx: &DayContext<'_>) -> Signal {
        // ctx.bars is a prefix ending at ctx.date — no future bar is reachable.
        if ctx.position.shares > 0.0 && ctx.close() < ctx.sma(20).unwrap_or(0.0) {
            return Signal::sell_percent(100.0, "跌破 MA20");
        }
        if ctx.close() > ctx.highest_close(20).unwrap_or(f64::MAX) {
            return Signal::buy_percent(30.0, "创 20 日新高");
        }
        Signal::hold()
    }
}
```

Every fill follows the signal bar's close, 100-share lots, T+1 (shares bought today cannot be
sold today), limit-up / limit-down rejection (10% main board / 20% ChiNext & STAR / 30% BSE),
commission 0.025% (min ¥5) + stamp duty 0.05% on sells + transfer fee 0.001%.

Position sizing is capital-driven, not universe-driven: the slot is `capital ÷ N`, where `N` is
how many names that capital can actually hold at a typical one-lot cost (median lot price × 1.05),
capped by the universe **and** by the minimum-position floor. With ¥5M across 300 names that is the
full 300 at ¥16.7k each; with ¥20k it becomes 4 names at ¥5k each, so a small account still trades
instead of producing zero fills.

**Minimum position size (hard rule).** A newly opened position is never smaller than
`minPositionValue` (default **¥5,000**, `0` disables it). The strategy's own sizing is treated as a
target: it is raised to the floor, rounded to whole lots (rounding *up* when flooring would drop
below the floor), and the fill is rejected if available cash would shrink it under the floor. Names
whose single lot exceeds 1.5× the slot are skipped as `一手 ... 超出仓位上限`, and a spent account
reports `现金不足` — never a silent runt position.

**Troubleshooting:** an error like `Cannot find module '.../node_modules/.pnpm/vite.../dist/node/chunks/dep-*.js'` means `node_modules` was checked out as a (possibly self-referential) symlink, which breaks module resolution. `node_modules` is never tracked; remove the bad link and reinstall:
```bash
rm -rf node_modules && pnpm install
```

### Usage

1. Enter a stock code (e.g., `600519` for Kweichow Moutai) in the search bar
2. The chart automatically processes: K-line inclusion merging → fraction detection → stroke calculation → segment extraction → hub identification
3. Toggle overlays: strokes, segments, hubs, fractions, MA, Bollinger Bands, MACD
4. Use the AI Advisor panel on the right to ask questions about trends, buy/sell points, divergences, and strategies
5. Configure API keys via the Settings modal (gear icon)

### Daily Report (CLI)

A scheduled daily report system generates automated ChanLun analysis for selected stocks.

**How it works:**
- A GitHub Actions workflow ([`.github/workflows/daily-report.yml`](.github/workflows/daily-report.yml)) runs every trading day at 19:30 CST
- Fetches K-line data via TickFlow API, computes ChanLun structures, and generates AI-powered analysis reports
- Searches stock news via Exa API and summarizes market hotspots
- Outputs Markdown reports and sends notifications (ServerChan/Email/GitHub Issue)

**Configuration:**
| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_OPENCODE_API_KEY` | Yes | OpenCode API key for AI analysis ([https://opencode.ai](https://opencode.ai)) |
| `EXA_API_KEY` | No | Exa API key for news search ([https://exa.ai](https://exa.ai)) |
| `SERVERCHAN_KEY` | No | ServerChan key for WeChat push ([https://sct.ftqq.com](https://sct.ftqq.com)) |
| `RESEND_API_KEY` | No | Resend API key for email notifications ([https://resend.com](https://resend.com)) |

**Manual run:**
```bash
pnpm exec tsx scripts/chanlun-report.ts --stocks 000001,600519 --notify console
```

### Keywords

`ChanLun` `缠论` `Technical Analysis` `Stock Analysis` `A-Share` `Fraction` `Stroke` `Segment` `Hub` `Divergence` `Buy/Sell Points` `AI Analysis` `Gemini` `OpenRouter` `Lightweight Charts` `React` `TypeScript` `Vite` `Tailwind CSS` `Quantitative Trading`

---

## 中文

### 项目简介

缠论量化工作台是一款基于 **缠论 (ChanLun)** 理论构建的 A 股技术分析平台。通过自动识别分型、笔、线段、中枢等核心结构, 结合 AI 大模型进行多因子量化解读, 帮助交易者客观理解市场走势、定位关键支撑压力位并识别潜在买卖点。

### 核心功能

- **缠论结构识别** — 严格遵循缠论原始定义, 自动识别顶底分型、连接成笔、合并笔为线段、并提取多级别中枢结构
- **买卖点与背驰识别** — 基于一买 / 二买 / 三买与对应卖点判定, 自动检测顶底背驰, 输出可执行的结构化交易信号
- **AI 多因子分析** — 通过 Google Gemini 或 OpenRouter 路由, 将完整结构化上下文注入提示词, 输出专业中文量化报告
- **技术指标叠加** — MA5/MA20 均线、布林带、MACD, 可交互式叠加到 K 线图上
- **股票信息面板** — 展示行业、实际控制人、减持计划公告等关键信息
- **回测管理器** — 本地浏览器持久化回测任务, 支持 Supabase 云端账户同步
- **策略模拟回测** — 服务端运行策略回测 (信号当日收盘价成交, 不使用未来数据; 佣金 + 印花税 + 过户费; 涨跌停按收盘价拦截; 固定止损为盘中止损单, T+1 当日买入不可卖), 输出绩效概览、权益曲线与逐笔账本, 并在价格 K 线图上标注每笔买卖成交 (红↑ 买入 / 绿↓ 卖出); 单标的模式运行中实时展示阶段进度 (拉取 K 线 → 回测计算)
- **双回测引擎** — 同一套 `BUY / SELL / HOLD + 数量` 策略契约可跑在零依赖的 native 循环上, 也可跑在开源框架 [backtrader](https://www.backtrader.com/) 上 (`engine: "backtrader"`); 两者都按信号当日收盘价成交并遵守 A 股规则 (T+1、100 股一手、涨跌停拦截、佣金 + 印花税 + 过户费, 可选固定止损), 且有逐笔一致性测试钉住两边账本
- **逐日模拟** — 用缓存的 K 线一次性录完每个交易日 (策略决策 / 成交 / 现金持仓 / 收盘盯市权益 / 指标快照 / 缠论摘要), 之后拖动、单步、跳转全是索引查找而不是重跑策略; 录制结果落盘缓存, 再次打开同一段模拟几乎瞬时
- **选股池等权回测** — 对沪深300 / 中证500 全池等权回测同一策略, 输出组合权益曲线、等权买入持有基准、KPI 卡片、成交账本与逐标的排行
- **Rust 回测引擎** — 同一套选股池回测跑在 [barter-rs](https://github.com/barter-rs/barter-rs) 0.14 上: 框架逐日喂池内数据, 策略回答 `BUY / SELL / HOLD + 数量`, A 股撮合层负责成交, 整段模拟一次录完后在 `/simulation` 逐日回放
- **默认市场基准数据** — 组合模拟默认自带市场环境上下文 (不参与选股): 中证指数官网的沪深300全收益 H00300、沪深300 000300、中证500 000905、中证1000 000852、中证全债 H11001、沪深300 PE, 以及东方财富的 10Y / 2Y 国债收益率与 10Y-2Y 期限利差, 并派生股权风险溢价 ERP (100/PE − 10Y); 基准默认取沪深300全收益, 可切换沪深300价格指数或池内等权买入持有; 数据落盘缓存 `.cache/market/`, TTL 2 小时, 接口失败时自动回退旧缓存
- **搜索历史** — 持久化股票搜索记录, 预设热门股票快速访问
- **可调整 AI 侧栏** — 可拖拽调整宽度的 AI 顾问面板, 移动端自适应布局
- **暗色主题** — 精致暗色 UI, 流畅动效

### 技术栈

| 层级 | 技术 |
|------|------|
| 框架 | React 19 + TypeScript 5.8 |
| 构建 | Vite 6 + Tailwind CSS 4 |
| 图表 | Lightweight Charts (TradingView) |
| 可视化 | D3.js + Recharts |
| 图标与动效 | Lucide React + Motion |
| AI | Google Gemini / OpenRouter |
| 数据 | 腾讯行情 (免费, 免 Key) · TickFlow API (兜底) |
| 认证与数据库 | Supabase |

### 快速开始

**前置条件:** Node.js 18+

1. **克隆仓库**
   ```bash
   git clone https://github.com/huhk345/chanlun-stock-analyzer.git
   cd chanlun-stock-analyzer
   ```

2. **安装依赖**
   ```bash
   pnpm install
   ```

3. **配置环境变量** — 将 `.env.example` 复制为 `.env.local` 并填入 API Key:
   ```bash
   cp .env.example .env.local
   ```
   | 变量 | 是否必须 | 说明 |
   |------|----------|------|
   | `VITE_TICKFLOW_API_KEY` | 否 | TickFlow API Key — 仅作 K 线兜底数据源 (默认腾讯, 免 Key) |
   | `KLINE_SOURCE` | 否 | K 线数据源: `tencent` (默认) 或 `tickflow` |
   | `TENCENT_RPS` | 否 | 腾讯行情全局限速 (次/秒, 默认 15) |
   | `KLINE_ADJUST_TOLERANCE` | 否 | 增量 K 线复权校验阈值 (相对偏差, 默认 `0.0005`); 超阈值判定除权并全量刷新 |
   | `VITE_GEMINI_API_KEY` | 是 | Google Gemini API Key, 从 [AI Studio](https://aistudio.google.com/app/apikey) 获取 |
   | `VITE_OPENROUTER_API_KEY` | 否 | OpenRouter API Key, 支持多种 AI 模型 |

4. **启动开发服务器**
   ```bash
   pnpm run dev
   ```

5. 在浏览器中打开 [http://localhost:8888](http://localhost:8888)

6. **启动分析后端**
   ```bash
   pnpm server        # 分析/回测后端, 监听 :8899
   ```
   逐日模拟 (选股池回测的「逐日」视图) 走同一套接口: `POST /api/backtest/stepper` 用缓存的 K 线**一次性录完**整段模拟 (每个交易日一份快照), `GET .../timeline` 一次取回每一天 + 全量账本, `POST .../step` 只移动游标 —— 前进、后退、跳转都是索引查找, 不再重跑策略。
   ```bash
   SID=$(curl -s localhost:8899/api/backtest/stepper -H 'Content-Type: application/json' \
     -d '{"symbol":"300750.SZ","strategyId":"ma-cross","engine":"backtrader"}' | jq -r .sessionId)
   curl -s localhost:8899/api/backtest/stepper/$SID/step -H 'Content-Type: application/json' \
     -d '{"action":"jump","index":900}'
   ```
   922 根 K 线实测: 录制 ~1.9s (与批量回测同价), 时间轴 200KB, 跳转 ~10µs, 再次打开命中磁盘录制 ~20ms。每一天都带着决策、成交、现金/持仓、收盘盯市权益、指标快照与缠论摘要。

   > **后端已不在本仓库内。** `server-py/` 已删除; 前端仍然通过 `/api` 与 `/ws` 访问 `:8899` 上的分析 / 回测服务端, 需另行启动 (下面的接口契约不变)。

   **两套可互换的回测引擎** —— 策略契约 (`decide(ctx) -> {action, amount, reason}`, `action` 为 BUY / SELL / HOLD, `amount` 支持 cash / shares / percent) 与引擎无关, 每次请求用 `engine` 选一个:

   | `engine` | 实现 | 说明 |
   | --- | --- | --- |
   | `native` (默认) | 手写逐根循环 | 零依赖; 账本锚定 TypeScript golden 用例 |
   | `backtrader` | 开源 [backtrader](https://www.backtrader.com/) | 撮合/委托模型交给框架; 需 `pip install backtrader` |

   ```bash
   pip install backtrader                       # 可选, 仅 engine=backtrader 需要
   curl -s localhost:8899/api/backtest/run -H 'Content-Type: application/json' \
     -d '{"symbol":"300750.SZ","strategyId":"ma-cross","engine":"backtrader"}'
   ```

   两套引擎都按信号当根收盘价成交 (backtrader 侧用 `broker.set_coc(True)`), 都执行 100 股整手、T+1、涨跌停拦截与同一套佣金 + 印花税 + 过户费模型, 返回同一个 `BacktestResult` JSON —— 换引擎只换能力, 不换数字。

   **K 线由策略自己保管** —— backtrader 适配器维护一份只增不改的 `list[Kline]`, 每根 K 线都从这份缓冲重算缠论结构与指标快照, 再作为 `ctx.klines` / `ctx.chanlun` / `ctx.indicators` 交给策略。策略因此不需要回读数据源, 也物理上拿不到未来数据:

   ```python
   def decide(ctx):
       bars = ctx.klines                     # 截至当根的全部 K 线
       if len(bars) < 30 or not ctx.chanlun.hubs:
           return Decision.hold()
       hub = ctx.chanlun.hubs[-1]
       close = ctx.current_kline.close
       if close > hub.zg and ctx.params["MA5"] > ctx.params["MA20"]:
           return Decision(action="BUY", amount={"unit": "shares", "value": 1000},
                           reason="站上中枢 + 均线多头")
       if close < hub.zd and ctx.position.shares > 0:
           return Decision(action="SELL", amount={"unit": "percent", "value": 100},
                           reason="跌破中枢")
       return Decision.hold()                # HOLD = 持仓不动
   ```

### Rust 回测引擎 (barter-rs)

选股池回测还有一条 Rust 路径: 引擎是开源事件驱动框架 [barter-rs](https://github.com/barter-rs/barter-rs)
0.14, 职责边界就是这次要验证的东西 —— **框架喂数据, 策略算信号, 撮合按 A 股规则**:

```text
public/index-members.*.json + .cache/klines/*.json
        │  池成分 + 已缓存的日线
        ▼
   Rust 数据层 ──► barter Engine (HistoricalClock + EngineState)
                        │  每个标的每个交易日一个 MarketEvent<Candle>
                        ▼
                  AlgoStrategy ──► Strategy::on_day(ctx) -> Signal
                        │             BUY / SELL / HOLD + 数量
                        ▼
                  OrderRequestOpen ──► A 股撮合层
                                      (整手 · T+1 · 涨跌停 · 费用)
                        │
                        ▼
   逐日录制器 ◄── 成交以 AccountEvent 回报给引擎
```

**为什么是 barter-rs。** 它是目前仍在维护、且真正提供事件循环 / 可插拔策略与执行 / 持仓跟踪 /
绩效统计的 Rust 框架。但它自带的 `MockExchange` 按请求价成交、且只用计价货币结算 (卖出不返钱),
无法表达 100 股整手、T+1、涨跌停、印花税与过户费 —— 所以引擎用 barter 的, 交易所换成
`AShareBroker` (barter 本身就是为这种替换设计的)。

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 数据层 | `engine-rs/src/data.rs` | 池成分 + 缓存日线 → 对齐的交易日历 |
| 策略契约 | `engine-rs/src/strategy.rs` | `on_day(&DayContext) -> Signal` (BUY/SELL/HOLD + 数量) |
| 内置策略 | `engine-rs/src/strategies.rs` | `ma-cross`、`donchian-breakout`、`rsi-reversion`、`momentum` |
| 引擎适配 | `engine-rs/src/barter_engine.rs` | `AlgoStrategy` + `Ledger`(GlobalData) + `BarState`(InstrumentData) |
| A 股撮合 | `engine-rs/src/barter_engine.rs` | 整手 / T+1 / 涨跌停 / 佣金 + 印花税 + 过户费 |
| 逐日录制 | `engine-rs/src/barter_engine.rs` | 每个交易日一行 (决策 / 成交 / 现金 / 权益) |
| HTTP | `engine-rs/src/api.rs` | axum: 一次录完, 之后按索引拖动 |

**启动**

```bash
pnpm start      # 缺二进制/源码有改动时自动编译, 然后同时拉起引擎 (:8901) 与 Vite
```

`pnpm start` 是一条命令的路径: 二进制不存在**或比源码旧**时自动 `cargo build --release`;
若 `:8901` 上已有引擎在跑则直接复用; 两个进程的日志带前缀输出, Ctrl+C 一起停。
需要单独跑时:

```bash
cargo build --release --manifest-path engine-rs/Cargo.toml
./engine-rs/target/release/chanlun-engine-rs --port 8901   # 或: pnpm engine
pnpm dev                                                   # Vite 把 /api/rust 代理到 :8901
```

打开 `/simulation`, 选池 / 策略 / 资金, 点「运行模拟」。引擎用缓存的日线**一次录完**整段
(300 只 × 923 个交易日 ≈ 1.3s, gzip 后约 1.3MB), 页面随后逐日回放: 播放 / 暂停 / 单步 /
拖动, 每日信号带理由、成交、现金持仓权益, 以及与等权买入持有基准的对比曲线。

**接口**

| 接口 | 说明 |
| --- | --- |
| `GET /api/rust/health` | 框架版本 + 引擎存活 |
| `GET /api/rust/strategies` | 策略注册表 + 参数定义 |
| `GET /api/rust/pools` | 沪深300 / 中证500 标的数 |
| `GET /api/rust/pool/coverage` | 各池已缓存 / 缺失 / 历史不全 数量 + 可用区间 |
| `POST /api/rust/pool/update` | 发起池数据更新 (`incremental` 增量 / `full` 全量) |
| `GET /api/rust/pool/update/:id` | 更新进度 (计数 / 当前标的 / 错误) |
| `POST /api/rust/sim` | 录制一整段模拟, 返回完整时间轴 |
| `GET /api/rust/sim/:id` | 取回已录制的模拟 |
| `POST /api/rust/sim/:id/step` | 移动游标 (`next` / `prev` / `jump`) |

**池数据维护.** 引擎读的就是前端在用的 `.cache/klines/*_1d_forward.json`, 并用免费的腾讯行情
接口保持更新, 两种模式:

* **增量** —— 只取最近 40 根, 与缓存逐根比对, 仅追加最后一根之后的交易日;
* **全量刷新** —— 从 2023-01-01 重新拉整段。重叠区间任何一根对不上就会自动触发
  (分红 / 送转 / 配股都会让前复权基准整体平移, 每一根历史价格都变)。

两者都在**每次模拟前自动执行** —— 没有需要记得点的「更新数据」按钮。`POST /api/rust/sim` 会先补
本次真正用到的数据 (落后的尾部, 以及历史起点偏晚且不是新股上市的标的做一次全量重建), 再加载池。
整个更新有 25s 时间预算和熔断保护, 行情接口被限流或变慢时会退化为「直接用缓存跑」, 原因写在
`refresh` 字段里, 而不是把 1 秒的模拟拖成几分钟。传 `autoRefresh: false` 可跳过。

除权规则是关键: 跨除权日直接追加等于把两套不可比的价格尺度拼在一起, 会让该标的的每一次回测
都失真 —— 所以宁可整段重建, 也不做局部补丁。两个实现细节都是踩过坑才定下来的:

* 该接口单次最多返回 **640 根**, 但会认 `end` 日期, 所以全量刷新是从今天往前**翻页**拉, 而不是
  一次性请求「全部」;
* 它前面挂着 WAF, 突发太快会直接返回 **HTTP 501** 的 HTML 拦截页 —— 因此请求全局限速
  (约 10 次/秒, 4 并发), 且连续失败 10 个就中止整次任务, 而不是硬跑完几百个注定失败的请求。

`coverage` 会给出 `incomplete` 计数 (历史起点晚于分析窗口的标的数); 自动更新会把这类标的补一次,
真正的新股则记成 `at_ipo`, 之后不再重复拉取。

**写一个策略** —— 只实现一个方法, 框架交给你截至今日的 K 线、账户和持仓, 你交回一个意图:

```rust
impl Strategy for MyStrategy {
    fn id(&self) -> &'static str { "my-strategy" }

    fn on_day(&mut self, ctx: &DayContext<'_>) -> Signal {
        // ctx.bars 是截止 ctx.date 的前缀, 物理上拿不到未来 K 线。
        if ctx.position.shares > 0.0 && ctx.close() < ctx.sma(20).unwrap_or(0.0) {
            return Signal::sell_percent(100.0, "跌破 MA20");
        }
        if ctx.close() > ctx.highest_close(20).unwrap_or(f64::MAX) {
            return Signal::buy_percent(30.0, "创 20 日新高");
        }
        Signal::hold()
    }
}
```

成交口径: 信号当根收盘价、100 股整手、T+1 (当日买入不可卖)、涨跌停拦截 (主板 10% / 创业板·
科创板 20% / 北交所 30%)、佣金万 2.5 (最低 5 元) + 卖出印花税千 0.5 + 过户费万 0.1。
仓位上限由资金决定而不是由标的数决定: 上限 = 资金 ÷ N, 其中 N 是这笔钱按「一手成本中位数 × 1.05」
真正能同时持有几只 (不超过标的数, 也受最小开仓金额约束)。500 万配 300 只 → 300 只 × 1.67 万;
2 万 → 4 只 × 5000 元, 小资金也能成交, 而不是所有信号都算成 0 股。

**最小开仓金额 (硬规则).** 每次开仓金额不低于 `minPositionValue` (默认 **5000 元**, 传 0 关闭)。
策略给出的仓位只当作目标值: 低于下限时抬到下限, 再按整手取整 (向下取整会跌破下限时改为向上补一手),
撮合阶段若因现金不足被削减到下限以下则整笔拒绝。一手就超过仓位上限 1.5 倍的高价股直接跳过
(`一手 ... 超出仓位上限`), 钱花完了报 `现金不足` —— 任何情况下都不会开出一个低于下限的碎仓。
组合共用同一现金账户 —— 连一手都买不起的
信号会明确记成 `仓位不足一手`, 而不是静默丢弃。

**疑难排查:** 出现 `Cannot find module '.../node_modules/.pnpm/vite.../dist/node/chunks/dep-*.js'` 报错，通常是因为 `node_modules` 被检出成了（可能自引用的）符号链接，导致模块解析失败。仓库不跟踪 `node_modules`；删除坏链接后重装即可:
```bash
rm -rf node_modules && pnpm install
```

### 使用方法

1. 在搜索栏输入股票代码 (如 `600519` 贵州茅台)
2. 图表自动处理: K线包含关系合并 → 分型检测 → 笔的计算 → 线段提取 → 中枢识别
3. 切换叠加层: 笔、线段、中枢、分型、均线、布林带、MACD
4. 使用右侧 AI 顾问面板, 提问趋势、买卖点、背驰、策略等问题
5. 通过设置弹窗 (齿轮图标) 配置 API Key

### 关键词

`缠论` `ChanLun` `技术分析` `股票分析` `A股` `分型` `笔` `线段` `中枢` `背驰` `买卖点` `AI分析` `Gemini` `OpenRouter` `Lightweight Charts` `React` `TypeScript` `Vite` `Tailwind CSS` `量化交易`

---

### 日报系统 (CLI)

自动缠论日报系统，定时生成选定个股的缠论分析报告。

**工作流程：**
- GitHub Actions 工作流 ([`.github/workflows/daily-report.yml`](.github/workflows/daily-report.yml)) 每个交易日 19:30 (CST) 自动执行
- 通过 TickFlow API 获取 K 线数据，计算缠论结构，调用 AI 生成分析报告
- 通过 Exa API 搜索个股新闻并总结市场热点
- 输出 Markdown 报告，支持 ServerChan/邮件/GitHub Issue 通知

**环境变量：**
| 变量 | 必须 | 说明 |
|------|------|------|
| `VITE_OPENCODE_API_KEY` | 是 | OpenCode API Key, 用于 AI 分析 ([https://opencode.ai](https://opencode.ai)) |
| `EXA_API_KEY` | 否 | Exa API Key, 用于新闻搜索 ([https://exa.ai](https://exa.ai)) |
| `SERVERCHAN_KEY` | 否 | ServerChan Key, 用于微信推送 ([https://sct.ftqq.com](https://sct.ftqq.com)) |
| `RESEND_API_KEY` | 否 | Resend API Key, 用于邮件通知 ([https://resend.com](https://resend.com)) |

**手动运行：**
```bash
pnpm exec tsx scripts/chanlun-report.ts --stocks 000001,600519 --notify console
```

---

## Disclaimer

This tool is for educational and research purposes only. It does not constitute any investment advice. Investment involves risk; please exercise caution.

本工具仅供学习研究使用, 不构成任何投资建议, 投资有风险, 入市需谨慎。
