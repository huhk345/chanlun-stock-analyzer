// OpenRouter utilities: fetch free models and persist user selection.

const OPENROUTER_MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models';
const SELECTED_MODEL_KEY = 'openrouter_selected_model';

let cachedModelsPromise: Promise<OpenRouterModel[]> | null = null;

export interface OpenRouterModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: {
    prompt?: string | number;
    completion?: string | number;
  };
  top_provider?: {
    is_moderated?: boolean;
    max_completion_tokens?: number;
  };
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
  created?: number;
}

export interface OpenRouterModelsResponse {
  data: OpenRouterModel[];
}

/**
 * Fetch the catalog of free models from OpenRouter.
 * Free models are tagged with the `:free` suffix on the `id`.
 * The endpoint is public (no auth required) but we attach the key
 * when available to lift per-key rate limits.
 */
export async function fetchOpenRouterFreeModels(apiKey?: string): Promise<OpenRouterModel[]> {
  if (cachedModelsPromise) {
    return cachedModelsPromise;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  cachedModelsPromise = (async () => {
    const response = await fetch(OPENROUTER_MODELS_ENDPOINT, { headers });
    if (!response.ok) {
      const text = await response.text();
      console.error('[OpenRouter] models fetch failed:', response.status, text);
      throw new Error(`无法获取 OpenRouter 模型列表 (HTTP ${response.status})`);
    }

    const json: OpenRouterModelsResponse = await response.json();
    const models = (json.data || []).filter((m) => typeof m?.id === 'string' && m.id.endsWith(':free'));

    // Newest first to surface fresh releases at the top of the dropdown.
    models.sort((a, b) => (b.created || 0) - (a.created || 0));

    return models;
  })();

  return cachedModelsPromise;
}

export function clearCachedModels(): void {
  cachedModelsPromise = null;
}

export function getStoredSelectedModel(): string {
  try {
    return localStorage.getItem(SELECTED_MODEL_KEY) || '';
  } catch {
    return '';
  }
}

export function setStoredSelectedModel(modelId: string): void {
  try {
    if (modelId) {
      localStorage.setItem(SELECTED_MODEL_KEY, modelId);
    } else {
      localStorage.removeItem(SELECTED_MODEL_KEY);
    }
  } catch (e) {
    console.warn('[OpenRouter] Failed to persist selected model', e);
  }
}

export function getDefaultFreeModel(): string {
  return 'google/gemini-2.0-flash-exp:free';
}

/**
 * Resolve the model that should be used for the next call:
 * stored preference > provided default > first free model in catalog > hardcoded default.
 */
export function resolveSelectedModel(
  catalog: OpenRouterModel[],
  fallback?: string,
): string {
  const stored = getStoredSelectedModel();
  if (stored && catalog.some((m) => m.id === stored)) {
    return stored;
  }
  if (fallback && catalog.some((m) => m.id === fallback)) {
    return fallback;
  }
  if (catalog.length > 0) {
    return catalog[0].id;
  }
  return getDefaultFreeModel();
}

/**
 * Convert a numeric pricing string (OpenRouter returns pricing as a stringified number)
 * into a human-readable label such as "$0 / M" or "免费".
 */
export function formatPricingLabel(pricing?: OpenRouterModel['pricing']): string {
  if (!pricing) return '免费';
  const prompt = Number(pricing.prompt);
  const completion = Number(pricing.completion);
  if ((!prompt || prompt === 0) && (!completion || completion === 0)) {
    return '免费';
  }
  return `$${prompt}/$${completion} per 1M`;
}
