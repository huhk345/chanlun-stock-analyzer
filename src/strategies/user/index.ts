import type { UserStrategyDefinition } from '../../types/strategy';

// Auto-import strategies without manual imports
// This uses environment-specific auto-discovery mechanisms

let strategies: UserStrategyDefinition[] = [];

// Vite environment: use import.meta.glob (synchronous with eager: true)
if (typeof import.meta !== 'undefined' && 'glob' in import.meta) {
  try {
    // @ts-ignore - Vite-specific feature
    const strategyModules = import.meta.glob('./*.ts', { eager: true });

    for (const path in strategyModules) {
      if (path === './index.ts') continue;

      // @ts-ignore
      const module = strategyModules[path] as Record<string, unknown>;
      for (const exportName in module) {
        const exportValue = module[exportName];
        if (
          exportValue &&
          typeof exportValue === 'object' &&
          'id' in exportValue &&
          'name' in exportValue &&
          'params' in exportValue
        ) {
          strategies.push(exportValue as UserStrategyDefinition);
        }
      }
    }
  } catch {
    strategies = [];
  }
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
          if (
            exportValue &&
            typeof exportValue === 'object' &&
            'id' in exportValue &&
            'name' in exportValue &&
            'params' in exportValue
          ) {
            loadedStrategies.push(exportValue as UserStrategyDefinition);
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
