/**
 * 策略注册表 API 客户端
 *
 * 策略代码与执行都在服务端 (server/strategies + data/user-strategies),
 * 浏览器只负责展示与编辑文本:
 *   GET    /api/strategies             元数据列表 (内置 + 自建)
 *   GET    /api/strategies/user        自建策略 (含完整代码, 供管理面板)
 *   POST   /api/strategies             新建 / 覆盖自建策略
 *   POST   /api/strategies/import      批量导入
 *   GET    /api/strategies/:id/source  查看源码
 *   DELETE /api/strategies/:id         删除自建策略
 */
import type { StoredStrategy, StrategySummary } from '../types/strategy';
import { validateUserCode, type UserCodeContract } from './userCodeLoader';

const STRATEGY_CONTRACT: UserCodeContract = {
  globalName: 'strategy',
  entity: 'Strategy',
  definitionType: 'UserStrategyDefinition',
  requiredFunction: 'decide',
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, init);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error((err as { error?: string })?.error || `请求失败 (${resp.status})`);
  }
  return (await resp.json()) as T;
}

/** 策略元数据列表 (不含代码) */
export async function fetchStrategySummaries(): Promise<StrategySummary[]> {
  const data = await request<{ strategies?: StrategySummary[] }>('/api/strategies');
  return data.strategies ?? [];
}

/** 自建策略列表 (含完整代码) */
export async function fetchUserStrategies(): Promise<StoredStrategy[]> {
  const data = await request<{ strategies?: StoredStrategy[] }>('/api/strategies/user');
  return data.strategies ?? [];
}

/** 新建 / 覆盖自建策略; 服务端会做代码校验与沙箱编译 */
export async function saveUserStrategy(strategy: StoredStrategy): Promise<StoredStrategy> {
  const data = await request<{ strategy: StoredStrategy }>('/api/strategies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(strategy),
  });
  return data.strategy;
}

export async function deleteUserStrategy(id: string): Promise<void> {
  await request(`/api/strategies/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** 批量导入 (JSON 文本或对象数组), 返回导入明细 */
export async function importUserStrategies(
  payload: unknown,
): Promise<{ imported: number; skipped: number; errors: string[] }> {
  return request('/api/strategies/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** 导出全部自建策略为 JSON 文本 */
export async function exportUserStrategies(): Promise<string> {
  const strategies = await fetchUserStrategies();
  return JSON.stringify({ strategies }, null, 2);
}

/**
 * 本地静态校验 (不执行代码): 禁用模式 + 导出声明。
 * 真正能否运行由服务端沙箱决定, 这里只用于保存前的即时提示。
 */
export function validateStrategyCode(code: string): { valid: boolean; errors: string[] } {
  return validateUserCode(code, STRATEGY_CONTRACT);
}

/** 存储用量概览 (服务端上限与前端 localStorage 版本保持一致) */
export const STRATEGY_STORE_LIMITS = { maxCount: 50, maxCodeSize: 100 * 1024 } as const;

export function strategyStoreStats(strategies: readonly StoredStrategy[]): {
  count: number;
  maxCount: number;
  totalCodeSize: number;
  maxCodeSize: number;
} {
  return {
    count: strategies.length,
    maxCount: STRATEGY_STORE_LIMITS.maxCount,
    totalCodeSize: strategies.reduce((sum, s) => sum + (s.code?.length ?? 0), 0),
    maxCodeSize: STRATEGY_STORE_LIMITS.maxCodeSize,
  };
}

// ---------------------------------------------------------------------------
// 一次性迁移: 旧版存在浏览器 localStorage 的自建策略 -> 服务端
// ---------------------------------------------------------------------------

const LEGACY_STORAGE_KEY = 'chanlun-user-strategies';
const MIGRATION_FLAG = 'chanlun-user-strategies-migrated-to-server';

let migrationPromise: Promise<{ imported: number; skipped: number } | null> | null = null;

/**
 * 把旧版本地策略搬到服务端 (每个浏览器只做一次)。
 *
 * 旧版把自建策略存在 localStorage, 现在策略统一由服务端持有;
 * 首次访问时自动上传一次, 避免升级后「策略不见了」。
 */
export function ensureLocalStrategyMigration(): Promise<{ imported: number; skipped: number } | null> {
  if (migrationPromise) return migrationPromise;

  migrationPromise = (async () => {
    try {
      if (localStorage.getItem(MIGRATION_FLAG)) return null;
      const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (!raw) {
        localStorage.setItem(MIGRATION_FLAG, '1');
        return null;
      }
      const parsed = JSON.parse(raw) as { strategies?: unknown };
      const list = Array.isArray(parsed?.strategies) ? parsed.strategies : [];
      if (list.length === 0) {
        localStorage.setItem(MIGRATION_FLAG, '1');
        return null;
      }
      const result = await importUserStrategies(list);
      localStorage.setItem(MIGRATION_FLAG, '1');
      console.info(
        `[strategies] 已将 ${result.imported} 个本地策略迁移到服务端` +
          (result.skipped ? `, 跳过 ${result.skipped} 个` : ''),
      );
      return { imported: result.imported, skipped: result.skipped };
    } catch (err) {
      // 迁移失败不阻塞界面, 下次刷新会再试
      console.warn('[strategies] 本地策略迁移失败:', err);
      return null;
    }
  })();

  return migrationPromise;
}
