/**
 * 缠论买卖点扫描 —— 类型与常量。
 *
 * 扫描完全在浏览器内完成 (见 src/utils/indexScan.ts): 本地引擎负责拉 K 线、
 * 计算缠论买卖点、生成信号行; 组件只做筛选/排序/展示。
 */
import type { BSPointType } from './stock';

export type ScanTimeframe = 'daily' | 'weekly';

export type IndexId = 'hs300' | 'zz500';

export const INDEX_META: Record<IndexId, { label: string; file: string }> = {
  hs300: { label: '沪深300', file: 'index-members.hs300.json' },
  zz500: { label: '中证500', file: 'index-members.zz500.json' },
};

/** 买卖点统计窗口: 最近 90 个自然日 (日线/周线统一口径) */
export const SIGNAL_WINDOW_DAYS = 90;

export const ALL_BS_TYPES: BSPointType[] = ['B1', 'B2', 'B3', 'S1', 'S2', 'S3'];

export const TYPE_LABELS: Record<BSPointType, string> = {
  B1: '一买', B2: '二买', B3: '三买', S1: '一卖', S2: '三卖', S3: '三卖',
};

/** 后端算好的单条买卖点信号 (行内计算完成, 前端只做筛选/排序/渲染) */
export interface ScanSignalRow {
  id: string;             // symbolKey-type-date
  symbolKey: string;      // '000001.SZ'
  code: string;
  name?: string;
  industryPath?: string;  // 板块完整路径 '金融 > 商业银行 > ... > 银行'
  type: BSPointType;
  label: string;          // 一买/二买/三买/一卖/二卖/三卖
  date: string;           // 信号日期 YYYY-MM-DD
  price: number;          // 信号价
  lastClose: number;      // 最新收盘价
  dataDate: string;       // 最新收盘价对应的数据日期 (自选跟踪基准日)
  daysAgo: number;        // 距最新交易日的自然日
  changeSincePct: number; // 现价相对信号价涨跌 %
  strokeUp: boolean;      // 产生信号的笔方向
  volRatio?: number;      // 量比: 最新收盘量 / 前5日均量
  amount5?: number;       // 近5日日均成交额 (亿元)
}

/** 扫描缓存概况 (对应浏览器 localStorage 里的缓存信息) */
export interface ScanCacheInfo {
  timeframe: ScanTimeframe;
  count: number;        // 缓存中的标的数量
  latestDate: string;   // 缓存中最新的数据日期 YYYY-MM-DD
  stale: boolean;       // 缓存整体是否落后于预期最新交易日
}

export interface ScanProgress {
  total: number;
  done: number;
  ok: number;
  failed: number;
  cached: number;   // 命中本地缓存, 跳过下载与计算
  signalCount: number;
}
