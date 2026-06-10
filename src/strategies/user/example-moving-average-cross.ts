import type { UserStrategyDefinition } from '../../types/strategy';

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export const exampleMovingAverageCrossStrategy: UserStrategyDefinition = {
  id: 'ma-cross',
  name: 'MA Cross',
  description: 'Buys when the fast moving average crosses above the slow moving average and sells on the reverse cross.',
  defaultSelected: true,
  params: [
    { key: 'fastPeriod', label: 'Fast period', type: 'number', defaultValue: 5, min: 2, max: 60, step: 1 },
    { key: 'slowPeriod', label: 'Slow period', type: 'number', defaultValue: 20, min: 3, max: 120, step: 1 },
    { key: 'buyPercent', label: 'Buy percent', type: 'number', defaultValue: 100, min: 1, max: 100, step: 1 },
  ],
  decide({ klines, position, params }) {
    const fastPeriod = typeof params.fastPeriod === 'number' ? params.fastPeriod : 5;
    const slowPeriod = typeof params.slowPeriod === 'number' ? params.slowPeriod : 20;
    const buyPercent = typeof params.buyPercent === 'number' ? params.buyPercent : 100;

    if (klines.length < slowPeriod + 1) {
      return { action: 'HOLD', reason: 'Not enough data' };
    }

    const closes = klines.map((kline) => kline.close);
    const previousFast = average(closes.slice(-fastPeriod - 1, -1));
    const previousSlow = average(closes.slice(-slowPeriod - 1, -1));
    const currentFast = average(closes.slice(-fastPeriod));
    const currentSlow = average(closes.slice(-slowPeriod));

    if (previousFast === null || previousSlow === null || currentFast === null || currentSlow === null) {
      return { action: 'HOLD' };
    }

    const crossedUp = previousFast <= previousSlow && currentFast > currentSlow;
    const crossedDown = previousFast >= previousSlow && currentFast < currentSlow;

    if (crossedUp && position.shares === 0) {
      return {
        action: 'BUY',
        amount: { unit: 'percent', value: buyPercent },
        reason: 'Fast MA crossed above slow MA',
      };
    }

    if (crossedDown && position.shares > 0) {
      return {
        action: 'SELL',
        amount: { unit: 'percent', value: 100 },
        reason: 'Fast MA crossed below slow MA',
      };
    }

    return { action: 'HOLD' };
  },
};
