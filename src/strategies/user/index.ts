import type { UserStrategyDefinition } from '../../types/strategy';
import { chanlunVolumePullbackStrategy } from './chanlun-volume-pullback';
import { exampleMovingAverageCrossStrategy } from './example-moving-average-cross';

export const userStrategies: readonly UserStrategyDefinition[] = [
  chanlunVolumePullbackStrategy,
  exampleMovingAverageCrossStrategy,
];

export function validateStrategyIds(): void {
  const ids = new Set<string>();
  const duplicates: string[] = [];

  for (const strategy of userStrategies) {
    if (ids.has(strategy.id)) {
      duplicates.push(strategy.id);
    }
    ids.add(strategy.id);
  }

  if (duplicates.length > 0) {
    console.warn(
      `Duplicate strategy IDs found: ${duplicates.join(', ')}. ` +
      'Each strategy must have a unique ID.'
    );
  }
}

if (typeof import.meta.env !== 'undefined' && import.meta.env.DEV) {
  validateStrategyIds();
}

export function getUserStrategyById(id: string): UserStrategyDefinition | undefined {
  return userStrategies.find(strategy => strategy.id === id);
}

export function getAllStrategyIds(): string[] {
  return userStrategies.map(strategy => strategy.id);
}
