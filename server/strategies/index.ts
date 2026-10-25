/**
 * 策略注册表 (服务端唯一来源)
 *
 * 策略定义全部存放在本目录: 每个 `*.ts` 文件可导出 0..n 个 `UserStrategyDefinition`。
 * 浏览器不再打包任何策略代码 —— 前端通过 GET /api/strategies 取元数据,
 * 通过 POST /api/backtest/* 让服务端用同一份代码跑回测。
 *
 * 用户自建策略 (AI 生成 / 手写) 由 server/strategyStore.ts 持久化,
 * 在这里与内置策略合并成同一份注册表, 保证「内置」与「自建」走完全相同的执行路径。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UserStrategyDefinition } from '../../src/types/strategy.ts';
import { loadUserStrategyDefinitions } from '../strategyStore.ts';

const STRATEGY_DIR = fileURLToPath(new URL('.', import.meta.url));

function isStrategyDefinition(value: unknown): value is UserStrategyDefinition {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.name === 'string' &&
    typeof obj.decide === 'function'
  );
}

/** 内置策略文件名列表 (排除 index / 以下划线开头的内部模块) */
function builtinFiles(): string[] {
  try {
    return fs
      .readdirSync(STRATEGY_DIR)
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => file !== 'index.ts' && !file.startsWith('_'))
      .sort();
  } catch {
    return [];
  }
}

let builtinCache: UserStrategyDefinition[] | null = null;

/**
 * 加载 server/strategies 下的内置策略 (进程内缓存)。
 * 新增策略文件后需重启服务端才会被自动发现。
 */
export async function loadBuiltinStrategies(): Promise<UserStrategyDefinition[]> {
  if (builtinCache) return builtinCache;

  const loaded: UserStrategyDefinition[] = [];
  for (const file of builtinFiles()) {
    try {
      const module = await import(/* @vite-ignore */ path.join(STRATEGY_DIR, file));
      for (const exportName in module) {
        const exportValue = (module as Record<string, unknown>)[exportName];
        if (isStrategyDefinition(exportValue)) loaded.push(exportValue);
      }
    } catch (err) {
      console.warn(`[strategies] 跳过无法加载的策略文件 ${file}:`, (err as Error)?.message ?? err);
    }
  }

  builtinCache = loaded;
  return loaded;
}

/**
 * 完整策略注册表 = 内置策略 + 服务端持久化的用户策略。
 * 同 id 时内置策略优先 (内置代码随仓库走, 用户策略不允许覆盖内置 id)。
 */
export async function loadStrategies(): Promise<UserStrategyDefinition[]> {
  const builtin = await loadBuiltinStrategies();
  const builtinIds = new Set(builtin.map((s) => s.id));
  const user = loadUserStrategyDefinitions().filter((s) => !builtinIds.has(s.id));
  return [...builtin, ...user];
}

/** 按 id 取策略定义 (含用户策略); 未找到返回 null */
export async function findStrategy(id: string): Promise<UserStrategyDefinition | null> {
  const strategies = await loadStrategies();
  return strategies.find((s) => s.id === id) ?? null;
}

/** 策略元数据 (剔除 decide 函数, 可直接 JSON 返回给前端) */
export interface StrategySummary {
  id: string;
  name: string;
  description?: string;
  defaultSelected?: boolean;
  requiresChanLun?: boolean;
  params: readonly unknown[];
  availableIndicators: readonly unknown[];
  requiredIndicators: readonly unknown[];
  /** 'builtin' = 仓库内置, 'user' = 服务端持久化的用户策略 */
  source: 'builtin' | 'user';
}

/** 前端策略下拉 / 参数表单所需的全部元数据 */
export async function listStrategySummaries(): Promise<StrategySummary[]> {
  const builtin = await loadBuiltinStrategies();
  const builtinIds = new Set(builtin.map((s) => s.id));
  const user = loadUserStrategyDefinitions().filter((s) => !builtinIds.has(s.id));

  const toSummary = (s: UserStrategyDefinition, source: 'builtin' | 'user'): StrategySummary => ({
    id: s.id,
    name: s.name,
    description: s.description,
    defaultSelected: s.defaultSelected,
    requiresChanLun: !!s.requiresChanLun,
    params: s.params ?? [],
    availableIndicators: s.availableIndicators ?? [],
    requiredIndicators: s.requiredIndicators ?? [],
    source,
  });

  return [
    ...builtin.map((s) => toSummary(s, 'builtin')),
    ...user.map((s) => toSummary(s, 'user')),
  ];
}
