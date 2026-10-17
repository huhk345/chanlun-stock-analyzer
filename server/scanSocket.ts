/**
 * 缠论买卖点扫描的 WebSocket 协议处理。
 *
 * 前端只发 5 种消息 (ping / cache / scan / cancel), 后端负责:
 *   - cache: 直接回磁盘缓存快照, 页面秒开, 不产生任何上游请求
 *   - scan:  交给扫描引擎 (server/scan.ts) 拉数据 + 算缠论, 增量推送 rows/progress
 *   - cancel: 中断当前连接挂着的那次扫描
 * 所有非法输入都在这里被过滤/兜底, 不让异常冒到 socket 层。
 *
 * 浏览器不直接访问任何行情上游 (腾讯 ifzq):
 * 全量扫描都在服务端完成, 复用同一份数据层与评估口径。
 */
import type { WebSocketPeer } from './ws.ts';
import { cancelScan, getCacheSnapshot, requestScan, type ScanJob } from './scan.ts';
import { isAshareSymbol } from '../src/utils/symbols.ts';
import type {
  IndexId,
  ScanClientMessage,
  ScanServerMessage,
  ScanTimeframe,
} from '../src/types/scan.ts';

export const WS_PATH = '/ws';

function isTimeframe(v: unknown): v is ScanTimeframe {
  return v === 'daily' || v === 'weekly';
}

function isIndexId(v: unknown): v is IndexId {
  return v === 'hs300' || v === 'zz500';
}

export function handleScanConnection(peer: WebSocketPeer): void {
  /** 当前连接订阅的扫描任务 (用于中途接入重放 / 定向中断) */
  let job: ScanJob | null = null;
  /** 由本连接新建的任务 (只有自己的任务才允许被本连接的换周期/强制重扫打断) */
  let ownedJob: ScanJob | null = null;

  const send = (msg: ScanServerMessage) => peer.send(JSON.stringify(msg));

  const listener = (msg: ScanServerMessage) => {
    if (msg.type === 'done' && job && msg.scanId === job.id) {
      job = null;
      ownedJob = null;
    }
    send(msg);
  };

  peer.onMessage = raw => {
    let msg: ScanClientMessage;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
        throw new Error('missing type');
      }
      msg = parsed as ScanClientMessage;
    } catch {
      send({ type: 'error', code: 'bad-message', message: '无法解析的 WebSocket 消息' });
      return;
    }

    switch (msg.type) {
      // ---------------------------------------------------------------------
      // 缠论买卖点扫描 (server/scan.ts)
      // ---------------------------------------------------------------------
      case 'ping':
        send({ type: 'pong' });
        return;

      case 'cache': {
        const timeframe = isTimeframe((msg as { timeframe?: unknown }).timeframe)
          ? (msg as { timeframe: ScanTimeframe }).timeframe
          : 'daily';
        void getCacheSnapshot(timeframe)
          .then(snapshot => send({ type: 'cache', timeframe, ...snapshot }))
          .catch(err =>
            send({
              type: 'error',
              code: 'cache-failed',
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        return;
      }

      case 'scan': {
        const body = msg as { timeframe?: unknown; indexes?: unknown; custom?: unknown; force?: unknown };
        const timeframe = isTimeframe(body.timeframe) ? body.timeframe : 'daily';
        const indexes = Array.isArray(body.indexes) ? body.indexes.filter(isIndexId) : [];
        const custom = Array.isArray(body.custom) ? body.custom.filter(isAshareSymbol) : [];
        const force = body.force === true;

        if (job) {
          const prev = job;
          // 同周期非强制: 任务还在跑, 重新订阅即可重放当前进度与已产出的结果 (断线重连场景)
          if (!prev.done && !prev.cancelled && prev.timeframe === timeframe && !force) {
            prev.unsubscribe(listener);
            prev.subscribe(listener);
            return;
          }
          // 换了周期或强制重扫: 只中断本连接自己发起的任务, 旁观者不打断别人的扫描
          prev.unsubscribe(listener);
          if (prev === ownedJob) prev.cancel();
          ownedJob = null;
          job = null;
        }

        const started = requestScan({ timeframe, indexes, custom, force }, listener);
        if (!started.job) return; // 拒绝原因已由 requestScan 通过 listener 回传
        job = started.job;
        ownedJob = started.attached ? null : started.job;
        return;
      }

      case 'cancel':
        cancelScan(job);
        job = null;
        ownedJob = null;
        return;

      default:
        send({ type: 'error', code: 'unknown-message', message: `不支持的消息类型: ${(msg as { type: string }).type}` });
    }
  };

  // 连接断开只取消订阅: 任务留在服务端继续跑完并落盘缓存, 其他标签页仍可共享结果
  peer.onClose = () => {
    job?.unsubscribe(listener);
    job = null;
    ownedJob = null;
  };
}
