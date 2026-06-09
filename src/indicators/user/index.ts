import type { UserIndicatorDefinition } from '../../types/indicator';

/**
 * Registry of all user-defined indicators
 * 
 * Add new indicators by importing them and adding to this array.
 * The chart component imports only this registry, not individual indicator files.
 */
export const userIndicators: readonly UserIndicatorDefinition[] = [
  // Add more user-defined indicators here
];

/**
 * Validate indicator IDs are unique
 * Logs warnings in development if duplicates are found
 */
export function validateIndicatorIds(): void {
  const ids = new Set<string>();
  const duplicates: string[] = [];

  for (const indicator of userIndicators) {
    if (ids.has(indicator.id)) {
      duplicates.push(indicator.id);
    }
    ids.add(indicator.id);
  }

  if (duplicates.length > 0) {
    console.warn(
      `Duplicate indicator IDs found: ${duplicates.join(', ')}. ` +
      'Each indicator must have a unique ID.'
    );
  }
}

// Validate IDs in development
if (import.meta.env.DEV) {
  validateIndicatorIds();
}

/**
 * Get indicator by ID
 */
export function getUserIndicatorById(id: string): UserIndicatorDefinition | undefined {
  return userIndicators.find(indicator => indicator.id === id);
}

/**
 * Get all indicator IDs
 */
export function getAllIndicatorIds(): string[] {
  return userIndicators.map(indicator => indicator.id);
}
