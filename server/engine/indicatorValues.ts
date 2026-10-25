/**
 * 回测用指标快照计算 —— 把「内置指标 (MA/BOLL/MACD) + 用户自定义指标」的当前值
 * 合并成一个扁平对象, 供策略在 `params` 里直接读取。
 *
 * 只属于回测引擎 (逐根 K 线调用), 因此随引擎一起放在服务端;
 * 前端画图用的指标计算仍走 src/utils/indicatorAdapter.ts。
 */
import type { Kline } from '../../src/types/stock.ts';
import type { UserIndicatorDefinition } from '../../src/types/indicator.ts';
import type { StrategyParamValue } from '../../src/types/strategy.ts';
import { calculateSMA, calculateBollingerBands, calculateMACD } from '../../src/utils/indicators.ts';
import { calculateUserIndicatorSafely, createIndicatorInput } from '../../src/utils/indicatorAdapter.ts';

/**
 * Computes flat indicator key-value pairs for the current kline index.
 * Merges built-in (MA5, MA10, MA20, MA60, BOLL, MACD) and user-defined
 * indicator values into a single flat record.
 */
export function computeIndicatorValues(
  definitions: readonly UserIndicatorDefinition[],
  symbol: string,
  klines: readonly Kline[],
  currentIndex: number,
): Record<string, StrategyParamValue> {
  const values: Record<string, StrategyParamValue> = {};
  const mutableKlines = [...klines];

  // Built-in: SMA moving averages
  const maPeriods = [5, 10, 20, 60];
  for (const period of maPeriods) {
    if (currentIndex >= period - 1) {
      const ma = calculateSMA(mutableKlines, period);
      const val = ma[currentIndex];
      if (val !== null) {
        values[`MA${period}`] = val;
      }
    }
  }

  // Built-in: Bollinger Bands (default period 20, multiplier 2)
  if (currentIndex >= 19) {
    const boll = calculateBollingerBands(mutableKlines);
    if (boll.upper[currentIndex] !== null) {
      values['BOLL_UP'] = boll.upper[currentIndex]!;
      values['BOLL_MID'] = boll.middle[currentIndex]!;
      values['BOLL_LOW'] = boll.lower[currentIndex]!;
    }
  }

  // Built-in: MACD (default 12, 26, 9)
  if (currentIndex >= 25) {
    const macd = calculateMACD(mutableKlines);
    if (macd.dif[currentIndex] !== null) {
      values['MACD_DIF'] = parseFloat(macd.dif[currentIndex]!.toFixed(4));
      values['MACD_DEA'] = parseFloat(macd.dea[currentIndex]!.toFixed(4));
      values['MACD'] = parseFloat(macd.histogram[currentIndex]!.toFixed(4));
    }
  }

  // User-defined indicators: use each series name as the key
  const currentDate = klines[currentIndex].date;
  for (const def of definitions) {
    const input = createIndicatorInput(klines, symbol, def);
    const normalized = calculateUserIndicatorSafely(def, input);
    for (const series of normalized.result.series) {
      const point = series.data.find(p => p.time === currentDate);
      if (point && point.value !== null) {
        values[series.name] = parseFloat(point.value.toFixed(4));
      }
    }
  }

  return values;
}
