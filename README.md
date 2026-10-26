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
- **Portfolio Simulation (shared cash, day-by-day)** — The stock-pool mode was rebuilt on [backtrader](https://www.backtrader.com/): the TypeScript strategy emits one causal BUY/SELL/HOLD signal per symbol per day (only data up to that bar), and backtrader fills them against **one shared cash account** day by day. Same-day signals compete for cash, position caps and whole-lot sizing; A-share rules apply (T+1, 100-share lots, price-limit rejection, commission + stamp duty + transfer fee). Optional fixed stop-loss, equity curve vs. an equal-weight buy-and-hold benchmark, KPI cards, trade ledger, signal ledger, per-symbol table and open positions
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

   **Python backend (`server-py/`, alternative)** — the analysis + backtest server has been rewritten in Python with zero third-party runtime dependencies. Same paths, same JSON keys, same status codes, same execution model, so the frontend needs no change:
   ```bash
   pnpm run py:setup     # create server-py/.venv and install pytest
   pnpm run server:py    # python -m chanlun_server serve, listens on :8899
   pnpm run test:py      # three-part test suite
   ```
   The port is behavioural, not approximate: on the same cached bars both engines emit the same trade ledger, fees included (asserted against the TypeScript engine and a recorded real-data golden fixture).

   Tests are split into **three parts**, each a separate pytest invocation with its own marker, orchestrated by `server-py/run_tests.py`:

   | Part | Marker | Scope | Time |
   | --- | --- | --- | --- |
   | 1 · unit | `unit` | pure functions: ChanLun, fees, metrics, indicators, sandbox | ~0.5 s |
   | 2 · integration | `integration` | engine + registry + router + cache in-process; prefix invariance (no look-ahead), stepper parity, TS-engine parity | ~14 s |
   | 3 · e2e | `e2e` | real server subprocess, real HTTP, CORS, CLI | ~1.5 s |

   Not ported: the `/ws` scan socket, `/api/scan/cache` (explicit stub) and `/api/simulation/*` (backtrader already runs in Python). See [`server-py/README.md`](server-py/README.md) for the full matrix.

7. **Portfolio simulation engine (backtrader)** — the shared-cash stock-pool simulation executes day by day in Python, so a Python 3.10+ runtime is required:
   ```bash
   pnpm run sim:setup   # creates scripts/backtrader/.venv and installs backtrader 1.9.78.123
   ```
   The server auto-detects `scripts/backtrader/.venv/bin/python` (override with `BACKTRADER_PYTHON`). Endpoints: `GET /api/simulation/health`, `POST /api/simulation/run` (202 + jobId, or 409 when another simulation is running), `GET /api/simulation/:jobId`, `POST /api/simulation/:jobId/cancel`, `GET /api/simulation/:jobId/signals`, `GET /api/simulation/:jobId/symbols`. Headless run:
   ```bash
   pnpm run sim:cli -- --custom 600519.SH,000001.SZ --start 2023-01-01 --cash 100000 \
     --max-positions 5 --position-percent 20 --out .cache/simulation-report.json
   ```
   Signal generation is causal: each bar's strategy call only receives `klines.slice(0, i + 1)`, and fills happen at the signal day's close (`cerebro.broker.set_coc(True)`). The benchmark defaults to 沪深300全收益 (H00300); pass `--benchmark hs300` or `--benchmark equal_weight` to switch. Market baselines (中证全债 / 10Y yield / HS300 PE / ERP, …) are fetched in parallel with K-lines and cached under `.cache/market/`, so a failed fetch only degrades the benchmark, never aborts the run.

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
- **组合模拟 (共享资金逐日模拟)** — 选股池模式改用开源框架 [backtrader](https://www.backtrader.com/) 作为执行层: TS 策略按「只使用截至当日的历史数据」逐日给出买入/卖出/持有信号, backtrader 在**同一份共享资金**上逐日撮合 —— 同日信号竞争现金、受最大持仓数与单只仓位上限约束、整手买卖; 遵守 A 股规则 (T+1、100 股一手、涨跌停拦截、佣金 + 印花税 + 过户费), 可选固定止损; 输出组合 KPI、基准权益曲线、市场环境面板、成交账本、信号账本 (含被拦截原因)、逐标的统计与当前持仓, 支持 CSV 导出
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

6. **启动分析后端 + 组合模拟引擎**
   ```bash
   pnpm server        # 分析/回测后端, 监听 :8899
   pnpm run sim:setup # 首次运行: 创建 scripts/backtrader/.venv 并安装 backtrader
   ```
   组合模拟需要 Python 3.10+; 服务端默认使用 `scripts/backtrader/.venv/bin/python` (可用 `BACKTRADER_PYTHON` 覆盖), 健康检查为 `GET /api/simulation/health`。无界面跑一次:
   ```bash
   pnpm run sim:cli -- --custom 600519.SH,000001.SZ --start 2023-01-01 --cash 100000 \
     --max-positions 5 --position-percent 20 --out .cache/simulation-report.json
   ```
   信号是因果的: 每根 K 线的策略调用只拿到截至当根的 `klines.slice(0, i + 1)`, 成交按信号当日收盘价 (`cerebro.broker.set_coc(True)`) 撮合。基准默认沪深300全收益 (H00300), 可用 `--benchmark hs300` 或 `--benchmark equal_weight` 切换; 市场基准数据 (中证全债 / 10Y 国债 / 沪深300 PE / ERP 等) 与 K 线并行拉取并缓存在 `.cache/market/`, 拉取失败只降级基准, 不中断模拟。

7. **Python 后端 (`server-py/`, 可选替换)** — 分析与回测服务端已用 Python 重写, 运行时零第三方依赖; 路径、JSON 字段、状态码与撮合规则都与 Node 版一致, 前端无需改动:
   ```bash
   pnpm run py:setup   # 创建 server-py/.venv 并安装 pytest
   pnpm run server:py  # python -m chanlun_server serve, 监听 :8899
   pnpm run test:py    # 三阶段测试
   ```
   这是行为级移植而非近似实现: 同一份缓存 K 线在两侧引擎上跑出的逐笔成交 (含每笔费用)、期末权益与权益曲线长度完全一致 —— 由「与 TypeScript 引擎实时比对」和「真实行情 golden 用例」共同保证。

   测试按**三部分**拆分, 每部分是一个独立的 pytest 调用 (各自带 marker), 由 `server-py/run_tests.py` 统一调度并汇总:

   | 阶段 | marker | 覆盖范围 | 耗时 |
   | --- | --- | --- | --- |
   | 1 · 单元 | `unit` | 纯函数: 缠论 / 费用 / 指标 / 沙箱 | ~0.5s |
   | 2 · 集成 | `integration` | 引擎 + 注册表 + 路由 + 缓存, 进程内; 前缀不变性 (无未来数据)、单步与批量一致、与 TS 引擎逐笔一致 | ~14s |
   | 3 · 端到端 | `e2e` | 真实子进程 + 真实 HTTP: CORS、错误码、并发、CLI | ~1.5s |

   未移植: `/ws` 扫描通道、`/api/scan/cache` (返回明确占位)、`/api/simulation/*` (backtrader 本身已在 Python 侧)。完整对照见 [`server-py/README.md`](server-py/README.md)。

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
