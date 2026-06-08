import { Kline } from '../types/stock';

/**
 * Calculates Simple Moving Average (SMA)
 */
export function calculateSMA(klines: Kline[], period: number): (number | null)[] {
  const mas: (number | null)[] = [];
  for (let i = 0; i < klines.length; i++) {
    if (i < period - 1) {
      mas.push(null);
    } else {
      const sum = klines.slice(i - period + 1, i + 1).reduce((s, k) => s + k.close, 0);
      mas.push(parseFloat((sum / period).toFixed(2)));
    }
  }
  return mas;
}

/**
 * Calculates Exponential Moving Average (EMA)
 */
export function calculateEMA(klines: Kline[], period: number): (number | null)[] {
  const emas: (number | null)[] = [];
  const k = 2 / (period + 1);
  let prevEma: number | null = null;

  for (let i = 0; i < klines.length; i++) {
    const close = klines[i].close;
    if (i === 0) {
      emas.push(close);
      prevEma = close;
    } else {
      const emaVal = close * k + (prevEma as number) * (1 - k);
      emas.push(parseFloat(emaVal.toFixed(2)));
      prevEma = emaVal;
    }
  }
  return emas;
}

/**
 * Calculates Bollinger Bands (BOLL)
 */
export function calculateBollingerBands(
  klines: Kline[],
  period: number = 20,
  multiplier: number = 2
) {
  const upper: (number | null)[] = [];
  const middle: (number | null)[] = [];
  const lower: (number | null)[] = [];

  for (let i = 0; i < klines.length; i++) {
    if (i < period - 1) {
      upper.push(null);
      middle.push(null);
      lower.push(null);
    } else {
      const subset = klines.slice(i - period + 1, i + 1);
      const sum = subset.reduce((s, k) => s + k.close, 0);
      const midValue = sum / period;
      
      const variance = subset.reduce((v, k) => v + Math.pow(k.close - midValue, 2), 0) / period;
      const sd = Math.sqrt(variance);

      upper.push(parseFloat((midValue + multiplier * sd).toFixed(2)));
      middle.push(parseFloat(midValue.toFixed(2)));
      lower.push(parseFloat((midValue - multiplier * sd).toFixed(2)));
    }
  }
  return { upper, middle, lower };
}

/**
 * Calculates MACD (DIF, DEA, Histogram)
 */
export function calculateMACD(
  klines: Kline[],
  shortPeriod: number = 12,
  longPeriod: number = 26,
  signalPeriod: number = 9
) {
  const emaShort: number[] = [];
  const emaLong: number[] = [];
  const dif: (number | null)[] = [];
  const dea: (number | null)[] = [];
  const histogram: (number | null)[] = [];

  const kShort = 2 / (shortPeriod + 1);
  const kLong = 2 / (longPeriod + 1);
  const kSignal = 2 / (signalPeriod + 1);

  for (let i = 0; i < klines.length; i++) {
    const close = klines[i].close;

    if (i === 0) {
      emaShort.push(close);
      emaLong.push(close);
      dif.push(0);
      dea.push(0);
      histogram.push(0);
    } else {
      const shortVal = close * kShort + emaShort[i - 1] * (1 - kShort);
      const longVal = close * kLong + emaLong[i - 1] * (1 - kLong);
      emaShort.push(shortVal);
      emaLong.push(longVal);

      const difVal = shortVal - longVal;
      dif.push(difVal);

      // DEA is EMA of DIF
      const prevDea = dea[i - 1] || 0;
      const deaVal = difVal * kSignal + prevDea * (1 - kSignal);
      dea.push(deaVal);

      const histVal = (difVal - deaVal) * 2;
      histogram.push(histVal);
    }
  }

  return { dif, dea, histogram };
}

export function calculateRSI(klines: Kline[], period: number = 14): (number | null)[] {
  const rsis: (number | null)[] = [];
  if (klines.length < period + 1) {
    return klines.map(() => null);
  }

  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < klines.length; i++) {
    const diff = klines[i].close - klines[i - 1].close;
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }

  let avgGain = gains.slice(0, period).reduce((s, v) => s + v, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((s, v) => s + v, 0) / period;

  for (let i = 0; i < klines.length; i++) {
    if (i < period) {
      rsis.push(null);
    } else if (i === period) {
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      rsis.push(parseFloat((100 - 100 / (1 + rs)).toFixed(2)));
    } else {
      const gain = gains[i - 1];
      const loss = losses[i - 1];
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      rsis.push(parseFloat((100 - 100 / (1 + rs)).toFixed(2)));
    }
  }

  return rsis;
}
