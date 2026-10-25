/**
 * 用户策略持久化 (服务端)
 *
 * 自建策略 (AI 生成 / 手写代码) 不再存在浏览器 localStorage, 而是落在服务端的
 * `data/user-strategies/<id>.json`, 由服务端统一编译与执行:
 *   - 保存时立即做静态校验 + 沙箱编译, 编译不过直接拒绝 (不会存进坏数据)
 *   - 回测 / 组合模拟 / CLI 脚本读到的都是同一份代码
 *
 * 浏览器只保留「编辑器里的文本」, 通过 /api/strategies 系列接口读写。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StoredStrategy, UserStrategyDefinition } from '../src/types/strategy.ts';
import {
  evalUserCodeModule,
  validateUserCode,
  STRATEGY_CODE_CONTRACT,
} from './engine/userCodeSandbox.ts';

const STORE_DIR = fileURLToPath(new URL('../data/user-strategies/', import.meta.url));

/** 与前端 localStorage 版本保持一致的容量限制 */
const MAX_STRATEGIES = 50;
const MAX_CODE_BYTES = 100 * 1024;
/** 策略 id 必须是 kebab-case (同时防止路径穿越) */
const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export class StrategyStoreError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'StrategyStoreError';
    this.statusCode = statusCode;
  }
}

function ensureDir(): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
}

function fileOf(id: string): string {
  if (!ID_PATTERN.test(id)) throw new StrategyStoreError(`非法策略 id: ${id} (需 kebab-case)`);
  return path.join(STORE_DIR, `${id}.json`);
}

