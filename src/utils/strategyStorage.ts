import type { StoredStrategy } from '../types/strategy';
import { createUserCodeStorage } from './userCodeStorage';

// Re-export StoredStrategy for convenience
export type { StoredStrategy };

const storage = createUserCodeStorage<StoredStrategy>({
  storageKey: 'chanlun-user-strategies',
  dataField: 'strategies',
  maxItems: 50,
  maxCodeSize: 100 * 1024, // 100 KB
  entity: 'strategy',
});

/**
 * Gets all stored strategies from local storage
 */
export function getAllStoredStrategies(): StoredStrategy[] {
  return storage.getAll();
}

/**
 * Gets a single stored strategy by ID
 */
export function getStoredStrategy(id: string): StoredStrategy | null {
  return storage.getById(id);
}

/**
 * Saves a strategy to local storage
 * Updates existing strategy with same ID, or adds new one
 */
export function saveStoredStrategy(strategy: StoredStrategy): void {
  storage.save(strategy);
}

/**
 * Deletes a stored strategy by ID
 */
export function deleteStoredStrategy(id: string): void {
  storage.remove(id);
}

/**
 * Exports all stored strategies as JSON string
 */
export function exportStoredStrategies(): string {
  return storage.exportJson();
}

/**
 * Imports strategies from JSON string
 * Merges with existing strategies, updating duplicates by ID
 */
export function importStoredStrategies(json: string): {
  imported: number;
  skipped: number;
  errors: string[];
} {
  return storage.importJson(json);
}

/**
 * Gets storage statistics
 */
export function getStrategyStorageStats(): {
  count: number;
  maxCount: number;
  totalCodeSize: number;
  maxCodeSize: number;
} {
  return storage.stats();
}
