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

6. **Node analysis backend** — the ChanLun 买卖点扫描 (BS-point scan) run server-side instead of in-browser:
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

   **缠论买卖点扫描走 WebSocket `/ws`** — the browser only sends a scan request; the server fetches the K-lines, computes the ChanLun structures / BS-points, builds the signal rows and streams them back over the socket:
   ```text
   browser --{type:'scan', timeframe, indexes, custom, force}--> server
   browser <--{scan-start | progress | rows | flows | done}------- server
   ```
   Server-side: K-lines are cached under `.cache/klines/`, scan results under `.cache/scan/{daily,weekly}.json` (an incremental scan only re-fetches symbols whose last bar is behind the expected latest trading day; a symbol whose data was already verified after that day's close — e.g. a long-suspended stock — is not re-fetched again that day), so repeat scans are instant and the browser keeps no cache of its own. Multiple tabs share one running scan; closing a tab does not stop the scan.
   The server-side K-line window is fixed to **2023-01-01 → latest** (daily and weekly), so scans, single-symbol backtests and pool backtests all analyze the same date range.

   Vite proxies both `/api` and `/ws` to the backend (`ws: true`). Override the backend address with `ANALYSIS_API_TARGET` (dev/preview proxy target), the HTTP base URL with `VITE_ANALYSIS_API_URL`, or the WebSocket URL with `VITE_ANALYSIS_WS_URL` (defaults to same-origin `/ws`).

   The single-stock analysis endpoints (`/api/chanlun/*`) still fall back to in-browser computation when the backend is down; the 买卖点扫描 requires the backend and shows a reconnect banner when the socket drops.

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
