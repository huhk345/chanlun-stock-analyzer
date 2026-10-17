/**
 * 扫描宇宙 (服务端): 成分股列表 / 股票名称与板块 / 自定义标的合并。
 *
 * 缠论买卖点扫描 (server/scan.ts) 使用这一份宇宙构建逻辑, 同一套名称/板块映射
 * 都只在进程内缓存一次。
 */
import fs from 'node:fs';
import path from 'node:path';
import { INDEX_META, type IndexId } from '../src/types/scan.ts';
import { isAshareSymbol } from '../src/utils/symbols.ts';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = path.join(ROOT_DIR, 'data');

const membersByIndex = new Map<IndexId, string[]>();

/** 成分股: public/index-members.{id}.json (缺失时回退 data/{id}/_constituents.json) */
async function loadIndexMembers(id: IndexId): Promise<string[]> {
  const cached = membersByIndex.get(id);
  if (cached) return cached;

  const candidates = [
    path.join(PUBLIC_DIR, INDEX_META[id].file),
    path.join(DATA_DIR, id, '_constituents.json'),
  ];
  for (const file of candidates) {
    try {
      const list = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (Array.isArray(list) && list.length > 0) {
        const symbols = list.filter(isAshareSymbol);
        membersByIndex.set(id, symbols);
        return symbols;
      }
    } catch { /* 试下一个来源 */ }
  }
  throw new Error(`${INDEX_META[id].label} 成分股列表不可用 (${candidates.join(' / ')})`);
}

export interface StockMeta {
  names: Record<string, string>;
  industries: Record<string, string>;
}

let stockMetaPromise: Promise<StockMeta> | null = null;

/** code(6位) -> 名称 / 板块路径, 来自 public/merged_stock_data.json */
export function loadStockMeta(): Promise<StockMeta> {
  if (stockMetaPromise) return stockMetaPromise;
  stockMetaPromise = (async () => {
    const meta: StockMeta = { names: {}, industries: {} };
    try {
      const raw = await fs.promises.readFile(path.join(PUBLIC_DIR, 'merged_stock_data.json'), 'utf-8');
      const data = JSON.parse(raw) as Record<string, { stock_name?: string; industry?: string }>;
      for (const [code, info] of Object.entries(data || {})) {
        if (info?.stock_name) meta.names[code] = info.stock_name;
        if (info?.industry) meta.industries[code] = info.industry;
      }
    } catch (err) {
      console.warn('[universe] 股票名称/板块映射加载失败 (扫描仍可继续, 仅缺名称与板块列):', err);
    }
    return meta;
  })();
  return stockMetaPromise;
}

/** 去重合并成分股 + 自定义标的 */
export async function buildUniverse(indexes: IndexId[], custom: string[]): Promise<string[]> {
  const universe: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    if (seen.has(s)) return;
    seen.add(s);
    universe.push(s);
  };

  const selected = indexes.filter((id): id is IndexId => id in INDEX_META);
  const lists = await Promise.all(selected.map(loadIndexMembers));
  for (const list of lists) for (const s of list) push(s);
  for (const s of custom) if (isAshareSymbol(s)) push(s);

  if (universe.length === 0) throw new Error('扫描范围为空, 请至少选择一个指数或添加自定义标的');
  return universe;
}