/**
 * 用户注册表 (指标/策略) 公共校验。
 */

/** 检查条目 ID 唯一性, 有重复时输出警告 (kind 为错误信息中的实体名) */
export function warnDuplicateIds(kind: string, items: ReadonlyArray<{ id: string }>): void {
  const ids = new Set<string>();
  const duplicates: string[] = [];

  for (const item of items) {
    if (ids.has(item.id)) {
      duplicates.push(item.id);
    }
    ids.add(item.id);
  }

  if (duplicates.length > 0) {
    console.warn(
      `Duplicate ${kind} IDs found: ${duplicates.join(', ')}. ` +
      `Each ${kind} must have a unique ID.`
    );
  }
}
