import type {
  StoredIndicator,
  IndicatorStorageData,
  UserIndicatorParamDefinition,
} from '../types/indicator';

// Re-export StoredIndicator for convenience
export type { StoredIndicator };

/**
 * Local storage key for user-defined indicators
 */
const STORAGE_KEY = 'chanlun-user-indicators';

/**
 * Current storage format version
 */
const STORAGE_VERSION = 1;

/**
 * Maximum number of indicators to store
 */
const MAX_INDICATORS = 50;

/**
 * Maximum code size per indicator (in characters)
 */
const MAX_CODE_SIZE = 10 * 1024; // 10 KB

/**
 * Validates stored indicator data
 */
function validateStoredIndicator(indicator: unknown): indicator is StoredIndicator {
  if (!indicator || typeof indicator !== 'object') return false;
  
  const obj = indicator as Record<string, unknown>;
  
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
function migrateStorage(data: unknown): IndicatorStorageData {
  if (!data || typeof data !== 'object') {
    return { version: STORAGE_VERSION, indicators: [] };
  }

  const obj = data as Record<string, unknown>;
  const version = typeof obj.version === 'number' ? obj.version : 0;

  // Future migrations would go here
  // if (version < 2) { ... migrate to v2 ... }

  const indicators = Array.isArray(obj.indicators)
    ? obj.indicators.filter(validateStoredIndicator)
    : [];

  return {
    version: STORAGE_VERSION,
    indicators,
  };
}

/**
 * Gets all stored indicators from local storage
 */
export function getAllStoredIndicators(): StoredIndicator[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];

    const data = JSON.parse(raw);
    const migrated = migrateStorage(data);
    
    return migrated.indicators;
  } catch (error) {
    console.warn('Failed to load stored indicators:', error);
    return [];
  }
}

/**
 * Gets a single stored indicator by ID
 */
export function getStoredIndicator(id: string): StoredIndicator | null {
  const all = getAllStoredIndicators();
  return all.find(i => i.id === id) ?? null;
}

/**
 * Saves an indicator to local storage
 * Updates existing indicator with same ID, or adds new one
 */
export function saveStoredIndicator(indicator: StoredIndicator): void {
  const all = getAllStoredIndicators();
  
  // Check max limit
  const existingIndex = all.findIndex(i => i.id === indicator.id);
  if (existingIndex < 0 && all.length >= MAX_INDICATORS) {
    throw new Error(`Maximum number of stored indicators (${MAX_INDICATORS}) reached`);
  }

  // Validate code size
  if (indicator.code.length > MAX_CODE_SIZE) {
    throw new Error(`Indicator code exceeds maximum size (${MAX_CODE_SIZE} characters)`);
  }

  const now = new Date().toISOString();
  
  if (existingIndex >= 0) {
    // Update existing
    all[existingIndex] = {
      ...indicator,
      updatedAt: now,
    };
  } else {
    // Add new
    all.push({
      ...indicator,
      createdAt: now,
      updatedAt: now,
    });
  }

  // Save to storage
  const data: IndicatorStorageData = {
    version: STORAGE_VERSION,
    indicators: all,
  };
  
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

/**
 * Deletes a stored indicator by ID
 */
export function deleteStoredIndicator(id: string): void {
  const all = getAllStoredIndicators();
  const filtered = all.filter(i => i.id !== id);
  
  const data: IndicatorStorageData = {
    version: STORAGE_VERSION,
    indicators: filtered,
  };
  
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

/**
 * Exports all stored indicators as JSON string
 */
export function exportStoredIndicators(): string {
  const all = getAllStoredIndicators();
  return JSON.stringify(all, null, 2);
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
  const result = {
    imported: 0,
    skipped: 0,
    errors: [] as string[],
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    result.errors.push('Invalid JSON format');
    return result;
  }

  if (!Array.isArray(parsed)) {
    result.errors.push('Import data must be an array');
    return result;
  }

  const existing = getAllStoredIndicators();
  const existingIds = new Set(existing.map(i => i.id));

  for (const item of parsed) {
    if (!validateStoredIndicator(item)) {
      result.skipped++;
      result.errors.push(`Invalid indicator format: ${JSON.stringify(item).slice(0, 100)}`);
      continue;
    }

    if (existingIds.has(item.id)) {
      // Update existing
      const index = existing.findIndex(i => i.id === item.id);
      if (index >= 0) {
        existing[index] = item;
      }
    } else {
      // Add new
      if (existing.length >= MAX_INDICATORS) {
        result.errors.push(`Maximum indicator limit (${MAX_INDICATORS}) reached`);
        break;
      }
      existing.push(item);
    }

    result.imported++;
  }

  // Save merged data
  const data: IndicatorStorageData = {
    version: STORAGE_VERSION,
    indicators: existing,
  };
  
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));

  return result;
}

/**
 * Clears all stored indicators
 */
export function clearAllStoredIndicators(): void {
  localStorage.removeItem(STORAGE_KEY);
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
  const all = getAllStoredIndicators();
  
  return {
    count: all.length,
    maxCount: MAX_INDICATORS,
    totalCodeSize: all.reduce((sum, i) => sum + i.code.length, 0),
    maxCodeSize: MAX_CODE_SIZE,
  };
}
