/**
 * 用户代码 (指标/策略) localStorage 存储工厂。
 * 两者存储结构一致: { version, <field>: 条目[] }, 按 id 去重, 带数量 / 代码大小上限,
 * 仅存储键、数据字段名与上限不同。
 */

/** 存储条目公共字段 */
export interface UserCodeEntry {
  id: string;
  name: string;
  code: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserCodeStorageOptions {
  /** localStorage 键名 */
  storageKey: string;
  /** 数据字段名 ('indicators' | 'strategies') */
  dataField: string;
  /** 条目数量上限 */
  maxItems: number;
  /** 单个条目代码大小上限 (字符) */
  maxCodeSize: number;
  /** 错误信息中的实体名 ('indicator' | 'strategy') */
  entity: string;
}

interface UserCodeImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

export interface UserCodeStorage<T extends UserCodeEntry> {
  getAll(): T[];
  getById(id: string): T | null;
  save(item: T): void;
  remove(id: string): void;
  exportJson(): string;
  importJson(json: string): UserCodeImportResult;
  stats(): {
    count: number;
    maxCount: number;
    totalCodeSize: number;
    maxCodeSize: number;
  };
}

const STORAGE_VERSION = 1;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function createUserCodeStorage<T extends UserCodeEntry>(
  opts: UserCodeStorageOptions,
): UserCodeStorage<T> {
  const { storageKey, dataField, maxItems, maxCodeSize, entity } = opts;
  const entityPlural = `${entity}s`;

  /** 校验存储条目必备字段与代码大小 */
  const validate = (item: unknown): item is T => {
    if (!item || typeof item !== 'object') return false;
    const obj = item as Record<string, unknown>;
    if (typeof obj.id !== 'string') return false;
    if (typeof obj.name !== 'string') return false;
    if (typeof obj.code !== 'string') return false;
    if (typeof obj.createdAt !== 'string') return false;
    if (typeof obj.updatedAt !== 'string') return false;
    if (obj.code.length > maxCodeSize) return false;
    return true;
  };

  const write = (items: T[]): void => {
    localStorage.setItem(
      storageKey,
      JSON.stringify({ version: STORAGE_VERSION, [dataField]: items }),
    );
  };

  const getAll = (): T[] => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return [];
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return [];
      const items = (data as Record<string, unknown>)[dataField];
      return Array.isArray(items) ? (items as unknown[]).filter(validate) : [];
    } catch (error) {
      console.warn(`Failed to load stored ${entityPlural}:`, error);
      return [];
    }
  };

  const getById = (id: string): T | null => getAll().find(i => i.id === id) ?? null;

  const save = (item: T): void => {
    const all = getAll();
    const existingIndex = all.findIndex(i => i.id === item.id);
    if (existingIndex < 0 && all.length >= maxItems) {
      throw new Error(`Maximum number of stored ${entityPlural} (${maxItems}) reached`);
    }
    if (item.code.length > maxCodeSize) {
      throw new Error(`${cap(entity)} code exceeds maximum size (${maxCodeSize} characters)`);
    }

    const now = new Date().toISOString();
    if (existingIndex >= 0) {
      all[existingIndex] = { ...item, updatedAt: now };
    } else {
      all.push({ ...item, createdAt: now, updatedAt: now });
    }
    write(all);
  };

  const remove = (id: string): void => {
    write(getAll().filter(i => i.id !== id));
  };

  const exportJson = (): string => JSON.stringify(getAll(), null, 2);

  const importJson = (json: string): UserCodeImportResult => {
    const result: UserCodeImportResult = { imported: 0, skipped: 0, errors: [] };

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

    const existing = getAll();
    const existingIds = new Set(existing.map(i => i.id));

    for (const item of parsed) {
      if (!validate(item)) {
        result.skipped++;
        result.errors.push(`Invalid ${entity} format: ${JSON.stringify(item).slice(0, 100)}`);
        continue;
      }

      if (existingIds.has(item.id)) {
        const index = existing.findIndex(i => i.id === item.id);
        if (index >= 0) existing[index] = item;
      } else {
        if (existing.length >= maxItems) {
          result.errors.push(`Maximum ${entity} limit (${maxItems}) reached`);
          break;
        }
        existing.push(item);
      }
      result.imported++;
    }

    write(existing);
    return result;
  };

  const stats = () => {
    const all = getAll();
    return {
      count: all.length,
      maxCount: maxItems,
      totalCodeSize: all.reduce((sum, i) => sum + i.code.length, 0),
      maxCodeSize,
    };
  };

  return { getAll, getById, save, remove, exportJson, importJson, stats };
}
