import { useState, useEffect, useRef, useMemo } from 'react';
import {
  X, Plus, Trash2, Download, Upload, Save, Code, AlertCircle, CheckCircle,
  Cpu, ChevronDown, Search, RefreshCw, Wand2, Settings,
} from 'lucide-react';
import type {
  UserIndicatorDefinition,
  StoredIndicator,
  IndicatorDialogResponse,
} from '../types/indicator';
import {
  getAllStoredIndicators,
  saveStoredIndicator,
  deleteStoredIndicator,
  exportStoredIndicators,
  importStoredIndicators,
  getStorageStats,
} from '../utils/indicatorStorage';
import {
  validateIndicatorCode,
  loadStoredIndicatorById,
} from '../utils/indicatorLoader';
import { isValidIndicatorId } from '../utils/indicatorAdapter';
import {
  generateIndicatorCode,
  extractCodeFromResponse,
} from '../utils/api';
import {
  clearCachedModels,
  fetchOpenRouterFreeModels,
  getStoredSelectedModel,
  setStoredSelectedModel,
  resolveSelectedModel,
  formatPricingLabel,
} from '../utils/openrouter';
import type { OpenRouterModel } from '../utils/openrouter';

interface IndicatorDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onIndicatorCreated?: (indicator: UserIndicatorDefinition) => void;
  existingIndicatorIds?: string[];
  symbol?: string;
}

function getLocalApiKey(key: string): string {
  try {
    const savedKeys = localStorage.getItem('api_keys');
    if (savedKeys) {
      const keys = JSON.parse(savedKeys);
      if (keys[key]) return keys[key];
    }
  } catch { /* ignore */ }
  return '';
}

function hasAnyApiKey(): boolean {
  return !!(getLocalApiKey('openrouter') || getLocalApiKey('gemini') ||
    import.meta.env.VITE_OPENROUTER_API_KEY || import.meta.env.VITE_GEMINI_API_KEY);
}

