/**
 * 缠论 Node 后端
 *
 * 前端把 K 线数据 POST 到这里, 由服务端完成:
 *   - 缠论结构计算 (合并K线/分型/笔/线段/中枢)
 *   - 三类买卖点识别 (一买/二买/三买 + 一卖/二卖/三卖)
 *   - K 线拉取: GET /api/klines 由服务端访问腾讯行情 (默认, 免 Key) 并以
 *     TickFlow 作兜底, 本地磁盘缓存 + 增量更新 (前端不再直连免费接口)
 *   - 买卖点扫描: WebSocket /ws 前端只下发扫描请求, 数据拉取、
 *     缠论计算、信号行生成与资金流补充全部在服务端完成, 结果增量推送回前端
 *
 * 启动: pnpm server   (默认端口 8899, 可用 PORT 覆盖)
 */
import http from 'node:http';
import type { Kline } from '../src/types/stock.ts';
import { computeStrokesAndBSPoints, runChanlunPipeline } from '../src/utils/chanlun.ts';
import { listStrategySummaries, loadBuiltinStrategies } from './strategies/index.ts';
import { findStrategySource, userStrategySource } from './strategySource.ts';
import {
  deleteStoredStrategy,
  getStoredStrategy,
  importStoredStrategies,
  listStoredStrategies,
  saveStoredStrategy,
  StrategyStoreError,
} from './strategyStore.ts';
import { getKlines } from './klines.ts';
import type { KlinePeriod } from '../src/utils/klineUtils.ts';
import { attachWebSocketServer } from './ws.ts';
import { handleScanConnection, WS_PATH } from './scanSocket.ts';
import { getCacheSnapshot } from './scan.ts';
import { runServerBacktest, type ServerBacktestInput } from './backtest.ts';
import {
  activeStepperSessions,
  closeStepperSession,
  createStepperSession,
  runAllStepperSession,
  stepStepperSession,
  stepperSessionTrades,
  type ServerStepperInput,
  type StepperAction,
} from './backtestStepper.ts';
import { beginProgress, getProgress, isProgressId, updateProgress } from './backtestProgress.ts';
import { getPoolBacktestJob, requestPoolBacktest } from './poolBacktest.ts';
import type { PoolBacktestInput } from '../src/types/poolBacktest.ts';
import {
  getPortfolioSimulationJob,
  requestPortfolioSimulation,
  simulationEngineHealth,
} from './portfolioSimulation.ts';
import type { PortfolioSimulationInput, PortfolioSignalQuery } from '../src/types/portfolioSimulation.ts';

const PORT = Number(process.env.PORT || 8899);

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

async function readJson<T = Record<string, unknown>>(req: http.IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { statusCode: 400 });
  }
}

