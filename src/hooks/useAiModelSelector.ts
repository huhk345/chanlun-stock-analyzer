import { useEffect, useMemo, useRef, useState } from 'react';
import {
  clearCachedModels,
  fetchOpenRouterFreeModels,
  getStoredSelectedModel,
  resolveSelectedModel,
  setStoredSelectedModel,
} from '../utils/openrouter';
import type { OpenRouterModel } from '../utils/openrouter';
import { getApiKey } from '../utils/apiKeys';

/**
 * OpenRouter 免费模型选择器: 模型列表加载/刷新、所选模型持久化、
 * 名称过滤、下拉框外点关闭。
 * 供 GeminiAdvisor / IndicatorDialog / StrategyDialog 共用。
 *
 * @param active 变为 true 时 (对话框打开/组件挂载) 自动加载模型列表
 */
export function useAiModelSelector(active: boolean) {
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelFilter, setModelFilter] = useState('');

  const modelDropdownRef = useRef<HTMLDivElement | null>(null);

  // 加载模型列表并恢复上次选择的模型
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const load = async () => {
      setModelsLoading(true);
      try {
        const apiKey = getApiKey('openrouter') || import.meta.env?.VITE_OPENROUTER_API_KEY || '';
        const list = await fetchOpenRouterFreeModels(apiKey);
        if (cancelled) return;
        setModels(list);
        const stored = getStoredSelectedModel();
        const initial = stored && list.some((m) => m.id === stored)
          ? stored
          : resolveSelectedModel(list);
        setSelectedModel(initial);
        if (initial) setStoredSelectedModel(initial);
      } catch (err) {
        if (!cancelled) console.error('Failed to load models:', err);
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [active]);

  // 点击下拉框外部时关闭
  useEffect(() => {
    if (!modelDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setModelDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modelDropdownOpen]);

  const handleSelectModel = (modelId: string) => {
    setSelectedModel(modelId);
    setStoredSelectedModel(modelId);
    setModelDropdownOpen(false);
  };

  const handleRefreshModels = async () => {
    setModelsLoading(true);
    clearCachedModels();
    try {
      const apiKey = getApiKey('openrouter') || import.meta.env?.VITE_OPENROUTER_API_KEY || '';
      const list = await fetchOpenRouterFreeModels(apiKey);
      setModels(list);
      if (!list.some((m) => m.id === selectedModel)) {
        const fallback = resolveSelectedModel(list);
        setSelectedModel(fallback);
        setStoredSelectedModel(fallback);
      }
    } catch (err) {
      console.error('Failed to refresh models:', err);
    } finally {
      setModelsLoading(false);
    }
  };

  const filteredModels = useMemo(() => {
    const q = modelFilter.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) => m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q),
    );
  }, [models, modelFilter]);

  const selectedModelMeta = useMemo(
    () => models.find((m) => m.id === selectedModel),
    [models, selectedModel],
  );

  return {
    modelsLoading,
    selectedModel,
    modelDropdownOpen,
    modelFilter,
    setModelDropdownOpen,
    setModelFilter,
    modelDropdownRef,
    filteredModels,
    selectedModelMeta,
    handleSelectModel,
    handleRefreshModels,
  };
}

export type AiModelSelector = ReturnType<typeof useAiModelSelector>;
