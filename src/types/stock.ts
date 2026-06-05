export interface Kline {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MergedKline {
  high: number;
  low: number;
  direction: 'up' | 'down';
  originalIndices: number[]; // Index array of original Klines merged into this
  originalHigh: number;
  originalLow: number;
}

export type FractionType = 'TOP' | 'BOTTOM';

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
  high: number;  // Floor of the upper overlapping bounds
  low: number;   // Ceiling of the lower overlapping bounds
  startIndex: number; // Start index in original Klines
  endIndex: number;   // End index in original Klines
  strokesCount: number;
}

export type BuySellSignalType = 'BUY_1' | 'BUY_2' | 'BUY_3' | 'SELL_1' | 'SELL_2' | 'SELL_3';

export interface BuySellPoint {
  id: string;
  type: BuySellSignalType;
  price: number;
  originalIndex: number;
  date: string;
  reason: string;
}

export interface StockInfo {
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
}

export interface BacktestTrade {
  id: string;
  type: 'BUY' | 'SELL';
  signalType: BuySellSignalType | 'STOP_LOSS' | 'TAKE_PROFIT' | 'MANUAL';
  price: number;
  date: string;
  shares: number;
  value: number;
  pnl?: number;      // Populated on SELL trades
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
  trades: BacktestTrade[];
  createdAt: string;
}