function isKlineArray(v: unknown): v is Kline[] {
  return (
    Array.isArray(v) &&
    v.every(
      (k) =>
        k &&
        typeof k === 'object' &&
        typeof (k as Kline).date === 'string' &&
        typeof (k as Kline).close === 'number' &&
        typeof (k as Kline).high === 'number' &&
        typeof (k as Kline).low === 'number' &&
        typeof (k as Kline).volume === 'number',
    )
  );
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  if (req.method === 'GET' && path === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      uptime: process.uptime(),
      stepperSessions: activeStepperSessions(),
    });
    return;
  }

  if (req.method === 'GET' && path === '/api/klines') {
    const symbol = url.searchParams.get('symbol');
    if (!symbol) throw Object.assign(new Error('symbol required'), { statusCode: 400 });
    const period: KlinePeriod = url.searchParams.get('period') === '1w' ? '1w' : '1d';
    const rawCount = parseInt(url.searchParams.get('count') || '400', 10);
    const count = Math.min(Math.max(Number.isFinite(rawCount) ? rawCount : 400, 30), 5000);
    // count 为兼容参数: 实际返回窗口固定为 2023-01-01 至今 (见 klines.ts)
    const adjust = url.searchParams.get('adjust') || 'forward';
    const force = url.searchParams.get('refresh') === '1' || url.searchParams.get('force') === '1';
    const result = await getKlines(symbol, period, count, adjust, force);
    sendJson(res, 200, result);
    return;
  }

  // -------------------------------------------------------------------------
  // 策略注册表 (server/strategies 内置 + data/user-strategies 用户自建)
  //   GET    /api/strategies             元数据列表 (含 source: builtin|user)
  //   POST   /api/strategies             新建 / 覆盖用户策略 (代码沙箱校验)
  //   POST   /api/strategies/import      批量导入用户策略
  //   GET    /api/strategies/:id/source  策略源码 (内置片段 / 用户完整代码)
  //   DELETE /api/strategies/:id         删除用户策略
  // -------------------------------------------------------------------------
  if (req.method === 'GET' && path === '/api/strategies') {
    sendJson(res, 200, { strategies: await listStrategySummaries() });
    return;
  }

  if (req.method === 'POST' && path === '/api/strategies') {
    const body = await readJson<Record<string, unknown>>(req);
    try {
      const builtinIds = new Set((await loadBuiltinStrategies()).map((s) => s.id));
      const strategy = saveStoredStrategy(body as never, { reservedIds: builtinIds });
      sendJson(res, 201, { strategy });
    } catch (err) {
      const status = err instanceof StrategyStoreError ? err.statusCode : 400;
      sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (req.method === 'POST' && path === '/api/strategies/import') {
    const body = await readJson<unknown>(req);
    sendJson(res, 200, importStoredStrategies(body));
    return;
  }

  // 用户策略列表 (含完整代码, 供「管理策略」面板编辑)
  if (req.method === 'GET' && path === '/api/strategies/user') {
    sendJson(res, 200, { strategies: listStoredStrategies() });
    return;
  }

  // 内置策略源码 (返回策略所在文件的完整源码, 供前端「查看源码」弹窗展示)
  if (req.method === 'GET' && path.startsWith('/api/strategies/') && path.endsWith('/source')) {
    const id = decodeURIComponent(path.slice('/api/strategies/'.length, -'/source'.length));
    if (!id || id.includes('/')) throw Object.assign(new Error('invalid strategy id'), { statusCode: 400 });
    const builtin = findStrategySource(id);
    if (builtin) {
      sendJson(res, 200, builtin);
      return;
    }
    const stored = getStoredStrategy(id);
    if (stored) {
      sendJson(res, 200, userStrategySource(stored));
      return;
    }
    throw Object.assign(new Error(`策略源码未找到: ${id}`), { statusCode: 404 });
  }

  if (req.method === 'DELETE' && path.startsWith('/api/strategies/')) {
    const id = decodeURIComponent(path.slice('/api/strategies/'.length));
    if (!id || id.includes('/')) throw Object.assign(new Error('invalid strategy id'), { statusCode: 400 });
    if (!deleteStoredStrategy(id)) {
      sendJson(res, 404, { error: `用户策略不存在: ${id} (内置策略不可删除)` });
      return;
    }
    sendJson(res, 200, { deleted: id });
    return;
  }

  // 扫描缓存快照 (与 WebSocket `cache` 消息同源, 便于排障/脚本化读取)
  if (req.method === 'GET' && path === '/api/scan/cache') {
    const timeframe = url.searchParams.get('timeframe') === 'weekly' ? 'weekly' : 'daily';
    sendJson(res, 200, { timeframe, ...(await getCacheSnapshot(timeframe)) });
    return;
  }

  if (req.method === 'POST' && path === '/api/chanlun/analyze') {
    const body = await readJson<{ klines?: unknown }>(req);
    if (!isKlineArray(body.klines)) throw Object.assign(new Error('klines: Kline[] required'), { statusCode: 400 });
    sendJson(res, 200, runChanlunPipeline(body.klines));
    return;
  }

  if (req.method === 'POST' && path === '/api/chanlun/bspoints') {
    const body = await readJson<{ klines?: unknown }>(req);
    if (!isKlineArray(body.klines)) throw Object.assign(new Error('klines: Kline[] required'), { statusCode: 400 });
    // 买卖点只依赖 笔 (笔内部不依赖 线段/中枢), 跳过两遍计算保持扫描轻量
    sendJson(res, 200, computeStrokesAndBSPoints(body.klines));
    return;
  }

  // 单标的回测: 请求体可携带 progressId, 配合 GET /api/backtest/progress/:id
  // 轮询阶段进度 (拉取 K 线 / 运行回测), 请求本身仍是同步的
  if (req.method === 'POST' && path === '/api/backtest/run') {
    const body = await readJson<ServerBacktestInput & { progressId?: unknown }>(req);
    const progressId = isProgressId(body.progressId) ? body.progressId : null;
    if (progressId) beginProgress(progressId);
    try {
      const output = await runServerBacktest(
        body,
        progressId ? (update) => updateProgress(progressId, update) : undefined,
      );
      if (progressId) {
        updateProgress(progressId, {
          phase: 'done',
          message: `回测完成 (${output.klinesCount} 根 K 线)`,
          klines: output.klinesCount,
        });
      }
      sendJson(res, 200, output);
    } catch (err) {
      if (progressId) {
        updateProgress(progressId, {
          phase: 'error',
          message: '回测失败',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      const status = typeof err?.statusCode === 'number' ? err.statusCode : 400;
      sendJson(res, status, { error: err?.message ?? String(err) });
    }
    return;
  }

  // 单标的回测进度轮询 (内存条目, 过期自动清理)
  if (req.method === 'GET' && path.startsWith('/api/backtest/progress/')) {
    const progressId = path.slice('/api/backtest/progress/'.length);
    const progress = isProgressId(progressId) ? getProgress(progressId) : null;
    if (!progress) {
      sendJson(res, 404, { error: '进度不存在或已过期' });
      return;
    }
    sendJson(res, 200, progress);
    return;
  }

  // -------------------------------------------------------------------------
  // 逐步回测 (服务端会话, 策略与引擎都在服务端)
  //   POST   /api/backtest/stepper                建会话, 返回第 0 步
  //   POST   /api/backtest/stepper/:id/step       前进 / 后退 / 跳转
  //   POST   /api/backtest/stepper/:id/run-all    跑到结束, 返回完整报告
  //   GET    /api/backtest/stepper/:id/trades     当前账本
  //   DELETE /api/backtest/stepper/:id            结束会话
  // -------------------------------------------------------------------------
  if (req.method === 'POST' && path === '/api/backtest/stepper') {
    const body = await readJson<ServerStepperInput>(req);
    try {
      sendJson(res, 201, await createStepperSession(body));
    } catch (err) {
      const status = typeof err?.statusCode === 'number' ? err.statusCode : 400;
      sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (path.startsWith('/api/backtest/stepper/')) {
    const rest = path.slice('/api/backtest/stepper/'.length).split('/');
    const sessionId = rest[0];
    try {
      if (req.method === 'POST' && rest[1] === 'step') {
        const body = await readJson<{ action?: StepperAction; index?: number }>(req);
        const action: StepperAction = body.action ?? 'forward';
        sendJson(res, 200, stepStepperSession(sessionId, action, body.index));
        return;
      }
      if (req.method === 'POST' && rest[1] === 'run-all') {
        sendJson(res, 200, runAllStepperSession(sessionId));
        return;
      }
      if (req.method === 'GET' && rest[1] === 'trades') {
        sendJson(res, 200, stepperSessionTrades(sessionId));
        return;
      }
      if (req.method === 'DELETE' && rest.length === 1) {
        sendJson(res, 200, { closed: closeStepperSession(sessionId) });
        return;
      }
    } catch (err) {
      const status = typeof err?.statusCode === 'number' ? err.statusCode : 400;
      sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  // -------------------------------------------------------------------------
  // 股票池共享资金逐日组合模拟 (server/portfolioSimulation.ts + backtrader)
  //   GET  /api/simulation/health                 执行引擎 (backtrader) 健康检查
  //   POST /api/simulation/run                    发起 / 复用任务
  //   GET  /api/simulation/:id                    轮询进度 / 最终报告
  //   GET  /api/simulation/:id/signals            信号账本 (分页/筛选)
  //   GET  /api/simulation/:id/symbols            标的维度表现
  //   POST /api/simulation/:id/cancel             中断任务
  // -------------------------------------------------------------------------
  if (req.method === 'GET' && path === '/api/simulation/health') {
    sendJson(res, 200, simulationEngineHealth());
    return;
  }

  if (req.method === 'POST' && path === '/api/simulation/run') {
    const body = await readJson<PortfolioSimulationInput>(req);
    try {
      const { job, attached } = await requestPortfolioSimulation(body);
      sendJson(res, attached ? 200 : 202, { jobId: job.id, attached, job: job.view() });
    } catch (err: any) {
      const status = typeof err?.statusCode === 'number' ? err.statusCode : 400;
      sendJson(res, status, { error: err?.message ?? String(err), jobId: err?.jobId });
    }
    return;
  }

  if (path.startsWith('/api/simulation/')) {
    const rest = path.slice('/api/simulation/'.length).split('/');
    const job = getPortfolioSimulationJob(rest[0]);
    if (!job) {
      sendJson(res, 404, { error: '任务不存在或已过期' });
      return;
    }
    if (req.method === 'POST' && rest[1] === 'cancel') {
      job.cancel();
      sendJson(res, 200, job.view());
      return;
    }
    if (req.method === 'GET' && rest[1] === 'signals') {
      const query: PortfolioSignalQuery = {
        limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
        offset: url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : undefined,
        action: (url.searchParams.get('action') as PortfolioSignalQuery['action']) || 'ALL',
        symbol: url.searchParams.get('symbol') || undefined,
      };
      sendJson(res, 200, job.signalPage(query));
      return;
    }
    if (req.method === 'GET' && rest[1] === 'symbols') {
      sendJson(res, 200, { rows: job.symbolStats() });
      return;
    }
    if (req.method === 'GET' && rest.length === 1) {
      sendJson(res, 200, job.view());
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  // -------------------------------------------------------------------------
  // 旧版选股池等权汇总回测 (server/poolBacktest.ts) — 保留给 CLI 脚本兼容
  //   新前端使用 /api/simulation/*
  //   POST /api/backtest/pool                    发起任务
  //   GET  /api/backtest/pool/:id                轮询进度 / 最终报告
  //   GET  /api/backtest/pool/:id/symbol/:symbol 单只标的明细
  //   GET  /api/backtest/pool/:id/trades         全池逐笔成交 (按日期)
  //   POST /api/backtest/pool/:id/cancel         中断任务
  // -------------------------------------------------------------------------
  if (req.method === 'POST' && path === '/api/backtest/pool') {
    const body = await readJson<PoolBacktestInput>(req);
    try {
      const { job, attached } = await requestPoolBacktest(body);
      sendJson(res, attached ? 200 : 202, { jobId: job.id, attached, job: job.view() });
    } catch (err) {
      const status = typeof err?.statusCode === 'number' ? err.statusCode : 400;
      sendJson(res, status, { error: err?.message ?? String(err), jobId: err?.jobId });
    }
    return;
  }

  if (path.startsWith('/api/backtest/pool/')) {
    const rest = path.slice('/api/backtest/pool/'.length).split('/');
    const job = getPoolBacktestJob(rest[0]);
    if (!job) {
      sendJson(res, 404, { error: '任务不存在或已过期' });
      return;
    }
    if (req.method === 'POST' && rest[1] === 'cancel') {
      job.cancel();
      sendJson(res, 200, job.view());
      return;
    }
    if (req.method === 'GET' && rest[1] === 'symbol' && rest[2]) {
      const detail = job.symbolDetail(decodeURIComponent(rest[2]));
      if (!detail) {
        sendJson(res, 404, { error: `任务中不存在标的 ${rest[2]} 的结果` });
        return;
      }
      sendJson(res, 200, detail);
      return;
    }
    if (req.method === 'GET' && rest[1] === 'trades') {
      sendJson(res, 200, job.allTrades());
      return;
    }
    if (req.method === 'GET' && rest.length === 1) {
      sendJson(res, 200, job.view());
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = typeof err?.statusCode === 'number' ? err.statusCode : 500;
    console.error(`[server] ${req.method} ${req.url} -> ${status}:`, err?.message ?? err);
    sendJson(res, status, { error: err?.message ?? String(err) });
  });
});

// 缠论买卖点扫描: 浏览器只发扫描请求, 数据与计算都在服务端完成
attachWebSocketServer(server, WS_PATH, handleScanConnection);

server.listen(PORT, () => {
  console.log(`[chanlun-server] listening on http://localhost:${PORT} (scan websocket: ws://localhost:${PORT}${WS_PATH})`);
});
