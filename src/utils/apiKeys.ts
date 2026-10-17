/**
 * API Key 读取 (配置页 ⚙️ 保存在 localStorage 'api_keys', 环境变量兜底)。
 * 供 api.ts 与各 AI 弹窗/顾问组件共用。
 */

/** 读取单个 API Key; 未配置时返回空字符串 */
export function getApiKey(key: string): string {
  try {
    const savedKeys = localStorage.getItem('api_keys');
    if (savedKeys) {
      const keys = JSON.parse(savedKeys) as Record<string, string | undefined>;
      if (keys[key]) return keys[key]!;
    }
  } catch {
    // localStorage 不可用 / JSON 损坏: 视为未配置
  }
  return '';
}

/** 是否配置了任一 AI Key (OpenRouter / Gemini, localStorage 或 Vite 环境变量) */
export function hasAnyAiApiKey(): boolean {
  return !!(
    getApiKey('openrouter') ||
    getApiKey('gemini') ||
    import.meta.env?.VITE_OPENROUTER_API_KEY ||
    import.meta.env?.VITE_GEMINI_API_KEY
  );
}
