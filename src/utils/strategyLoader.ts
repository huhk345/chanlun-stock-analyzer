import type { UserStrategyDefinition } from '../types/strategy';
import type { StoredStrategy } from './strategyStorage';
import {
  getAllStoredStrategies,
  getStoredStrategy,
} from './strategyStorage';
import {
  evalUserCodeModule,
  validateUserCode,
  type UserCodeContract,
} from './userCodeLoader';

const CONTRACT: UserCodeContract = {
  globalName: 'strategy',
  entity: 'Strategy',
  definitionType: 'UserStrategyDefinition',
  requiredFunction: 'decide',
};

/**
 * Parses stored strategy code and creates a UserStrategyDefinition
 */
function parseStrategyCode(code: string, metadata: StoredStrategy): UserStrategyDefinition {
  const result = evalUserCodeModule(code, CONTRACT);

  // Merge with metadata from storage
  return {
    id: result.id,
    name: result.name,
    description: result.description ?? metadata.description,
    defaultSelected: result.defaultSelected ?? metadata.defaultSelected ?? false,
    params: result.params ?? metadata.params,
    availableIndicators: result.availableIndicators ?? metadata.availableIndicators,
    requiredIndicators: result.requiredIndicators ?? metadata.requiredIndicators,
    requiresChanLun: result.requiresChanLun ?? metadata.requiresChanLun,
    decide: result.decide,
  };
}

/**
 * Loads all stored strategies and converts them to UserStrategyDefinition objects
 *
 * Invalid strategies are skipped with console warnings
 */
export function loadStoredStrategies(): UserStrategyDefinition[] {
  const stored = getAllStoredStrategies();
  const loaded: UserStrategyDefinition[] = [];

  for (const item of stored) {
    try {
      const definition = parseStrategyCode(item.code, item);
      loaded.push(definition);
    } catch (error) {
      console.warn(
        `Failed to load stored strategy "${item.id}":`,
        error instanceof Error ? error.message : error
      );
    }
  }

  return loaded;
}

/**
 * Loads a single stored strategy by ID
 */
export function loadStoredStrategyById(id: string): UserStrategyDefinition | null {
  const item = getStoredStrategy(id);

  if (!item) return null;

  try {
    return parseStrategyCode(item.code, item);
  } catch (error) {
    console.warn(
      `Failed to load stored strategy "${id}":`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

/**
 * Validates strategy code without executing it
 * Performs basic syntax and structure checks
 */
export function validateStrategyCode(code: string): {
  valid: boolean;
  errors: string[];
} {
  return validateUserCode(code, CONTRACT);
}
