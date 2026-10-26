# 项目长期笔记

## 架构

- 前端 `src/` (React 19 + Vite)；Node 服务端 `server/`（TS，`pnpm server`，:8899）。
- **Python 服务端 `server-py/`**：`server/` 的行为级移植（零第三方运行时依赖），
  同样监听 :8899，JSON 契约与前端完全一致，可直接替换。
  - 代码在 `chanlun_server/`，测试在 `tests/part1_unit|part2_integration|part3_e2e`。
  - 跑测试：`cd server-py && python3 run_tests.py`（或 `pnpm run test:py`）。
  - 与 TS 引擎的逐笔一致性由 `tests/part2_integration/test_ts_parity.py` 和
    `tests/fixtures/golden_300750_thermometer.json` 保证；改动撮合/缠论算法后必须两边都跑。
- 组合模拟（共享资金逐日）走 backtrader：`scripts/backtrader/runner.py`，仅 Node 端暴露 `/api/simulation/*`。

## 约定

- 回测成交模型：信号只用截至当根的数据、按当根收盘价成交、涨跌停按收盘价拦截、
  固定止损为盘中止损单、T+1 当日买入不可卖。任何改动都要通过「前缀不变性」测试。
- K 线窗口统一为 2023-01-01 至今；缓存格式 `.cache/klines/<symbol>_<period>_<adjust>.json`
  两端通用（字段：symbol/period/adjust/updatedAt/klines/historyComplete）。
- 金额/价格舍入按 JS 语义（`Math.round` 半远离零），Python 侧统一用 `numeric.round_half_up`，
  不要用内置 `round`（银行家舍入）。
