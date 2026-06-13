import type { StoredStrategy, StrategyStorageData } from '../types/strategy';

// Re-export StoredStrategy for convenience
export type { StoredStrategy };

/**
 * Local storage key for user-defined strategies
 */
const STORAGE_KEY = 'chanlun-user-strategies';

/**
 * Current storage format version
 */
const STORAGE_VERSION = 1;

/**
 * Maximum number of strategies to store
 */
const MAX_STRATEGIES = 50;

/**
 * Maximum code size per strategy (in characters)
 */
const MAX_CODE_SIZE = 100 * 1024; // 20 KB

/**
 * Validates stored strategy data
 */
export function validateStoredStrategy(strategy: unknown): strategy is StoredStrategy {
  if (!strategy || typeof strategy !== 'object') return false;

  const obj = strategy as Record<string, unknown>;

  // Required fields
  if (typeof obj.id !== 'string') return false;
  if (typeof obj.name !== 'string') return false;
  if (typeof obj.code !== 'string') return false;
  if (typeof obj.createdAt !== 'string') return false;
  if (typeof obj.updatedAt !== 'string') return false;

  // Validate code size
  if (obj.code.length > MAX_CODE_SIZE) return false;

  return true;
}

/**
 * Migrates storage data to current version
 */
function migrateStorage(data: unknown): StrategyStorageData {
  if (!data || typeof data !== 'object') {
    return { version: STORAGE_VERSION, strategies: [] };
  }

  const obj = data as Record<string, unknown>;
  const version = typeof obj.version === 'number' ? obj.version : 0;

  // Future migrations would go here
  // if (version < 2) { ... migrate to v2 ... }

  const strategies = Array.isArray(obj.strategies)
    ? obj.strategies.filter(validateStoredStrategy)
    : [];

  return {
    version: STORAGE_VERSION,
    strategies,
  };
}

/**
 * Gets all stored strategies from local storage
 */
export function getAllStoredStrategies(): StoredStrategy[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];

    const data = JSON.parse(raw);
    const migrated = migrateStorage(data);

    return migrated.strategies;
  } catch (error) {
    console.warn('Failed to load stored strategies:', error);
    return [];
  }
}

/**
 * Gets a single stored strategy by ID
 */
export function getStoredStrategy(id: string): StoredStrategy | null {
  const all = getAllStoredStrategies();
  return all.find(s => s.id === id) ?? null;
}

/**
 * Saves a strategy to local storage
 * Updates existing strategy with same ID, or adds new one
 */
export function saveStoredStrategy(strategy: StoredStrategy): void {
  const all = getAllStoredStrategies();

  // Check max limit
  const existingIndex = all.findIndex(s => s.id === strategy.id);
  if (existingIndex < 0 && all.length >= MAX_STRATEGIES) {
    throw new Error(`Maximum number of stored strategies (${MAX_STRATEGIES}) reached`);
  }

  // Validate code size
  if (strategy.code.length > MAX_CODE_SIZE) {
    throw new Error(`Strategy code exceeds maximum size (${MAX_CODE_SIZE} characters)`);
  }

  const now = new Date().toISOString();

  if (existingIndex >= 0) {
    // Update existing
    all[existingIndex] = {
      ...strategy,
      updatedAt: now,
    };
  } else {
    // Add new
    all.push({
      ...strategy,
      createdAt: now,
      updatedAt: now,
    });
  }

  // Save to storage
  const data: StrategyStorageData = {
    version: STORAGE_VERSION,
    strategies: all,
  };

  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

/**
 * Deletes a stored strategy by ID
 */
export function deleteStoredStrategy(id: string): void {
  const all = getAllStoredStrategies();
  const filtered = all.filter(s => s.id !== id);

  const data: StrategyStorageData = {
    version: STORAGE_VERSION,
    strategies: filtered,
  };

  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

/**
 * Exports all stored strategies as JSON string
 */
export function exportStoredStrategies(): string {
  const all = getAllStoredStrategies();
  return JSON.stringify(all, null, 2);
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
  const result = {
    imported: 0,
    skipped: 0,
    errors: [] as string[],
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    result.errors.push('Invalid JSON format');
    return result;
  }

  if (!Array.isArray(parsed)) {
    result.errors.push('Import data must be an array');
    return result;
  }

  const existing = getAllStoredStrategies();
  const existingIds = new Set(existing.map(s => s.id));

  for (const item of parsed) {
    if (!validateStoredStrategy(item)) {
      result.skipped++;
      result.errors.push(`Invalid strategy format: ${JSON.stringify(item).slice(0, 100)}`);
      continue;
    }

    if (existingIds.has(item.id)) {
      // Update existing
      const index = existing.findIndex(s => s.id === item.id);
      if (index >= 0) {
        existing[index] = item;
      }
    } else {
      // Add new
      if (existing.length >= MAX_STRATEGIES) {
        result.errors.push(`Maximum strategy limit (${MAX_STRATEGIES}) reached`);
        break;
      }
      existing.push(item);
    }

    result.imported++;
  }

  // Save merged data
  const data: StrategyStorageData = {
    version: STORAGE_VERSION,
    strategies: existing,
  };

  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

  return result;
}

/**
 * Clears all stored strategies
 */
export function clearAllStoredStrategies(): void {
  localStorage.removeItem(STORAGE_KEY);
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
  const all = getAllStoredStrategies();

  return {
    count: all.length,
    maxCount: MAX_STRATEGIES,
    totalCodeSize: all.reduce((sum, s) => sum + s.code.length, 0),
    maxCodeSize: MAX_CODE_SIZE,
  };
}
