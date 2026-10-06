import type { UserStrategyDefinition } from '../../types/strategy';

// Auto-import strategies without manual imports
// This uses environment-specific auto-discovery mechanisms

function isStrategyDefinition(value: unknown): value is UserStrategyDefinition {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.name === 'string' &&
    typeof obj.decide === 'function'
  );
}

let strategies: UserStrategyDefinition[] = [];

// NOTE: import.meta.glob is a compile-time feature (Vite transforms it into a
// static module map; tsx also supports it). It is NOT a runtime property, so
// it must be called unconditionally — gating on `'glob' in import.meta` is
// always false in the browser and silently yields zero strategies.
// Plain Node runtimes without glob support throw here, which we catch and
// fall through to the lazy fs-based loader below.
try {
  // @ts-ignore - Vite-specific compile-time feature
  const strategyModules = import.meta.glob('./*.ts', { eager: true }) as Record<string, Record<string, unknown>>;

  for (const path in strategyModules) {
    if (path === './index.ts') continue;

    const module = strategyModules[path];
    for (const exportName in module) {
      const exportValue = module[exportName];
      if (isStrategyDefinition(exportValue)) {
        strategies.push(exportValue);
      }
    }
  }
} catch {
  strategies = [];
}

// Node.js environment: will be initialized lazily via async function
// For synchronous access, we need to pre-initialize or use a getter

// Lazy initialization for Node.js (requires async call)
export async function loadStrategies(): Promise<UserStrategyDefinition[]> {
  if (strategies.length > 0) return strategies;

  try {
    const fsModule = await import('node:fs');
    const pathModule = await import('node:path');
    const urlModule = await import('node:url');

    // Get current directory using import.meta.url (ES module way)
    const currentDir = urlModule.fileURLToPath(new URL('.', import.meta.url));
    const files = fsModule.readdirSync(currentDir);

    const loadedStrategies: UserStrategyDefinition[] = [];

    for (const file of files) {
      if (file === 'index.ts' || !file.endsWith('.ts')) continue;

      const filePath = pathModule.join(currentDir, file);
      try {
        const module = await import(/* @vite-ignore */ filePath);
        for (const exportName in module) {
          const exportValue = module[exportName];
          if (isStrategyDefinition(exportValue)) {
            loadedStrategies.push(exportValue);
          }
        }
      } catch {
        // Skip files that can't be imported
      }
    }

    strategies = loadedStrategies;
    return loadedStrategies;
  } catch {
    return [];
  }
}

// Export strategies - will be populated in Vite, empty in Node.js initially
export const userStrategies: readonly UserStrategyDefinition[] = strategies;

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
