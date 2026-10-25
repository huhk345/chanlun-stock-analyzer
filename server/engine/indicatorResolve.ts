/**
 * 把前端携带的「用户指标代码」解析成指标定义。
 *
 * 指标仍在浏览器侧维护 (图表要用同一份代码画线), 但回测在服务端执行,
 * 所以回测请求会把选中指标的 `{ id, code }` 一并带上, 由服务端沙箱编译。
 * 编译失败的指标直接跳过并返回原因, 不影响回测本身。
 */
import type { UserIndicatorDefinition } from '../../src/types/indicator.ts';
import { evalUserCodeModule, INDICATOR_CODE_CONTRACT } from './userCodeSandbox.ts';

export interface IndicatorCodeInput {
  id: string;
  code: string;
}

export interface ResolvedIndicatorSet {
  definitions: UserIndicatorDefinition[];
  errors: Array<{ id: string; message: string }>;
}

function isIndicatorCodeInput(value: unknown): value is IndicatorCodeInput {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as IndicatorCodeInput).id === 'string' &&
    typeof (value as IndicatorCodeInput).code === 'string'
  );
}

/**
 * @param codes 请求体里的 indicatorCodes (任意形态, 非法条目会被忽略)
 */
export function resolveIndicatorDefinitions(codes: unknown): ResolvedIndicatorSet {
  const definitions: UserIndicatorDefinition[] = [];
  const errors: Array<{ id: string; message: string }> = [];

  if (!Array.isArray(codes)) return { definitions, errors };

  for (const item of codes) {
    if (!isIndicatorCodeInput(item)) continue;
    try {
      const parsed = evalUserCodeModule(item.code, INDICATOR_CODE_CONTRACT);
      definitions.push({
        id: parsed.id,
        name: parsed.name,
        description: parsed.description,
        defaultVisible: parsed.defaultVisible,
        params: parsed.params,
        calculate: parsed.calculate,
      });
    } catch (err) {
      errors.push({ id: item.id, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return { definitions, errors };
}
