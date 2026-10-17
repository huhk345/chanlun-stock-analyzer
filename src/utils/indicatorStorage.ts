import type { StoredIndicator } from '../types/indicator';
import { createUserCodeStorage } from './userCodeStorage';

// Re-export StoredIndicator for convenience
export type { StoredIndicator };

const storage = createUserCodeStorage<StoredIndicator>({
  storageKey: 'chanlun-user-indicators',
  dataField: 'indicators',
  maxItems: 50,
  maxCodeSize: 10 * 1024, // 10 KB
  entity: 'indicator',
});

/**
 * Gets all stored indicators from local storage
 */
export function getAllStoredIndicators(): StoredIndicator[] {
  return storage.getAll();
}

/**
 * Saves an indicator to local storage
 * Updates existing indicator with same ID, or adds new one
 */
export function saveStoredIndicator(indicator: StoredIndicator): void {
  storage.save(indicator);
}

/**
 * Deletes a stored indicator by ID
 */
export function deleteStoredIndicator(id: string): void {
  storage.remove(id);
}

/**
 * Exports all stored indicators as JSON string
 */
export function exportStoredIndicators(): string {
  return storage.exportJson();
}

/**
 * Imports indicators from JSON string
 * Merges with existing indicators, updating duplicates by ID
 */
export function importStoredIndicators(json: string): {
  imported: number;
  skipped: number;
  errors: string[];
} {
  return storage.importJson(json);
}

/**
 * Gets storage statistics
 */
export function getStorageStats(): {
  count: number;
  maxCount: number;
  totalCodeSize: number;
  maxCodeSize: number;
} {
  return storage.stats();
}
