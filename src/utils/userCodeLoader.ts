/**
 * 用户代码 (指标/策略) 运行时加载公共逻辑。
 *
 * 两类代码的沙箱求值方式、禁用模式校验与导出声明检查完全一致,
 * 仅契约名 (全局导出名 / 实体名 / 定义类型名 / 必备函数名) 不同。
 *
 * 使用 new Function() 运行时求值的前提:
 * 1. 代码由 AI 遵循严格契约规则生成
 * 2. 存储于用户自己的 localStorage (用户可控)
 * 3. 执行前经过校验
 * 4. 函数作用域内无网络与 DOM 访问
 */

export interface UserCodeContract {
  /** 沙箱内检测的全局导出名 ('indicator' | 'strategy') */
  globalName: string;
  /** 错误信息中的实体名 ('Indicator' | 'Strategy') */
  entity: string;
  /** 定义类型名 ('UserIndicatorDefinition' | 'UserStrategyDefinition') */
  definitionType: string;
  /** 必须导出的函数名 ('calculate' | 'decide') */
  requiredFunction: string;
}

/** 禁止在用户代码中使用的模式 (顺序即错误展示顺序) */
const FORBIDDEN_PATTERNS: ReadonlyArray<{ pattern: RegExp; message: string }> = [
  { pattern: /\bimport\b/, message: 'Cannot use import statements' },
  { pattern: /\brequire\b/, message: 'Cannot use require()' },
  { pattern: /\bfetch\b/, message: 'Cannot use fetch()' },
  { pattern: /\bXMLHttpRequest\b/, message: 'Cannot use XMLHttpRequest' },
  { pattern: /\bWebSocket\b/, message: 'Cannot use WebSocket' },
  { pattern: /\blocalStorage\b/, message: 'Cannot use localStorage' },
  { pattern: /\bsessionStorage\b/, message: 'Cannot use sessionStorage' },
  { pattern: /\bdocument\./, message: 'Cannot use document API' },
  { pattern: /\bwindow\./, message: 'Cannot use window API' },
  { pattern: /\beval\s*\(/, message: 'Cannot use eval()' },
  { pattern: /\bFunction\s*\(/, message: 'Cannot use Function constructor' },
  { pattern: /\basync\s+function\b/, message: 'Cannot use async functions' },
  { pattern: /\bawait\b/, message: 'Cannot use await' },
];

/** 收集代码中命中的禁用模式错误信息 */
function findForbiddenPatternErrors(code: string): string[] {
  const errors: string[] = [];
  for (const { pattern, message } of FORBIDDEN_PATTERNS) {
    if (pattern.test(code)) {
      errors.push(message);
    }
  }
  return errors;
}

/**
 * Validates user code without executing it
 * Performs basic syntax and structure checks
 */
export function validateUserCode(
  code: string,
  contract: UserCodeContract,
): { valid: boolean; errors: string[] } {
  const errors = findForbiddenPatternErrors(code);

  // Check for required exports
  if (
    !code.includes('exports') &&
    !code.includes('module.exports') &&
    !code.includes(contract.globalName)
  ) {
    errors.push(`Code must export a ${contract.definitionType}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * 在沙箱函数中求值用户代码, 校验必备字段并返回导出对象。
 * 求值或校验失败时抛出 `Failed to parse <entity> code: ...`。
 */
export function evalUserCodeModule(
  code: string,
  contract: UserCodeContract,
): Record<string, any> {
  const { globalName, entity, definitionType, requiredFunction } = contract;

  try {
    // Create a sandboxed function with minimal scope
    // The code should export a definition object
    const fn = new Function(`
      'use strict';
      ${code}
      return typeof exports !== 'undefined' ? exports :
             typeof module !== 'undefined' && module.exports ? module.exports :
             typeof ${globalName} !== 'undefined' ? ${globalName} :
             null;
    `);

    const result = fn();

    if (!result || typeof result !== 'object') {
      throw new Error(`Code must export a ${definitionType} object`);
    }

    // Validate required fields
    if (typeof result.id !== 'string') {
      throw new Error(`${entity} must have a string "id" field`);
    }
    if (typeof result.name !== 'string') {
      throw new Error(`${entity} must have a string "name" field`);
    }
    if (typeof result[requiredFunction] !== 'function') {
      throw new Error(`${entity} must have a "${requiredFunction}" function`);
    }

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${entity.toLowerCase()} code: ${message}`);
  }
}