function readFileSafe(id: string): StoredStrategy | null {
  try {
    const raw = fs.readFileSync(fileOf(id), 'utf8');
    const parsed = JSON.parse(raw) as StoredStrategy;
    return parsed && typeof parsed.id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** 全部已保存的用户策略 (按 updatedAt 倒序) */
export function listStoredStrategies(): StoredStrategy[] {
  ensureDir();
  let files: string[];
  try {
    files = fs.readdirSync(STORE_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const items: StoredStrategy[] = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(STORE_DIR, file), 'utf8')) as StoredStrategy;
      if (parsed && typeof parsed.id === 'string' && typeof parsed.code === 'string') items.push(parsed);
    } catch {
      // 损坏的文件跳过, 不影响其他策略
    }
  }
  return items.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

export function getStoredStrategy(id: string): StoredStrategy | null {
  return readFileSafe(id);
}

// ---------------------------------------------------------------------------
// 代码 -> 定义 (带缓存)
// ---------------------------------------------------------------------------

const definitionCache = new Map<string, { updatedAt: string; definition: UserStrategyDefinition | null }>();

/** 把一份存储的策略代码编译成可执行定义; 编译失败返回 null */
export function compileStoredStrategy(stored: StoredStrategy): UserStrategyDefinition | null {
  const cached = definitionCache.get(stored.id);
  if (cached && cached.updatedAt === stored.updatedAt) return cached.definition;

  let definition: UserStrategyDefinition | null = null;
  try {
    const parsed = evalUserCodeModule(stored.code, STRATEGY_CODE_CONTRACT);
    definition = {
      id: parsed.id,
      name: parsed.name,
      description: parsed.description ?? stored.description,
      defaultSelected: parsed.defaultSelected ?? stored.defaultSelected ?? false,
      params: parsed.params ?? stored.params,
      availableIndicators: parsed.availableIndicators ?? stored.availableIndicators,
      requiredIndicators: parsed.requiredIndicators ?? stored.requiredIndicators,
      requiresChanLun: parsed.requiresChanLun ?? stored.requiresChanLun,
      decide: parsed.decide,
    };
  } catch (err) {
    console.warn(
      `[strategyStore] 策略 ${stored.id} 编译失败, 已跳过:`,
      err instanceof Error ? err.message : err,
    );
    definition = null;
  }

  definitionCache.set(stored.id, { updatedAt: stored.updatedAt, definition });
  return definition;
}

/** 全部用户策略定义 (编译失败的单条跳过) */
export function loadUserStrategyDefinitions(): UserStrategyDefinition[] {
  const definitions: UserStrategyDefinition[] = [];
  for (const stored of listStoredStrategies()) {
    const definition = compileStoredStrategy(stored);
    if (definition) definitions.push(definition);
  }
  return definitions;
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

export interface SaveStrategyInput {
  id: string;
  name: string;
  code: string;
  description?: string;
  prompt?: string;
  model?: string;
  chatHistory?: StoredStrategy['chatHistory'];
  defaultSelected?: boolean;
  params?: StoredStrategy['params'];
  availableIndicators?: StoredStrategy['availableIndicators'];
  requiredIndicators?: StoredStrategy['requiredIndicators'];
  requiresChanLun?: boolean;
  createdAt?: string;
}

export interface SaveStrategyOptions {
  /** 保留 id (内置策略 id): 命中则拒绝, 避免用户策略被内置策略静默遮蔽 */
  reservedIds?: ReadonlySet<string>;
}

/**
 * 保存 (新建或覆盖) 一份用户策略。
 * 代码必须通过静态校验与沙箱编译, 否则抛 StrategyStoreError (400)。
 */
export function saveStoredStrategy(
  input: SaveStrategyInput,
  options: SaveStrategyOptions = {},
): StoredStrategy {
  if (!input || typeof input.code !== 'string' || !input.code.trim()) {
    throw new StrategyStoreError('code is required');
  }
  if (Buffer.byteLength(input.code, 'utf8') > MAX_CODE_BYTES) {
    throw new StrategyStoreError(`策略代码超过 ${MAX_CODE_BYTES / 1024} KB 上限`);
  }

  const validation = validateUserCode(input.code, STRATEGY_CODE_CONTRACT);
  if (!validation.valid) {
    throw new StrategyStoreError(`策略代码校验失败: ${validation.errors.join('; ')}`);
  }

  // 沙箱编译: 顺带拿到代码里真正的 id / name (以代码为准)
  const parsed = evalUserCodeModule(input.code, STRATEGY_CODE_CONTRACT);
  const id = String(parsed.id);
  if (!ID_PATTERN.test(id)) {
    throw new StrategyStoreError(`策略 id 必须是 kebab-case: ${id}`);
  }

  if (options.reservedIds?.has(id)) {
    throw new StrategyStoreError(`策略 id "${id}" 已被内置策略占用, 请换一个 id`, 409);
  }

  ensureDir();
  const existing = readFileSafe(id);
  if (!existing && listStoredStrategies().length >= MAX_STRATEGIES) {
    throw new StrategyStoreError(`最多保存 ${MAX_STRATEGIES} 个策略, 请先删除不用的`, 409);
  }

  const now = new Date().toISOString();
  const stored: StoredStrategy = {
    id,
    name: String(parsed.name ?? input.name ?? id),
    description: input.description ?? parsed.description,
    code: input.code,
    prompt: input.prompt ?? existing?.prompt,
    model: input.model ?? existing?.model,
    chatHistory: input.chatHistory ?? existing?.chatHistory,
    createdAt: existing?.createdAt ?? input.createdAt ?? now,
    updatedAt: now,
    defaultSelected: input.defaultSelected ?? existing?.defaultSelected ?? false,
    params: input.params ?? existing?.params,
    availableIndicators: input.availableIndicators ?? existing?.availableIndicators,
    requiredIndicators: input.requiredIndicators ?? existing?.requiredIndicators,
    requiresChanLun: input.requiresChanLun ?? existing?.requiresChanLun,
  };

  fs.writeFileSync(fileOf(id), JSON.stringify(stored, null, 2), 'utf8');
  definitionCache.delete(id);
  return stored;
}

export function deleteStoredStrategy(id: string): boolean {
  try {
    fs.unlinkSync(fileOf(id));
    definitionCache.delete(id);
    return true;
  } catch {
    return false;
  }
}

/** 批量导入 (按 id 覆盖), 返回导入 / 跳过 / 错误明细 */
export function importStoredStrategies(items: unknown): {
  imported: number;
  skipped: number;
  errors: string[];
} {
  const list = Array.isArray(items)
    ? items
    : items && typeof items === 'object' && Array.isArray((items as { strategies?: unknown[] }).strategies)
      ? (items as { strategies: unknown[] }).strategies
      : [];

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') {
      skipped++;
      continue;
    }
    try {
      saveStoredStrategy(raw as SaveStrategyInput);
      imported++;
    } catch (err) {
      skipped++;
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { imported, skipped, errors };
}
