export interface Kline {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}

export interface MergedKline {
  high: number;
  low: number;
  direction: 'up' | 'down';
  originalIndices: number[]; // Index array of original Klines merged into this
  originalHigh: number;
  originalLow: number;
}

type FractionType = 'TOP' | 'BOTTOM';

export interface Fraction {
  type: FractionType;
  price: number;
  index: number;         // Index in the *merged* K-line array
  originalIndex: number; // Index in the *original* K-line array
  date: string;
}

export interface Stroke {
  id: string;
  start: Fraction;
  end: Fraction;
  direction: 'up' | 'down';
}

export interface Segment {
  id: string;
  start: Fraction;
  end: Fraction;
  direction: 'up' | 'down';
}

export interface Hub {
  id: string;
  zg: number;       // 中枢高点 = min of the 3 stroke highs
  zd: number;       // 中枢低点 = max of the 3 stroke lows
  gg: number;       // 最高点 = max of all stroke highs in hub
  dd: number;       // 最低点 = min of all stroke lows in hub
  startIndex: number; // Start index in original Klines
  endIndex: number;   // End index in original Klines
  strokesCount: number;
  level: number;    // 中枢级别: 1=笔中枢, 2=线段中枢
}

export type BSPointType = 'B1' | 'B2' | 'B3' | 'S1' | 'S2' | 'S3';

export interface BSPoint {
  id: string;
  type: BSPointType;
  label: string;          // 一买/二买/三买/一卖/二卖/三卖
  price: number;          // Signal price (stroke end fractal extreme)
  originalIndex: number;  // Index in the original K-line array
  date: string;
  strokeIndex: number;    // Index of the stroke that generated this point
}

export interface StockBasicInfo {
  symbol: string;          // 股票代码
  name: string;            // 股票名称
  price: number;           // 当前价格
  change: number;          // 涨跌额
  changePercent: number;   // 涨跌幅
  open: number;            // 开盘价
  high: number;            // 最高价
  low: number;             // 最低价
  volume: number;          // 成交量
  amount: number;          // 成交额
  turnoverRate?: number;   // 换手率
  peRatio?: number;        // 市盈率
  totalMarketValue?: number; // 总市值
  circulatingMarketValue?: number; // 流通市值
}

export interface BacktestTrade {
  id: string;
  type: 'BUY' | 'SELL';
  /** 信号来源标签 (策略 id, 或引擎级信号如 stop-loss) */
  signalType: string;
  /** 策略给出的完整买卖信号理由 (回测账本/图表标注展示) */
  reason?: string;
  /** 策略给出的信号置信度 0~1 */
  confidence?: number;
  price: number;
  date: string;
  shares: number;
  value: number;
  fee?: number;       // Transaction fee (佣金 + 印花税 + 过户费)
  pnl?: number;       // Populated on SELL trades (net of fees)
  pnlPercent?: number;
}

export interface BacktestResult {
  id: string;
  userId: string;
  symbol: string;
  startDate: string;
  endDate: string;
  initialBalance: number;
  finalBalance: number;
  totalReturnPercent: number;
  totalTrades: number;
  winningTrades: number;
  winRate: number;
  totalFees: number;
  sharpeRatio: number;
  buyHoldReturnPercent: number;
  /** 区间内权益曲线相对峰值的最大回撤 % (0 表示无回撤, 老数据可能缺失) */
  maxDrawdownPercent?: number;
  trades: BacktestTrade[];
  createdAt: string;
}
