import type { UserIndicatorDefinition } from '../types/indicator';
import {
  getAllStoredIndicators,
  type StoredIndicator,
} from './indicatorStorage';
import {
  evalUserCodeModule,
  validateUserCode,
  type UserCodeContract,
} from './userCodeLoader';

const CONTRACT: UserCodeContract = {
  globalName: 'indicator',
  entity: 'Indicator',
  definitionType: 'UserIndicatorDefinition',
  requiredFunction: 'calculate',
};

/**
 * Parses stored indicator code and creates a UserIndicatorDefinition
 */
function parseIndicatorCode(code: string, metadata: StoredIndicator): UserIndicatorDefinition {
  const result = evalUserCodeModule(code, CONTRACT);

  // Merge with metadata from storage
  return {
    id: result.id,
    name: result.name,
    description: result.description ?? metadata.description,
    defaultVisible: result.defaultVisible ?? metadata.defaultVisible ?? false,
    params: result.params ?? metadata.params,
    calculate: result.calculate,
  };
}

/**
 * Loads all stored indicators and converts them to UserIndicatorDefinition objects
 * 
 * Invalid indicators are skipped with console warnings
 */
export function loadStoredIndicators(): UserIndicatorDefinition[] {
  const stored = getAllStoredIndicators();
  const loaded: UserIndicatorDefinition[] = [];

  for (const item of stored) {
    try {
      const definition = parseIndicatorCode(item.code, item);
      loaded.push(definition);
    } catch (error) {
      console.warn(
        `Failed to load stored indicator "${item.id}":`,
        error instanceof Error ? error.message : error
      );
    }
  }

  return loaded;
}

/**
 * Loads a single stored indicator by ID
 */
export function loadStoredIndicatorById(id: string): UserIndicatorDefinition | null {
  const stored = getAllStoredIndicators();
  const item = stored.find(i => i.id === id);

  if (!item) return null;

  try {
    return parseIndicatorCode(item.code, item);
  } catch (error) {
    console.warn(
      `Failed to load stored indicator "${id}":`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

/**
 * Validates indicator code without executing it
 * Performs basic syntax and structure checks
 */
export function validateIndicatorCode(code: string): {
  valid: boolean;
  errors: string[];
} {
  return validateUserCode(code, CONTRACT);
}
