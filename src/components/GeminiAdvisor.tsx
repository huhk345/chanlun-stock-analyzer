import React, { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  BrainCircuit,
  RefreshCw,
  AlertTriangle,
  Cpu,
  ChevronDown,
  Search,
  Send,
  Trash2,
  User,
  Bot,
  Wand2,
  CornerDownLeft,
  X,
  Settings,
} from 'lucide-react';
import { Kline, Stroke, Segment, Hub, Fraction } from '../types/stock';
import { chatWithAIStream, ChatMessage } from '../utils/api';
import {
  clearCachedModels,
  fetchOpenRouterFreeModels,
  getStoredSelectedModel,
  setStoredSelectedModel,
  resolveSelectedModel,
  formatPricingLabel,
  OpenRouterModel,
} from '../utils/openrouter';

interface GeminiAdvisorProps {
  symbol: string;
  klines: Kline[];
  strokes: Stroke[];
  segments: Segment[];
  hubs: Hub[];
  fractions?: Fraction[];
  onClose?: () => void;
}

const SUGGESTED_QUESTIONS: { category: string; icon: string; text: string }[] = [
  { category: '趋势', icon: '📈', text: '当前股价处于什么趋势? 给出多空判断与关键价位' },
  { category: '中枢', icon: '🧭', text: '解读最近一个中枢 (ZG/ZD/GG/DD) 的含义与方向' },
  { category: '买卖点', icon: '🎯', text: '目前是否出现一买 / 二买 / 三买 / 一卖 / 二卖 / 三卖? 强度如何?' },
  { category: '背驰', icon: '🪃', text: '近 3 个月是否存在顶背驰或底背驰? 用数据说明' },
  { category: '支撑压力', icon: '🧱', text: '列出关键支撑位 / 压力位, 给出具体价格与依据' },
  { category: '策略', icon: '🛡️', text: '如果我现在建仓, 入场区间、止损位、目标位、仓位建议各是什么?' },
  { category: '突破', icon: '🚀', text: '如果向上 / 向下突破最近中枢, 顺势目标价怎么算?' },
  { category: '风险', icon: '⚠️', text: '最近一次最大回撤发生在哪? 触发原因与当前风险评级' },
  { category: '成交量', icon: '🔊', text: '近期成交量有没有异动? 是否配合价格行为?' },
  { category: '对照', icon: '🆚', text: '和 5 年最高 / 最低相比, 当前价格处于什么分位?' },
  { category: '复盘', icon: '🔁', text: '最近一笔的买卖点事后看是否成立? 给出复盘结论' },
  { category: '对比', icon: '🧪', text: 'MACD / 均线 / 布林带 是否与缠论结构互相印证?' },
];

function getApiKey(key: string): string {
  try {
    const savedKeys = localStorage.getItem('api_keys');
    if (savedKeys) {
      const keys = JSON.parse(savedKeys);
      if (keys[key]) return keys[key];
    }
  } catch {
    // ignore
  }
  return '';
}

function getOpenRouterApiKey(): string {
  return getApiKey('openrouter') || import.meta.env.VITE_OPENROUTER_API_KEY || '';
}

function getGeminiApiKey(): string {
  return getApiKey('gemini') || import.meta.env.VITE_GEMINI_API_KEY || '';
}

