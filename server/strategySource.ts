/**
 * 读取内置策略的完整源码。
 *
 * 前端「查看源码」需要能看到策略的完整实现: 策略对象字面量只是一层配置,
 * 真正的信号逻辑写在同一文件上方的辅助函数里, 因此这里返回整份文件源码。
 * 文件内通过 `id: '<strategyId>'` 校验该策略确实存在, 并解析名称/导出名。
 *
 * 策略源码目录 = server/strategies (与执行引擎同源, 浏览器不再持有策略代码)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STRATEGY_DIR = fileURLToPath(new URL('./strategies/', import.meta.url));

export interface StrategySourceResult {
  id: string;
  name: string;
  file: string;
  exportName: string | null;
  source: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从 `{` 开始做字符串/注释感知的花括号配对, 返回闭合 `}` 的下标。 */
function findObjectEnd(source: string, start: number): number {
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = start; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (char === '\\') {
        i++;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === '/' && next === '/') {
      lineComment = true;
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      i++;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

export function findStrategySource(id: string): StrategySourceResult | null {
  let files: string[];
  try {
    files = fs.readdirSync(STRATEGY_DIR).filter((file) => file.endsWith('.ts') && file !== 'index.ts');
  } catch {
    return null;
  }

  const idPattern = new RegExp(`id:\\s*['"]${escapeRegExp(id)}['"]`);

  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(STRATEGY_DIR, file), 'utf8');
    } catch {
      continue;
    }

    const idMatch = idPattern.exec(content);
    if (!idMatch) continue;

    const exportStart = content.lastIndexOf('export const', idMatch.index);
    if (exportStart < 0) continue;

    const openBrace = content.indexOf('{', exportStart);
    if (openBrace < 0) continue;

    const closeBrace = findObjectEnd(content, openBrace);
    if (closeBrace < 0) continue;

    const declaration = content.slice(exportStart, openBrace);
    const exportName = /export const\s+(\w+)/.exec(declaration)?.[1] ?? null;
    const name = new RegExp(`name:\\s*['"]([^'"]+)['"]`).exec(
      content.slice(idMatch.index, closeBrace),
    )?.[1] ?? id;

    return {
      id,
      name,
      file,
      exportName,
      source: content.trimEnd(),
    };
  }

  return null;
}

/**
 * 用户自建策略的「源码」: 完整代码就在 data/user-strategies/<id>.json 里,
 * 直接原样返回 (不需要像内置策略那样做片段截取)。
 */
export function userStrategySource(stored: {
  id: string;
  name: string;
  code: string;
}): StrategySourceResult {
  return {
    id: stored.id,
    name: stored.name,
    file: `data/user-strategies/${stored.id}.json`,
    exportName: null,
    source: stored.code,
  };
}
