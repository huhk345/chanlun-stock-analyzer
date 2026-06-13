import { useState, useEffect, useRef, useMemo } from 'react';
import {
  X, Plus, Trash2, Download, Upload, Save, Code, AlertCircle, CheckCircle,
  Cpu, ChevronDown, Search, RefreshCw, Wand2, Settings,
} from 'lucide-react';
import Editor from 'react-simple-code-editor';
import Prism from 'prismjs';
import 'prismjs/components/prism-javascript';
import 'prismjs/themes/prism-tomorrow.css';
import type {
  UserStrategyDefinition,
  StoredStrategy,
  StrategyDialogResponse,
  ChatEntry,
} from '../types/strategy';
import {
  getAllStoredStrategies,
  saveStoredStrategy,
  deleteStoredStrategy,
  exportStoredStrategies,
  importStoredStrategies,
  getStrategyStorageStats,
} from '../utils/strategyStorage';
import {
  validateStrategyCode,
  loadStoredStrategyById,
} from '../utils/strategyLoader';
import {
  generateStrategyCode,
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
import ConfirmDialog from './ConfirmDialog';

interface StrategyDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onStrategyCreated?: (strategy: UserStrategyDefinition) => void;
  /** Called when an existing strategy is saved after editing */
  onStrategySaved?: () => void;
  /** Called when a strategy is deleted */
  onStrategyDeleted?: () => void;
  existingStrategyIds?: string[];
  availableIndicatorIds?: string[];
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

export default function StrategyDialog({
  isOpen,
  onClose,
  onStrategyCreated,
  onStrategySaved,
  onStrategyDeleted,
  existingStrategyIds = [],
  availableIndicatorIds = [],
  symbol,
}: StrategyDialogProps) {
  const [activeTab, setActiveTab] = useState<'create' | 'manage'>('create');
  const [storedStrategies, setStoredStrategies] = useState<StoredStrategy[]>([]);
  const [storageStats, setStorageStats] = useState(getStrategyStorageStats());

  // Create tab state
  const [userDescription, setUserDescription] = useState('');
  const [generatedCode, setGeneratedCode] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationResult, setGenerationResult] = useState<StrategyDialogResponse | null>(null);
  const [streamingCode, setStreamingCode] = useState('');

  // Model selector state
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelFilter, setModelFilter] = useState('');

  // Manage tab state
  const [viewingStrategy, setViewingStrategy] = useState<StoredStrategy | null>(null);
  const [chatHistory, setChatHistory] = useState<ChatEntry[]>([]);
  const [selectedChatIndex, setSelectedChatIndex] = useState<number>(-1);
  const [newPrompt, setNewPrompt] = useState('');
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [detailEditCode, setDetailEditCode] = useState('');
  const [reasoningText, setReasoningText] = useState('');
  const [notification, setNotification] = useState<{ type: 'error' | 'success'; message: string } | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const modelDropdownRef = useRef<HTMLDivElement | null>(null);
  const codeStartedRef = useRef(false);
  const notificationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (notification) {
      if (notificationTimer.current) clearTimeout(notificationTimer.current);
      notificationTimer.current = setTimeout(() => setNotification(null), 3500);
    }
    return () => { if (notificationTimer.current) clearTimeout(notificationTimer.current); };
  }, [notification]);

  // Reset reasoning state when generation starts
  useEffect(() => {
    if (isGenerating || isRegenerating) {
      setReasoningText('');
      codeStartedRef.current = false;
    }
  }, [isGenerating, isRegenerating]);

  // Clear reasoning text when first code chunk arrives
  useEffect(() => {
    if ((isGenerating || isRegenerating) && detailEditCode && !codeStartedRef.current) {
      codeStartedRef.current = true;
      setReasoningText('');
    }
    if (!isGenerating && !isRegenerating) {
      codeStartedRef.current = false;
    }
  }, [detailEditCode, isGenerating, isRegenerating]);

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

  // Load stored strategies on mount
  useEffect(() => {
    if (isOpen) {
      loadStrategies();
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
      setViewingStrategy(null);
      setChatHistory([]);
      setSelectedChatIndex(-1);
      setNewPrompt('');
      setDetailEditCode('');
      setReasoningText('');
      setNotification(null);
      setIsRegenerating(false);
    }
  }, [isOpen]);

  const loadStrategies = () => {
    setStoredStrategies(getAllStoredStrategies());
    setStorageStats(getStrategyStorageStats());
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

  const handleGenerateStrategy = async () => {
    if (!userDescription.trim()) return;

    setIsGenerating(true);
    setGenerationResult(null);
    setStreamingCode('');
    setGeneratedCode('');
    setReasoningText('');

    const chatId = `chat-${Date.now()}`;
    const strategyId = `temp-${Date.now()}`;

    // Create temporary entry with empty code
    const entry: ChatEntry = {
      id: chatId,
      prompt: userDescription,
      code: '',
      model: selectedModel || undefined,
      createdAt: new Date().toISOString(),
    };

    const tempStrategy: StoredStrategy = {
      id: strategyId,
      name: '正在生成...',
      code: '',
      prompt: userDescription,
      model: selectedModel || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      chatHistory: [entry],
    };

    // Jump to the edit page (manage tab with chat list on left) immediately
    setChatHistory([entry]);
    setSelectedChatIndex(0);
    setDetailEditCode('');
    setViewingStrategy(tempStrategy);
    setActiveTab('manage');

    try {
      const fullCode = await generateStrategyCode(
        userDescription,
        availableIndicatorIds,
        (chunk) => {
          setDetailEditCode((prev) => prev + chunk);
        },
        selectedModel,
        (reasoning) => {
          setReasoningText(reasoning);
        },
      );

      const cleaned = extractCodeFromResponse(fullCode);
      setGeneratedCode(cleaned);
      setDetailEditCode(cleaned);

      const finalEntry: ChatEntry = {
        id: chatId,
        prompt: userDescription,
        code: cleaned,
        model: selectedModel || undefined,
        createdAt: new Date().toISOString(),
      };
      setChatHistory([finalEntry]);
      setViewingStrategy({
        id: strategyId,
        name: (cleaned.match(/name:\s*['"]([^'"]+)['"]/)?.[1]) || '未命名策略',
        code: cleaned,
        prompt: userDescription,
        model: selectedModel || undefined,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        chatHistory: [finalEntry],
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'AI 生成失败，请重试';
      setNotification({ type: 'error', message: msg });
      setChatHistory([]);
      setSelectedChatIndex(-1);
      setDetailEditCode('');
      setViewingStrategy(null);
      setActiveTab('create');
    } finally {
      setIsGenerating(false);
      setStreamingCode('');
    }
  };

  const handleDeleteStrategy = (id: string) => {
    setDeleteConfirmId(id);
  };

  const confirmDeleteStrategy = () => {
    if (!deleteConfirmId) return;
    deleteStoredStrategy(deleteConfirmId);
    loadStrategies();
    if (viewingStrategy?.id === deleteConfirmId) {
      setViewingStrategy(null);
    }
    setDeleteConfirmId(null);
    onStrategyDeleted?.();
  };

  const handleEditStrategy = (strategy: StoredStrategy) => {
    let history: ChatEntry[];
    if (strategy.chatHistory && strategy.chatHistory.length > 0) {
      history = [...strategy.chatHistory];
    } else {
      history = [{
        id: 'initial',
        prompt: strategy.prompt || '',
        code: strategy.code,
        model: strategy.model,
        createdAt: strategy.createdAt,
      }];
    }
    setChatHistory(history);
    setSelectedChatIndex(history.length - 1);
    setDetailEditCode(history[history.length - 1].code);
    setViewingStrategy(strategy);
  };

  const handleSaveFromDetail = () => {
    if (!viewingStrategy || selectedChatIndex < 0) return;
    const updatedHistory = chatHistory.map((entry, i) =>
      i === selectedChatIndex ? { ...entry, code: detailEditCode } : entry
    );
    const latestCode = updatedHistory[updatedHistory.length - 1].code;
    const validation = validateStrategyCode(latestCode);
    if (!validation.valid) {
      alert(`代码验证失败:\n${validation.errors.join('\n')}`);
      return;
    }
    const existingStrategies = getAllStoredStrategies();
    const isNew = !existingStrategies.some((s) => s.id === viewingStrategy.id) || viewingStrategy.id.startsWith('temp-');
    if (isNew) {
      const idMatch = latestCode.match(/id:\s*['"]([^'"]+)['"]/);
      const nameMatch = latestCode.match(/name:\s*['"]([^'"]+)['"]/);
      if (!idMatch || !nameMatch) {
        alert('无法从代码中解析策略 ID 和名称');
        return;
      }
      const id = idMatch[1];
      const name = nameMatch[1];
      if (existingStrategies.some((s) => s.id === id) || existingStrategyIds.includes(id)) {
        alert(`策略 ID "${id}" 已存在，请修改代码中的 ID。`);
        return;
      }
      try {
        const stored: StoredStrategy = {
          id,
          name,
          code: latestCode,
          prompt: chatHistory[0]?.prompt,
          model: selectedModel || undefined,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          chatHistory: updatedHistory,
        };
        saveStoredStrategy(stored);
        const definition = loadStoredStrategyById(id);
        if (definition) onStrategyCreated?.(definition);
        loadStrategies();
        onClose();
      } catch (error) {
        alert(error instanceof Error ? error.message : '保存策略失败');
      }
    } else {
      try {
        const updated: StoredStrategy = {
          ...viewingStrategy,
          code: latestCode,
          chatHistory: updatedHistory,
          updatedAt: new Date().toISOString(),
        };
        saveStoredStrategy(updated);
        loadStrategies();
        onStrategySaved?.();
        onClose();
      } catch (error) {
        alert(error instanceof Error ? error.message : '保存失败');
      }
    }
    setChatHistory([]);
    setSelectedChatIndex(-1);
    setDetailEditCode('');
  };

  const handleGenerateNewEntry = async () => {
    if (!newPrompt.trim() || !viewingStrategy) return;
    setIsRegenerating(true);
    const entryId = `chat-${Date.now()}`;
    const newEntry: ChatEntry = {
      id: entryId,
      prompt: newPrompt.trim(),
      code: '',
      model: selectedModel || undefined,
      createdAt: new Date().toISOString(),
    };
    const updatedHistory = [...chatHistory, newEntry];
    setChatHistory(updatedHistory);
    setSelectedChatIndex(updatedHistory.length - 1);
    setDetailEditCode('');
    setReasoningText('');
    setNewPrompt('');
    try {
      const fullCode = await generateStrategyCode(
        newEntry.prompt,
        availableIndicatorIds,
        (chunk) => {
          setDetailEditCode((prev) => prev + chunk);
        },
        selectedModel || undefined,
        (reasoning) => {
          setReasoningText(reasoning);
        },
      );
      const cleaned = extractCodeFromResponse(fullCode);
      const finalHistory = updatedHistory.map((entry, i) =>
        i === updatedHistory.length - 1 ? { ...entry, code: cleaned } : entry
      );
      setChatHistory(finalHistory);
      setDetailEditCode(cleaned);
      const updated: StoredStrategy = {
        ...viewingStrategy,
        code: cleaned,
        chatHistory: finalHistory,
        updatedAt: new Date().toISOString(),
      };
      saveStoredStrategy(updated);
      setViewingStrategy(updated);
      loadStrategies();
      onStrategySaved?.();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'AI 重新生成失败';
      setNotification({ type: 'error', message: msg });
      setChatHistory(updatedHistory.slice(0, -1));
      setSelectedChatIndex(Math.max(0, updatedHistory.length - 2));
      setDetailEditCode(updatedHistory[updatedHistory.length - 2]?.code || '');
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleSelectChatEntry = (index: number) => {
    if (index === selectedChatIndex) return;
    let savedHistory = chatHistory;
    if (selectedChatIndex >= 0 && selectedChatIndex < chatHistory.length && detailEditCode !== chatHistory[selectedChatIndex].code) {
      savedHistory = chatHistory.map((entry, i) =>
        i === selectedChatIndex ? { ...entry, code: detailEditCode } : entry
      );
      setChatHistory(savedHistory);
    }
    setSelectedChatIndex(index);
    setDetailEditCode(savedHistory[index].code);
  };

  const handleRegenerateEntry = async (index: number) => {
    if (!viewingStrategy) return;
    const prompt = chatHistory[index]?.prompt;
    if (!prompt && prompt !== '') return;
    setIsRegenerating(true);
    const entryId = `chat-${Date.now()}`;
    const newEntry: ChatEntry = {
      id: entryId,
      prompt,
      code: '',
      model: selectedModel || undefined,
      createdAt: new Date().toISOString(),
    };
    const updatedHistory = [...chatHistory, newEntry];
    setChatHistory(updatedHistory);
    setSelectedChatIndex(updatedHistory.length - 1);
    setDetailEditCode('');
    setReasoningText('');
    try {
      const fullCode = await generateStrategyCode(
        prompt,
        availableIndicatorIds,
        (chunk) => {
          setDetailEditCode((prev) => prev + chunk);
        },
        selectedModel || undefined,
        (reasoning) => {
          setReasoningText(reasoning);
        },
      );
      const cleaned = extractCodeFromResponse(fullCode);
      const finalHistory = updatedHistory.map((entry, i) =>
        i === updatedHistory.length - 1 ? { ...entry, code: cleaned } : entry
      );
      setChatHistory(finalHistory);
      setDetailEditCode(cleaned);
      const updated: StoredStrategy = {
        ...viewingStrategy,
        code: cleaned,
        chatHistory: finalHistory,
        updatedAt: new Date().toISOString(),
      };
      saveStoredStrategy(updated);
      setViewingStrategy(updated);
      loadStrategies();
      onStrategySaved?.();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'AI 重新生成失败';
      setNotification({ type: 'error', message: msg });
      setChatHistory(updatedHistory.slice(0, -1));
      setSelectedChatIndex(Math.max(0, updatedHistory.length - 2));
      setDetailEditCode(updatedHistory[updatedHistory.length - 2]?.code || '');
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleExport = () => {
    const json = exportStoredStrategies();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chanlun-strategies.json';
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
      const result = importStoredStrategies(text);
      loadStrategies();
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
          <h2 className="text-lg font-bold text-zinc-100">自定义策略</h2>
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
            onMouseDown={(e) => { e.preventDefault(); setActiveTab('create'); }}
            className={`px-6 py-3 font-medium transition-colors ${
              activeTab === 'create'
                ? 'text-cyan-400 border-b-2 border-cyan-400'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            创建策略
          </button>
          <button
            onMouseDown={(e) => { e.preventDefault(); setActiveTab('manage'); }}
            className={`px-6 py-3 font-medium transition-colors ${
              activeTab === 'manage'
                ? 'text-cyan-400 border-b-2 border-cyan-400'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            管理策略 ({storageStats.count}/{storageStats.maxCount})
          </button>
        </div>

        {/* Toast notification */}
        {notification && (
          <div className={`flex items-center gap-2 px-4 py-2.5 text-xs font-medium border-b ${
            notification.type === 'error'
              ? 'bg-red-950/30 border-red-900/40 text-red-300'
              : 'bg-green-950/30 border-green-900/40 text-green-300'
          }`}>
            {notification.type === 'error' ? <AlertCircle className="h-4 w-4 shrink-0" /> : <CheckCircle className="h-4 w-4 shrink-0" />}
            <span className="flex-1">{notification.message}</span>
            <button onClick={() => setNotification(null)} className="p-0.5 hover:opacity-70"><X className="h-3.5 w-3.5" /></button>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'create' && (
            <div className="flex flex-col h-full space-y-4">
              {/* API Key Warning */}
              {!hasAnyApiKey() && (
                <div className="p-3 bg-amber-950/20 border border-amber-900/30 rounded-lg flex items-start gap-3">
                  <Settings className="h-5 w-5 text-amber-400 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-amber-300">未配置 API 密钥</p>
                    <p className="text-xs text-amber-400/70 mt-1">
                      请在顶部导航栏的设置中配置 OpenRouter API Key 或 Gemini API Key 后才能使用 AI 生成策略。
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
              <div className="flex-1 flex flex-col min-h-0">
                <label className="block text-sm font-medium text-zinc-300 mb-2">
                  用自然语言描述你的交易策略
                </label>
                <textarea
                  value={userDescription}
                  onChange={(e) => setUserDescription(e.target.value)}
                  placeholder="例如：我想创建一个策略，当5日均线上穿20日均线且成交量放大时买入，当5日均线下穿20日均线时卖出"
                  className={`w-full flex-1 min-h-[80px] px-4 py-3 bg-zinc-800 border rounded-lg text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 resize-none transition-all ${
                    isGenerating
                      ? 'border-cyan-500/70 animate-pulse'
                      : 'border-zinc-700'
                  }`}
                />
              </div>

              {/* Generate Button */}
              <button
                onClick={handleGenerateStrategy}
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
                    生成策略代码
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


            </div>
          )}

          {activeTab === 'manage' && !viewingStrategy && (
            <div className="space-y-4">
              {/* Actions */}
              <div className="flex items-center gap-2">
                <button
                  onClick={handleExport}
                  disabled={storedStrategies.length === 0}
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

              {/* Strategy List */}
              {storedStrategies.length === 0 ? (
                <div className="text-center py-12 text-zinc-500">
                  <Code className="h-12 w-12 mx-auto mb-3 opacity-50" />
                  <p>暂无保存的策略</p>
                  <p className="text-sm mt-1">在「创建策略」标签页生成并保存策略</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {storedStrategies.map((strategy) => (
                    <div
                      key={strategy.id}
                      onClick={() => handleEditStrategy(strategy)}
                      className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 hover:border-zinc-600 transition-colors cursor-pointer"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <h3 className="text-sm font-semibold text-zinc-200">
                            {strategy.name}
                          </h3>
                          <p className="text-xs text-zinc-500 font-mono mt-0.5">
                            ID: {strategy.id}
                          </p>
                          {strategy.description && (
                            <p className="text-xs text-zinc-400 mt-1 line-clamp-2">
                              {strategy.description}
                            </p>
                          )}
                          <p className="text-xs text-zinc-600 mt-2">
                            更新于: {new Date(strategy.updatedAt).toLocaleString('zh-CN')}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 ml-4">
                          <button
                            onClick={(e) => { e.stopPropagation(); handleEditStrategy(strategy); }}
                            className="p-2 hover:bg-zinc-700 rounded-lg transition-colors"
                            title="编辑"
                          >
                            <Code className="h-4 w-4 text-zinc-400" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDeleteStrategy(strategy.id); }}
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
            </div>
          )}

          {activeTab === 'manage' && viewingStrategy && (
            <div className="flex gap-0 h-[70vh] -m-6">
              {/* Left Panel: Chat History + New Prompt */}
              <div className="w-80 shrink-0 border-r border-zinc-800 flex flex-col bg-zinc-900/50">
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
                  <div className="flex items-center gap-2 min-w-0">
                    <button
                      onClick={() => {
                        if (viewingStrategy && !getAllStoredStrategies().some((s) => s.id === viewingStrategy.id)) {
                          setActiveTab('create');
                        }
                        setViewingStrategy(null);
                      }}
                      className="p-1 hover:bg-zinc-700 rounded-lg transition-colors shrink-0"
                      title="返回列表"
                    >
                      <ChevronDown className="h-4 w-4 text-zinc-400 rotate-90" />
                    </button>
                    <h3 className="text-sm font-bold text-zinc-100 truncate">
                      {viewingStrategy.name}
                    </h3>
                  </div>
                </div>

                {/* Chat History List */}
                <div className="flex-1 overflow-y-auto p-2 space-y-1">
                  {chatHistory.map((entry, i) => (
                    <div
                      key={entry.id}
                      onClick={() => handleSelectChatEntry(i)}
                      className={`w-full flex items-start gap-1 px-3 py-2.5 rounded-lg transition-colors cursor-pointer ${
                        i === selectedChatIndex
                          ? 'bg-cyan-500/10 border border-cyan-500/30'
                          : 'hover:bg-zinc-800 border border-transparent'
                      }`}
                    >
                      <div className="flex-1 min-w-0 text-left">
                        <p className="text-xs text-zinc-300 leading-relaxed select-text">
                          {entry.prompt || '(空提示词)'}
                        </p>
                        {reasoningText && !entry.code && i === selectedChatIndex && (
                          <p className="text-[10px] text-zinc-400 mt-1.5 leading-relaxed line-clamp-3 select-text">
                            {reasoningText.length > 300 ? reasoningText.slice(0, 300) + '...' : reasoningText}
                          </p>
                        )}
                        <p className="text-[10px] text-zinc-600 mt-1">
                          {entry.code ? `✓ ${new Date(entry.createdAt).toLocaleString('zh-CN')}` : (
                            <span className="inline-flex items-center gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                              {reasoningText ? '思考中...' : '生成中...'}
                            </span>
                          )}
                        </p>
                      </div>
                      {entry.code && !isRegenerating && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleRegenerateEntry(i); }}
                          className="p-1 hover:bg-zinc-700 rounded-lg transition-colors shrink-0 mt-0.5"
                          title="重新生成"
                        >
                          <RefreshCw className="h-3.5 w-3.5 text-zinc-500 hover:text-cyan-400" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                {/* New Prompt Input */}
                <div className="p-3 border-t border-zinc-800 space-y-2">
                  <textarea
                    value={newPrompt}
                    onChange={(e) => setNewPrompt(e.target.value)}
                    placeholder="输入新的提示词，继续改进策略..."
                    className={`w-full h-20 px-3 py-2 bg-zinc-800 border rounded-lg text-zinc-100 placeholder-zinc-500 text-xs focus:outline-none focus:ring-2 focus:ring-cyan-500 resize-none transition-all ${
                      isRegenerating
                        ? 'border-cyan-500/70 animate-pulse'
                        : 'border-zinc-700'
                    }`}
                  />
                  <button
                    onClick={handleGenerateNewEntry}
                    disabled={!newPrompt.trim() || isRegenerating}
                    className="w-full px-3 py-2 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 disabled:from-zinc-700 disabled:to-zinc-700 disabled:text-zinc-500 text-white text-xs font-medium rounded-lg transition-all flex items-center justify-center gap-1.5"
                  >
                    {isRegenerating ? (
                      <>
                        <div className="animate-spin rounded-full h-3 w-3 border-2 border-white border-t-transparent" />
                        生成中...
                      </>
                    ) : (
                      <>
                        <Wand2 className="h-3 w-3" />
                        生成新版本
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Right Panel: Code Editor */}
              <div className="flex-1 flex flex-col min-w-0">
                <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
                  <h3 className="text-sm font-medium text-zinc-300">
                    {selectedChatIndex >= 0 && chatHistory[selectedChatIndex]?.code
                      ? '代码'
                      : (isGenerating || isRegenerating) ? '正在生成...' : '选择或生成一个版本'}
                  </h3>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleSaveFromDetail}
                      disabled={selectedChatIndex < 0 || !detailEditCode}
                      className="px-3 py-1.5 bg-green-600 hover:bg-green-700 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-xs font-medium rounded-lg transition-colors flex items-center gap-1.5"
                    >
                      <Save className="h-3 w-3" />
                      保存当前版本
                    </button>
                    <button
                      onClick={() => handleDeleteStrategy(viewingStrategy.id)}
                      className="p-1.5 hover:bg-red-900/30 rounded-lg transition-colors"
                      title="删除策略"
                    >
                      <Trash2 className="h-4 w-4 text-red-400" />
                    </button>
                  </div>
                </div>

                {/* Code editor */}
                <div className="flex-1 overflow-y-auto p-1">
                  {selectedChatIndex >= 0 ? (
                    <div className="editor-container h-full min-h-[400px]">
                      <Editor
                        value={detailEditCode}
                        onValueChange={setDetailEditCode}
                        highlight={(code) => Prism.highlight(code, Prism.languages.javascript, 'javascript')}
                        padding={8}
                        style={{
                          fontFamily: '"Fira Code", "Fira Mono", monospace',
                          fontSize: 12,
                          lineHeight: 1.5,
                          backgroundColor: '#09090b',
                          border: '1px solid #3f3f46',
                          borderRadius: '0.5rem',
                          flex: 1,
                          minHeight: '100%',
                        }}
                        textareaId="detail-code-editor"
                        placeholder="代码将在这里显示..."
                      />
                    </div>
                  ) : (
                    <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
                      点击左侧历史记录查看代码，或在底部输入提示词生成新版本
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      <ConfirmDialog
        isOpen={deleteConfirmId !== null}
        message="确定要删除此策略？"
        onConfirm={confirmDeleteStrategy}
        onCancel={() => setDeleteConfirmId(null)}
      />
    </div>
  );
}