export default function GeminiAdvisor({
  symbol,
  klines,
  strokes,
  segments,
  hubs,
  fractions = [],
  onClose,
}: GeminiAdvisorProps) {
  // Model catalog + selection
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelFilter, setModelFilter] = useState('');

  // AI context controls
  const [recentWindow] = useState<number>(90);

  // Chat state
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState('');
  const [streamingContent, setStreamingContent] = useState('');
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);

  const modelDropdownRef = useRef<HTMLDivElement | null>(null);

  const hasApiKey = useMemo(() => Boolean(getOpenRouterApiKey()) || Boolean(getGeminiApiKey()), []);

  // Fetch free OpenRouter models on mount (or whenever the key changes).
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setModelsLoading(true);
      try {
        const list = await fetchOpenRouterFreeModels(getOpenRouterApiKey());
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
    return () => {
      cancelled = true;
    };
  }, [hasApiKey]);

  // Close dropdown on outside click.
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

  // Auto-scroll the chat window to the latest message.
  useEffect(() => {
    if (!chatScrollRef.current) return;
    chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
  }, [chatMessages, chatLoading, streamingContent]);

  const handleSelectModel = (modelId: string) => {
    setSelectedModel(modelId);
    setStoredSelectedModel(modelId);
    setModelDropdownOpen(false);
  };

  const handleRefreshModels = async () => {
    setModelsLoading(true);
    clearCachedModels();
    try {
      const list = await fetchOpenRouterFreeModels(getOpenRouterApiKey());
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

  // -------------------------------------------------------------------------
  // Chat handlers
  // -------------------------------------------------------------------------

  const sendChatMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || chatLoading || klines.length === 0) return;

    const userMsg: ChatMessage = { role: 'user', content: trimmed };
    const nextHistory = [...chatMessages, userMsg];
    setChatMessages(nextHistory);
    setChatInput('');
    setChatError('');
    setStreamingContent('');
    setChatLoading(true);

    try {
      const reply = await chatWithAIStream({
        symbol,
        klines,
        strokes,
        segments,
        hubs,
        fractions,
        model: selectedModel,
        recentWindow,
        messages: nextHistory,
      }, (chunk) => {
        setStreamingContent((prev) => prev + chunk);
      });
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: reply || '(空回复)',
      };
      setStreamingContent('');
      setChatMessages((prev) => [...prev, assistantMsg]);
    } catch (err: any) {
      setChatError(err.message || 'AI 调用失败');
      setStreamingContent('');
      // Roll back the optimistic user message on hard failure.
      setChatMessages((prev) => prev.filter((m) => m !== userMsg));
      setChatInput(trimmed);
    } finally {
      setChatLoading(false);
      // Re-focus the input for fast follow-ups.
      setTimeout(() => chatInputRef.current?.focus(), 0);
    }
  };

  const handleSendChat = () => {
    sendChatMessage(chatInput);
  };

  const handleChatKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSendChat();
    }
  };

  const handleClearChat = () => {
    if (chatLoading) return;
    if (chatMessages.length === 0) return;
    if (!window.confirm('确定清空当前对话? 此操作不可撤销。')) return;
    setChatMessages([]);
    setChatError('');
  };

  const handleSuggestedQuestion = (q: string) => {
    sendChatMessage(q);
  };

  const handleRegenerateLast = async () => {
    if (chatLoading) return;
    let lastUserIdx = -1;
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      if (chatMessages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) return;
    const trimmed = chatMessages
      .slice(0, lastUserIdx + 1)
      .filter((m, i, arr) => i < arr.length - 1 || m.role === 'user');
    const userMsg = chatMessages[lastUserIdx];
    setChatMessages(trimmed);
    setChatError('');
    setStreamingContent('');
    setChatLoading(true);
    try {
      const reply = await chatWithAIStream({
        symbol,
        klines,
        strokes,
        segments,
        hubs,
        fractions,
        model: selectedModel,
        recentWindow,
        messages: trimmed,
      }, (chunk) => {
        setStreamingContent((prev) => prev + chunk);
      });
      setStreamingContent('');
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', content: reply || '(空回复)' },
      ]);
    } catch (err: any) {
      setChatError(err.message || 'AI 调用失败');
      setStreamingContent('');
      setChatMessages(chatMessages);
      void userMsg;
    } finally {
      setChatLoading(false);
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

  const renderFormattedReport = (rawText: string) => {
    if (!rawText) return null;
    return (
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h3 className="text-lg font-black text-blue-400 font-sans mt-7 mb-3 flex items-center gap-2">
              {children}
            </h3>
          ),
          h2: ({ children }) => (
            <h4 className="text-base font-extrabold text-zinc-100 font-sans mt-6 border-b border-zinc-800 pb-1.5 flex items-center gap-2">
              {children}
            </h4>
          ),
          h3: ({ children }) => (
            <h5 className="text-sm font-bold text-zinc-200 font-sans mt-5 mb-2 flex items-center gap-2">
              {children}
            </h5>
          ),
          h4: ({ children }) => (
            <h5 className="text-sm font-bold text-zinc-200 font-sans mt-4 mb-2">
              {children}
            </h5>
          ),
          h5: ({ children }) => (
            <h5 className="text-sm font-semibold text-zinc-300 font-sans mt-3 mb-1">
              {children}
            </h5>
          ),
          h6: ({ children }) => (
            <h6 className="text-xs font-semibold text-zinc-400 font-sans mt-3 mb-1">
              {children}
            </h6>
          ),
          p: ({ children }) => (
            <p className="text-xs font-sans text-zinc-300 leading-relaxed py-1.5 pl-1.5">
              {children}
            </p>
          ),
          strong: ({ children }) => (
            <strong className="text-blue-400 font-semibold font-sans">
              {children}
            </strong>
          ),
          li: ({ children }) => (
            <li className="list-disc list-inside text-xs font-sans text-zinc-400 pl-4 py-1.5 leading-relaxed">
              {children}
            </li>
          ),
          blockquote: ({ children }) => (
            <div className="p-3 bg-zinc-900 border-l-4 border-blue-500 rounded text-xs text-zinc-300 my-2 font-serif italic">
              {children}
            </div>
          ),
          code: ({ children, className }) => {
            const isInline = !className;
            if (isInline) {
              return (
                <code className="bg-zinc-800 text-pink-300 px-1 py-0.5 rounded text-[11px] font-mono">
                  {children}
                </code>
              );
            }
            return (
              <pre className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 my-2 overflow-x-auto">
                <code className="text-xs font-mono text-zinc-200 leading-relaxed">
                  {children}
                </code>
              </pre>
            );
          },
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 underline hover:text-blue-300"
            >
              {children}
            </a>
          ),
          hr: () => <hr className="border-zinc-800 my-4" />,
          table: ({ children }) => (
            <div className="overflow-x-auto my-2">
              <table className="w-full text-xs border-collapse border border-zinc-800 rounded-lg">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-zinc-900">{children}</thead>
          ),
          tbody: ({ children }) => <tbody>{children}</tbody>,
          tr: ({ children }) => (
            <tr className="border-b border-zinc-800">{children}</tr>
          ),
          th: ({ children }) => (
            <th className="px-3 py-2 text-left font-semibold text-zinc-200 border-r border-zinc-800 last:border-r-0">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-2 text-zinc-300 border-r border-zinc-800 last:border-r-0">
              {children}
            </td>
          ),
          ul: ({ children }) => (
            <ul className="list-disc list-inside space-y-0.5 py-1">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal list-inside space-y-0.5 py-1">{children}</ol>
          ),
        }}
      >
        {rawText}
      </Markdown>
    );
  };

  const contextSummary = useMemo(() => {
    return {
      klines: klines.length,
      strokes: strokes.length,
      segments: segments.length,
      hubs: hubs.length,
      fractions: fractions.length,
    };
  }, [klines, strokes, segments, hubs, fractions]);

  return (
    <div className="h-full flex flex-col bg-zinc-900/95 md:backdrop-blur-xl md:border-l md:border-zinc-800/80 md:shadow-lg overflow-hidden mobile-rounded-2xl mobile-mt-4 mobile-mb-4">
      {/* Compact Header */}
      <div className="flex-shrink-0 px-2 py-2 md:px-4 md:py-3 border-b border-zinc-800/50 bg-zinc-900/60">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-blue-500/15 border border-blue-500/30 flex items-center justify-center">
              <BrainCircuit className="h-4 w-4 text-blue-400" />
            </div>
            <div>
              <h3 className="text-xs font-bold text-zinc-100 font-sans">AI 缠论顾问</h3>
            </div>
          </div>

          {/* Model Selector Dropdown */}
          <div className="flex items-center gap-2">
            <div className="relative" ref={modelDropdownRef}>
              <button
                type="button"
                onClick={() => setModelDropdownOpen((o) => !o)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 bg-zinc-950/50 border border-zinc-800 hover:border-blue-500/50 rounded-lg text-[10px] font-mono text-zinc-400 transition-all cursor-pointer"
              >
                <Cpu className="h-3 w-3" />
                <span className="max-w-[80px] truncate">{selectedModelMeta?.id.split('/')[1] || '模型'}</span>
                <ChevronDown className={`h-3 w-3 transition-transform ${modelDropdownOpen ? 'rotate-180' : ''}`} />
              </button>

            {modelDropdownOpen && (
              <div className="absolute z-50 right-0 w-72 mt-1.5 bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl shadow-black/60 overflow-hidden">
                <div className="p-2 border-b border-zinc-800 flex items-center gap-2">
                  <Search className="h-3.5 w-3.5 text-zinc-500" />
                  <input
                    type="text"
                    value={modelFilter}
                    onChange={(e) => setModelFilter(e.target.value)}
                    placeholder="搜索模型..."
                    className="flex-1 bg-transparent text-xs font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleRefreshModels}
                    disabled={modelsLoading}
                    className="text-zinc-500 hover:text-blue-400 transition-colors disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3 w-3 ${modelsLoading ? 'animate-spin' : ''}`} />
                  </button>
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {modelsLoading && (
                    <div className="px-3 py-4 text-xs text-zinc-500 font-mono text-center">加载中…</div>
                  )}
                  {!modelsLoading && filteredModels.length === 0 && (
                    <div className="px-3 py-4 text-xs text-zinc-500 font-mono text-center">没有匹配的模型</div>
                  )}
                  {filteredModels.map((m) => {
                    const active = m.id === selectedModel;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => handleSelectModel(m.id)}
                        className={`w-full text-left px-3 py-2 text-[10px] font-mono transition-colors cursor-pointer flex items-center gap-2 ${
                          active ? 'bg-blue-500/10 text-blue-400' : 'text-zinc-300 hover:bg-zinc-900'
                        }`}
                      >
                        <span className="flex-1 truncate">{m.id}</span>
                        <span className="text-[9px] text-zinc-600 shrink-0">{formatPricingLabel(m.pricing)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            </div>

            {/* Close Button */}
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="flex items-center justify-center w-7 h-7 bg-zinc-950/50 border border-zinc-800 hover:border-red-500/50 rounded-lg text-zinc-500 hover:text-red-400 transition-all cursor-pointer"
                title="隐藏 AI 对话"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Context Summary - Compact */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[9px] font-mono text-zinc-500">
          <span className="text-zinc-600">上下文:</span>
          <span className="px-1.5 py-0.5 rounded bg-zinc-950/50 border border-zinc-800/50">K线 {contextSummary.klines}</span>
          <span className="px-1.5 py-0.5 rounded bg-zinc-950/50 border border-zinc-800/50">笔 {contextSummary.strokes}</span>
          <span className="px-1.5 py-0.5 rounded bg-zinc-950/50 border border-zinc-800/50">中枢 {contextSummary.hubs}</span>
          <span className="px-1.5 py-0.5 rounded bg-zinc-950/50 border border-zinc-800/50">近{recentWindow}日</span>
        </div>
      </div>

      {!hasApiKey && !chatError && (
        <div className="flex-shrink-0 px-2 py-1.5 md:px-4 md:py-2 bg-amber-950/20 border-b border-amber-900/30 text-amber-400 text-[10px] flex gap-2 items-center">
          <Settings className="h-3.5 w-3.5 shrink-0" />
          <span>请先在设置中配置 Gemini API Key 或 OpenRouter API Key 才能使用 AI 问答</span>
        </div>
      )}

      {chatError && (
        <div className="flex-shrink-0 px-2 py-1.5 md:px-4 md:py-2 bg-red-950/20 border-b border-red-900/30 text-red-400 text-[10px] flex gap-2 items-center">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>{chatError}</span>
        </div>
      )}

      {/* Suggested Questions (when chat is empty) */}
      {chatMessages.length === 0 && !chatLoading && (
        <div className="flex-shrink-0 p-2 md:p-4 border-b border-zinc-800/50 bg-zinc-900/20">
          <div className="text-[10px] font-mono uppercase tracking-widest text-zinc-500 mb-3 flex items-center gap-1.5">
            <Wand2 className="h-3 w-3 text-blue-400" />
            推荐提问
          </div>
          <div className="grid grid-cols-1 gap-2">
            {SUGGESTED_QUESTIONS.slice(0, 6).map((q, i) => (
              <button
                key={i}
                type="button"
                onClick={() => handleSuggestedQuestion(q.text)}
                disabled={klines.length === 0 || chatLoading}
                className="text-left p-2.5 rounded-lg bg-zinc-950/50 hover:bg-zinc-900 border border-zinc-800/50 hover:border-blue-500/30 transition-all cursor-pointer group disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <div className="flex items-start gap-2">
                  <span className="text-sm shrink-0">{q.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[9px] font-mono uppercase tracking-wider text-zinc-600 group-hover:text-blue-500 transition-colors">
                      {q.category}
                    </div>
                    <div className="text-[11px] text-zinc-300 leading-snug mt-0.5 line-clamp-2">
                      {q.text}
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Chat Messages Area */}
      <div
        ref={chatScrollRef}
        className="flex-1 overflow-y-auto px-2 py-2 md:px-4 md:py-4 space-y-3 bg-zinc-950/30"
      >
        {chatMessages.map((msg, idx) => (
          <ChatBubble
            key={`${msg.role}-${idx}-${msg.content.slice(0, 20)}`}
            role={msg.role}
            content={msg.content}
            renderMarkdown={renderFormattedReport}
          />
        ))}
        {chatLoading && streamingContent && (
          <ChatBubble
            role="assistant"
            content={streamingContent}
            renderMarkdown={renderFormattedReport}
            isStreaming
          />
        )}
        {chatLoading && !streamingContent && (
          <div className="flex items-start gap-2">
            <div className="shrink-0 w-7 h-7 rounded-lg bg-blue-500/15 border border-blue-500/30 flex items-center justify-center">
              <Bot className="h-3.5 w-3.5 text-blue-400" />
            </div>
            <div className="flex-1 bg-zinc-900/50 border border-zinc-800/50 rounded-2xl rounded-tl-sm px-3.5 py-2.5">
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="h-1.5 w-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="h-1.5 w-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                <span className="text-[10px] font-mono text-zinc-500 ml-2">思考中...</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Chat Input Area - Sticky at bottom */}
      <div className="sticky bottom-0 flex-shrink-0 p-2 md:p-3 border-t border-zinc-800/50 bg-zinc-900/95 md:backdrop-blur-sm">
        {/* Action buttons */}
        {chatMessages.length > 0 && (
          <div className="flex items-center gap-2 mb-2">
            {chatMessages.some((m) => m.role === 'assistant') && (
              <button
                type="button"
                onClick={handleRegenerateLast}
                disabled={chatLoading}
                className="text-[10px] font-mono text-zinc-500 hover:text-blue-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1 px-2 py-1 rounded bg-zinc-950/50 border border-zinc-800/50 hover:border-blue-500/30"
              >
                <Wand2 className="h-3 w-3" />
                重生成
              </button>
            )}
            <button
              type="button"
              onClick={handleClearChat}
              disabled={chatLoading}
              className="text-[10px] font-mono text-zinc-500 hover:text-red-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1 px-2 py-1 rounded bg-zinc-950/50 border border-zinc-800/50 hover:border-red-500/30"
            >
              <Trash2 className="h-3 w-3" />
              清空
            </button>
            <span className="ml-auto text-[9px] font-mono text-zinc-600">{chatMessages.length}/40 条</span>
          </div>
        )}

        {/* Input field */}
        <div className="flex items-end gap-2">
          <textarea
            ref={chatInputRef}
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={handleChatKeyDown}
            placeholder={klines.length === 0 ? '请先加载股票数据…' : '向 AI 提问...'}
            disabled={klines.length === 0 || chatLoading}
            rows={1}
            className="flex-1 resize-none bg-zinc-950/50 border border-zinc-800/50 rounded-xl px-3 py-2.5 text-xs font-sans text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-blue-500/50 transition-colors disabled:opacity-50 max-h-24"
            style={{ minHeight: '38px' }}
            onInput={(e) => {
              const target = e.currentTarget;
              target.style.height = 'auto';
              target.style.height = Math.min(target.scrollHeight, 96) + 'px';
            }}
          />
          <button
            type="button"
            onClick={handleSendChat}
            disabled={chatLoading || chatInput.trim().length === 0 || klines.length === 0 || !hasApiKey}
            className="shrink-0 flex items-center justify-center w-10 h-10 bg-blue-500 hover:bg-blue-400 active:bg-blue-600 text-white rounded-xl shadow-lg shadow-blue-500/20 cursor-pointer transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            title="发送 (Enter)"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-1.5 flex items-center justify-between text-[9px] font-mono text-zinc-600">
          <span className="flex items-center gap-1">
            <CornerDownLeft className="h-2.5 w-2.5" />
            Enter 发送
          </span>
          <span>{chatInput.length} 字符</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat bubble sub-component
// ---------------------------------------------------------------------------

interface ChatBubbleProps {
  role: 'user' | 'assistant' | 'system';
  content: string;
  renderMarkdown: (text: string) => React.ReactNode;
  isStreaming?: boolean;
}

function ChatBubble({ role, content, renderMarkdown, isStreaming }: ChatBubbleProps) {
  if (role === 'user') {
    return (
      <div className="flex items-start gap-2 justify-end">
        <div className="max-w-[85%] bg-blue-500/10 border border-blue-500/30 text-zinc-100 rounded-2xl rounded-tr-sm px-3.5 py-2.5 text-xs font-sans leading-relaxed break-words">
          {renderMarkdown(content)}
        </div>
        <div className="shrink-0 w-7 h-7 rounded-lg bg-blue-500/20 border border-blue-500/40 flex items-center justify-center">
          <User className="h-3.5 w-3.5 text-blue-300" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2">
      <div className="shrink-0 w-7 h-7 rounded-lg bg-zinc-800 border border-zinc-700 flex items-center justify-center">
        <Bot className="h-3.5 w-3.5 text-blue-400" />
      </div>
      <div className="flex-1 min-w-0 bg-zinc-900 border border-zinc-800 rounded-2xl rounded-tl-sm px-3.5 py-2.5 text-zinc-100">
        {renderMarkdown(content)}
        {isStreaming && <span className="inline-block w-1.5 h-4 bg-blue-400 ml-0.5 animate-pulse rounded-sm align-text-bottom" />}
      </div>
    </div>
  );
}
