/**
 * 个股当日主力资金流向 (东方财富) 服务端数据层。
 *
 * 原先由浏览器直连 push2delay.eastmoney.com, 扫描移到后端后一并搬过来:
 * 扫描完成后由后端按批拉取有信号标的的今日主力净流入, 通过 WebSocket 推给前端。
 */
import type { StockFlow } from '../src/types/scan.ts';

const EM_DELAY_BASE = 'https://push2delay.eastmoney.com';

/** 单批标的数 (东方财富 ulist 接口上限) */
const BATCH_SIZE = 60;

/** 单批请求超时 (ms): 上游卡住时不拖住扫描结果推送 */
const REQUEST_TIMEOUT_MS = 10_000;

/** symbolKey('600000.SH') -> 东方财富 secid ('1.600000') */
function secidOf(key: string): string {
  const dot = key.indexOf('.');
  const code = key.slice(0, dot);
  const ex = key.slice(dot + 1);
  return `${ex === 'SH' ? '1' : '0'}.${code}`;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : parseFloat(String(v)) || NaN);

/**
 * 批量获取个股当日主力资金流向。
 * 返回 symbolKey -> StockFlow; 单只失败/无数据的标的不会出现在结果中。
 */
export async function fetchStockFlowBatch(symbolKeys: string[]): Promise<Record<string, StockFlow>> {
  const out: Record<string, StockFlow> = {};

  for (let i = 0; i < symbolKeys.length; i += BATCH_SIZE) {
    const chunk = symbolKeys.slice(i, i + BATCH_SIZE);
    const url =
      `${EM_DELAY_BASE}/api/qt/ulist.np/get?fltt=2&invt=2` +
      `&secids=${chunk.map(secidOf).join(',')}&fields=f12,f62,f184`;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!resp.ok) continue;
      const json = await resp.json();
      const diff = json?.data?.diff;
      if (!Array.isArray(diff)) continue;

      // 返回项仅含 6 位代码, 需映射回带后缀的 symbolKey
      const byCode = new Map<string, string[]>();
      for (const k of chunk) {
        const code = k.split('.')[0];
        const list = byCode.get(code);
        if (list) list.push(k);
        else byCode.set(code, [k]);
      }
      for (const it of diff) {
        const keys = byCode.get(String(it.f12 || ''));
        const key = keys?.shift();
        if (!key) continue;
        const main = num(it.f62);
        if (isNaN(main)) continue; // ETF/指数等无资金流数据
        out[key] = { mainInflow: main, mainPercent: num(it.f184) || 0 };
      }
    } catch {
      /* 单批失败不阻塞其余批次 */
    }
  }
  return out;
}