export default function IndicatorDialog({
  isOpen,
  onClose,
  onIndicatorCreated,
  existingIndicatorIds = [],
  symbol,
}: IndicatorDialogProps) {
  const [activeTab, setActiveTab] = useState<'create' | 'manage'>('create');
  const [storedIndicators, setStoredIndicators] = useState<StoredIndicator[]>([]);
  const [storageStats, setStorageStats] = useState(getStorageStats());

  // Create tab state
  const [userDescription, setUserDescription] = useState('');
  const [generatedCode, setGeneratedCode] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationResult, setGenerationResult] = useState<IndicatorDialogResponse | null>(null);
  const [streamingCode, setStreamingCode] = useState('');

  // Model selector state
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelFilter, setModelFilter] = useState('');

  // Manage tab state
  const [selectedIndicator, setSelectedIndicator] = useState<StoredIndicator | null>(null);
  const [editCode, setEditCode] = useState('');
  const [isEditing, setIsEditing] = useState(false);

  const modelDropdownRef = useRef<HTMLDivElement | null>(null);

  // Load models on mount
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const load = async () => {
      setModelsLoading(true);
      try {
        const list = await fetchOpenRouterFreeModels(getLocalApiKey('openrouter'));
        if (cancelled) return;
        setModels(list);
        const stored = getStoredSelectedModel();
        const initial = stored && list.some((m) => m.id === stored)
          ? stored
          : resolveSelectedModel(list);
        setSelectedModel(initial);
        if (initial) setStoredSelectedModel(initial);
      } catch (err: any) {
        if (cancelled) return;
        console.error('Failed to load models:', err);
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [isOpen]);

  // Close dropdown on outside click
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

  // Load stored indicators on mount
  useEffect(() => {
    if (isOpen) {
      loadIndicators();
    }
  }, [isOpen]);

  // Clear form data when dialog opens
  useEffect(() => {
    if (isOpen) {
      setUserDescription('');
      setGeneratedCode('');
      setGenerationResult(null);
      setStreamingCode('');
      setActiveTab('create');
      setSelectedIndicator(null);
      setEditCode('');
      setIsEditing(false);
    }
  }, [isOpen]);

  const loadIndicators = () => {
    setStoredIndicators(getAllStoredIndicators());
    setStorageStats(getStorageStats());
  };

  const handleSelectModel = (modelId: string) => {
    setSelectedModel(modelId);
    setStoredSelectedModel(modelId);
    setModelDropdownOpen(false);
  };

  const handleRefreshModels = async () => {
    setModelsLoading(true);
    clearCachedModels();
    try {
      const list = await fetchOpenRouterFreeModels(getLocalApiKey('openrouter'));
      setModels(list);
      if (!list.some((m) => m.id === selectedModel)) {
        const fallback = resolveSelectedModel(list);
        setSelectedModel(fallback);
        setStoredSelectedModel(fallback);
      }
    } catch (err: any) {
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

  const handleGenerateIndicator = async () => {
    if (!userDescription.trim()) return;

    setIsGenerating(true);
    setGenerationResult(null);
    setStreamingCode('');
    setGeneratedCode('');

    try {
      const fullCode = await generateIndicatorCode(
        userDescription,
        (chunk) => {
          setStreamingCode((prev) => prev + chunk);
        },
        selectedModel,
      );

      const cleaned = extractCodeFromResponse(fullCode);

      setGeneratedCode(cleaned);
      setGenerationResult({
        success: true,
        code: cleaned,
        explanation: 'AI 已根据你的描述生成指标代码。请检查代码，确认无误后点击"保存指标"。',
      });
    } catch (error) {
      setGenerationResult({
        success: false,
        errors: [error instanceof Error ? error.message : 'AI 生成失败，请重试'],
      });
    } finally {
      setIsGenerating(false);
      setStreamingCode('');
    }
  };

  const handleSaveGenerated = () => {
    const code = generatedCode.trim();
    if (!code) return;

    const validation = validateIndicatorCode(code);
    if (!validation.valid) {
      alert(`代码验证失败:\n${validation.errors.join('\n')}`);
      return;
    }

    const idMatch = code.match(/id:\s*['"]([^'"]+)['"]/);
    const nameMatch = code.match(/name:\s*['"]([^'"]+)['"]/);

    if (!idMatch || !nameMatch) {
      alert('无法从代码中解析指标 ID 和名称');
      return;
    }

    const id = idMatch[1];
    const name = nameMatch[1];

    if (!isValidIndicatorId(id)) {
      alert('无效的指标 ID 格式。请使用小写 kebab-case (例如 "my-indicator")');
      return;
    }

    if (existingIndicatorIds.includes(id)) {
      alert(`指标 ID "${id}" 已存在，请使用不同的 ID。`);
      return;
    }

    try {
      const stored: StoredIndicator = {
        id,
        name,
        code: code,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      saveStoredIndicator(stored);

      const definition = loadStoredIndicatorById(id);
      if (definition) {
        onIndicatorCreated?.(definition);
      }

      onClose();
    } catch (error) {
      alert(error instanceof Error ? error.message : '保存指标失败');
    }
  };

  const handleDeleteIndicator = (id: string) => {
    if (!confirm('确定要删除此指标？')) return;
    deleteStoredIndicator(id);
    loadIndicators();
    if (selectedIndicator?.id === id) {
      setSelectedIndicator(null);
      setEditCode('');
    }
  };

  const handleEditIndicator = (indicator: StoredIndicator) => {
    setSelectedIndicator(indicator);
    setEditCode(indicator.code);
    setIsEditing(true);
  };

  const handleSaveEdit = () => {
    if (!selectedIndicator) return;

    const validation = validateIndicatorCode(editCode);
    if (!validation.valid) {
      alert(`代码验证失败:\n${validation.errors.join('\n')}`);
      return;
    }

    try {
      const updated: StoredIndicator = {
        ...selectedIndicator,
        code: editCode,
        updatedAt: new Date().toISOString(),
      };

      saveStoredIndicator(updated);
      loadIndicators();
      setIsEditing(false);
      alert('指标更新成功！');
    } catch (error) {
      alert(error instanceof Error ? error.message : '更新指标失败');
    }
  };

  const handleExport = () => {
    const json = exportStoredIndicators();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chanlun-indicators.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      const text = await file.text();
      const result = importStoredIndicators(text);
      loadIndicators();
      alert(
        `导入完成:\n` +
        `导入: ${result.imported}\n` +
        `跳过: ${result.skipped}` +
        (result.errors.length > 0 ? `\n错误:\n${result.errors.join('\n')}` : ''),
      );
    };
    input.click();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
          <h2 className="text-lg font-bold text-zinc-100">自定义指标</h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-zinc-800 rounded-lg transition-colors"
          >
            <X className="h-5 w-5 text-zinc-400" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-zinc-800">
          <button
            onClick={() => setActiveTab('create')}
            className={`px-6 py-3 font-medium transition-colors ${
              activeTab === 'create'
                ? 'text-cyan-400 border-b-2 border-cyan-400'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            创建指标
          </button>
          <button
            onClick={() => setActiveTab('manage')}
            className={`px-6 py-3 font-medium transition-colors ${
              activeTab === 'manage'
                ? 'text-cyan-400 border-b-2 border-cyan-400'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            管理指标 ({storageStats.count}/{storageStats.maxCount})
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'create' && (
            <div className="space-y-5">
              {/* API Key Warning */}
              {!hasAnyApiKey() && (
                <div className="p-3 bg-amber-950/20 border border-amber-900/30 rounded-lg flex items-start gap-3">
                  <Settings className="h-5 w-5 text-amber-400 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-amber-300">未配置 API 密钥</p>
                    <p className="text-xs text-amber-400/70 mt-1">
                      请在顶部导航栏的设置中配置 OpenRouter API Key 或 Gemini API Key 后才能使用 AI 生成指标。
                    </p>
                  </div>
                </div>
              )}

              {/* Model Selector */}
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-2">
                  AI 模型
                </label>
                <div className="relative" ref={modelDropdownRef}>
                  <button
                    type="button"
                    onClick={() => setModelDropdownOpen((o) => !o)}
                    className="flex items-center gap-2 px-4 py-2.5 bg-zinc-800 border border-zinc-700 hover:border-cyan-500/50 rounded-lg text-sm text-zinc-200 transition-all cursor-pointer w-full"
                  >
                    <Cpu className="h-4 w-4 text-zinc-500" />
                    <span className="flex-1 text-left">
                      {selectedModelMeta
                        ? `${selectedModelMeta.id.split('/')[0]} / ${selectedModelMeta.id.split('/')[1]?.replace(':free', '')}`
                        : modelsLoading
                          ? '加载模型中...'
                          : '选择 AI 模型'}
                    </span>
                    <ChevronDown className={`h-4 w-4 text-zinc-500 transition-transform ${modelDropdownOpen ? 'rotate-180' : ''}`} />
                  </button>

                  {modelDropdownOpen && (
                    <div className="absolute z-50 left-0 right-0 mt-1.5 bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl shadow-black/60 overflow-hidden">
                      <div className="p-2 border-b border-zinc-800 flex items-center gap-2">
                        <Search className="h-3.5 w-3.5 text-zinc-500" />
                        <input
                          type="text"
                          value={modelFilter}
                          onChange={(e) => setModelFilter(e.target.value)}
                          placeholder="搜索模型..."
                          className="flex-1 bg-transparent text-xs font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
                          autoFocus
                        />
                        <button
                          type="button"
                          onClick={handleRefreshModels}
                          disabled={modelsLoading}
                          className="text-zinc-500 hover:text-cyan-400 transition-colors disabled:opacity-50"
                        >
                          <RefreshCw className={`h-3.5 w-3.5 ${modelsLoading ? 'animate-spin' : ''}`} />
                        </button>
                      </div>
                      <div className="max-h-56 overflow-y-auto">
                        {modelsLoading && (
                          <div className="px-3 py-4 text-xs text-zinc-500 font-mono text-center">加载中...</div>
                        )}
                        {!modelsLoading && filteredModels.length === 0 && (
                          <div className="px-3 py-4 text-xs text-zinc-500 font-mono text-center">
                            {modelFilter ? '没有匹配的模型' : '暂无可用的免费模型'}
                          </div>
                        )}
                        {filteredModels.map((m) => {
                          const active = m.id === selectedModel;
                          return (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => handleSelectModel(m.id)}
                              className={`w-full text-left px-3 py-2 text-xs font-mono transition-colors cursor-pointer flex items-center gap-2 ${
                                active ? 'bg-cyan-500/10 text-cyan-400' : 'text-zinc-300 hover:bg-zinc-900'
                              }`}
                            >
                              <span className="flex-1 min-w-0">
                                <span className="block truncate">{m.id}</span>
                                {m.name && m.name !== m.id && (
                                  <span className="block text-[10px] text-zinc-600 truncate">{m.name}</span>
                                )}
                              </span>
                              <span className="text-[10px] text-zinc-600 shrink-0">{formatPricingLabel(m.pricing)}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Description Input */}
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-2">
                  用自然语言描述你的指标想法
                </label>
                <textarea
                  value={userDescription}
                  onChange={(e) => setUserDescription(e.target.value)}
                  placeholder="例如：我想创建一个指标，显示当收盘价上穿MA20时标记买入信号，下穿MA20时标记卖出信号"
                  className="w-full h-28 px-4 py-3 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 resize-none"
                />
              </div>

              {/* Generate Button */}
              <button
                onClick={handleGenerateIndicator}
                disabled={!userDescription.trim() || isGenerating || !selectedModel || !hasAnyApiKey()}
                className="w-full px-4 py-3 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 disabled:from-zinc-700 disabled:to-zinc-700 disabled:text-zinc-500 text-white font-medium rounded-lg transition-all flex items-center justify-center gap-2"
              >
                {isGenerating ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                    正在生成...
                  </>
                ) : (
                  <>
                    <Wand2 className="h-4 w-4" />
                    生成指标代码
                  </>
                )}
              </button>

              {/* Streaming Code Preview (during generation) */}
              {isGenerating && streamingCode && (
                <div>
                  <label className="block text-sm font-medium text-zinc-300 mb-2">
                    正在生成代码...
                  </label>
                  <div className="w-full h-64 px-4 py-3 bg-zinc-950 border border-cyan-700/50 rounded-lg text-cyan-300 font-mono text-xs overflow-y-auto whitespace-pre-wrap">
                    {streamingCode}
                    <span className="inline-block w-1.5 h-4 bg-cyan-400 ml-0.5 animate-pulse rounded-sm align-text-bottom" />
                  </div>
                </div>
              )}

              {/* Generation Result */}
              {generationResult && !isGenerating && (
                <div
                  className={`p-4 rounded-lg border ${
                    generationResult.success
                      ? 'bg-green-900/20 border-green-800'
                      : 'bg-red-900/20 border-red-800'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {generationResult.success ? (
                      <CheckCircle className="h-5 w-5 text-green-400 mt-0.5 shrink-0" />
                    ) : (
                      <AlertCircle className="h-5 w-5 text-red-400 mt-0.5 shrink-0" />
                    )}
                    <div className="flex-1">
                      {generationResult.explanation && (
                        <p className="text-sm text-zinc-300">{generationResult.explanation}</p>
                      )}
                      {generationResult.errors && (
                        <ul className="text-sm text-red-400 space-y-1">
                          {generationResult.errors.map((err, i) => (
                            <li key={i}>• {err}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Generated Code Editor */}
              {generatedCode && !isGenerating && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-medium text-zinc-300">
                      生成的代码（可编辑）
                    </label>
                    <button
                      onClick={handleSaveGenerated}
                      className="px-4 py-1.5 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-1.5"
                    >
                      <Save className="h-3.5 w-3.5" />
                      保存指标
                    </button>
                  </div>
                  <textarea
                    value={generatedCode}
                    onChange={(e) => setGeneratedCode(e.target.value)}
                    className="w-full h-72 px-4 py-3 bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-100 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-cyan-500 resize-none"
                    spellCheck={false}
                  />
                </div>
              )}
            </div>
          )}

          {activeTab === 'manage' && (
            <div className="space-y-4">
              {/* Actions */}
              <div className="flex items-center gap-2">
                <button
                  onClick={handleExport}
                  disabled={storedIndicators.length === 0}
                  className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 disabled:bg-zinc-800 disabled:text-zinc-600 text-zinc-300 text-sm font-medium rounded-lg transition-colors flex items-center gap-1.5"
                >
                  <Download className="h-4 w-4" />
                  导出
                </button>
                <button
                  onClick={handleImport}
                  className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm font-medium rounded-lg transition-colors flex items-center gap-1.5"
                >
                  <Upload className="h-4 w-4" />
                  导入
                </button>
              </div>

              {/* Indicator List */}
              {storedIndicators.length === 0 ? (
                <div className="text-center py-12 text-zinc-500">
                  <Code className="h-12 w-12 mx-auto mb-3 opacity-50" />
                  <p>暂无保存的指标</p>
                  <p className="text-sm mt-1">在「创建指标」标签页生成并保存指标</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {storedIndicators.map((indicator) => (
                    <div
                      key={indicator.id}
                      className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 hover:border-zinc-600 transition-colors"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <h3 className="text-sm font-semibold text-zinc-200">
                            {indicator.name}
                          </h3>
                          <p className="text-xs text-zinc-500 font-mono mt-0.5">
                            ID: {indicator.id}
                          </p>
                          {indicator.description && (
                            <p className="text-xs text-zinc-400 mt-1 line-clamp-2">
                              {indicator.description}
                            </p>
                          )}
                          <p className="text-xs text-zinc-600 mt-2">
                            更新于: {new Date(indicator.updatedAt).toLocaleString('zh-CN')}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 ml-4">
                          <button
                            onClick={() => handleEditIndicator(indicator)}
                            className="p-2 hover:bg-zinc-700 rounded-lg transition-colors"
                            title="编辑"
                          >
                            <Code className="h-4 w-4 text-zinc-400" />
                          </button>
                          <button
                            onClick={() => handleDeleteIndicator(indicator.id)}
                            className="p-2 hover:bg-red-900/30 rounded-lg transition-colors"
                            title="删除"
                          >
                            <Trash2 className="h-4 w-4 text-red-400" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Edit Modal */}
              {isEditing && selectedIndicator && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
                  <div className="bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
                    <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
                      <h3 className="text-lg font-bold text-zinc-100">
                        编辑: {selectedIndicator.name}
                      </h3>
                      <button
                        onClick={() => setIsEditing(false)}
                        className="p-2 hover:bg-zinc-800 rounded-lg transition-colors"
                      >
                        <X className="h-5 w-5 text-zinc-400" />
                      </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-6">
                      <textarea
                        value={editCode}
                        onChange={(e) => setEditCode(e.target.value)}
                        className="w-full h-96 px-4 py-3 bg-zinc-950 border border-zinc-700 rounded-lg text-zinc-100 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-cyan-500 resize-none"
                        spellCheck={false}
                      />
                    </div>
                    <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-zinc-800">
                      <button
                        onClick={() => setIsEditing(false)}
                        className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-medium rounded-lg transition-colors"
                      >
                        取消
                      </button>
                      <button
                        onClick={handleSaveEdit}
                        className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg transition-colors flex items-center gap-2"
                      >
                        <Save className="h-4 w-4" />
                        保存
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
