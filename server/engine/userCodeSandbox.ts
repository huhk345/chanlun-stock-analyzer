/**
 * 用户代码沙箱 (服务端)
 *
 * 用户在浏览器里编写/由 AI 生成策略代码, 保存到服务端后由服务端执行。
 * 与浏览器端 `new Function()` 的做法相比, 这里用 node:vm 提供:
 *   - 独立 realm: 拿不到 require / process / globalThis 上的宿主对象
 *   - 执行超时: 死循环不会卡住整个服务进程
 *
 * 契约与前端 src/utils/userCodeLoader.ts 保持一致:
 * 代码最后必须把定义对象挂到 `exports` / `module.exports` / 全局变量 (strategy / indicator)。
 */
import vm from 'node:vm';

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
  { pattern: /\bprocess\b/, message: 'Cannot use process' },
];

function findForbiddenPatternErrors(code: string): string[] {
  const errors: string[] = [];
  for (const { pattern, message } of FORBIDDEN_PATTERNS) {
    if (pattern.test(code)) errors.push(message);
  }
  return errors;
}

/** 静态校验 (不执行代码): 禁用模式 + 是否声明了导出 */
export function validateUserCode(
  code: string,
  contract: UserCodeContract,
): { valid: boolean; errors: string[] } {
  const errors = findForbiddenPatternErrors(code);

  if (
    !code.includes('exports') &&
    !code.includes('module.exports') &&
    !code.includes(contract.globalName)
  ) {
    errors.push(`Code must export a ${contract.definitionType}`);
  }

  return { valid: errors.length === 0, errors };
}

/** 沙箱内可用的全部宿主能力: 只给纯 JS 内建对象 */
const SANDBOX_TIMEOUT_MS = 5_000;

/**
 * 在 vm 沙箱中求值用户代码, 校验必备字段并返回导出对象。
 * 求值或校验失败时抛出 `Failed to parse <entity> code: ...`。
 */
export function evalUserCodeModule(
  code: string,
  contract: UserCodeContract,
): Record<string, any> {
  const { globalName, entity, definitionType, requiredFunction } = contract;

  const source = `
    'use strict';
    var exports = {};
    var module = { exports: exports };
    ${code}
    var __pick = function (value) {
      return value && typeof value === 'object' && Object.keys(value).length > 0 ? value : null;
    };
    __result = __pick(module.exports) || __pick(exports) ||
      (typeof ${globalName} !== 'undefined' ? __pick(${globalName}) : null);
  `;

  let result: unknown;
  try {
    const sandbox: Record<string, unknown> = { __result: null };
    const context = vm.createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
    });
    vm.runInContext(source, context, {
      timeout: SANDBOX_TIMEOUT_MS,
      filename: `${entity.toLowerCase()}-user-code.js`,
    });
    result = sandbox.__result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${entity.toLowerCase()} code: ${message}`);
  }

  if (!result || typeof result !== 'object') {
    throw new Error(`Failed to parse ${entity.toLowerCase()} code: Code must export a ${definitionType} object`);
  }

  const definition = result as Record<string, any>;
  if (typeof definition.id !== 'string') {
    throw new Error(`Failed to parse ${entity.toLowerCase()} code: ${entity} must have a string "id" field`);
  }
  if (typeof definition.name !== 'string') {
    throw new Error(`Failed to parse ${entity.toLowerCase()} code: ${entity} must have a string "name" field`);
  }
  if (typeof definition[requiredFunction] !== 'function') {
    throw new Error(`Failed to parse ${entity.toLowerCase()} code: ${entity} must have a "${requiredFunction}" function`);
  }

  return definition;
}

/** 策略代码契约 */
export const STRATEGY_CODE_CONTRACT: UserCodeContract = {
  globalName: 'strategy',
  entity: 'Strategy',
  definitionType: 'UserStrategyDefinition',
  requiredFunction: 'decide',
};

/** 指标代码契约 */
export const INDICATOR_CODE_CONTRACT: UserCodeContract = {
  globalName: 'indicator',
  entity: 'Indicator',
  definitionType: 'UserIndicatorDefinition',
  requiredFunction: 'calculate',
};
