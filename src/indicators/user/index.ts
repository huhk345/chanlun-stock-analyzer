import type { UserIndicatorDefinition } from '../../types/indicator';
import { warnDuplicateIds } from '../../utils/registryUtils';

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
function validateIndicatorIds(): void {
  warnDuplicateIds('indicator', userIndicators);
}

// Validate IDs in development
if (import.meta.env.DEV) {
  validateIndicatorIds();
}
