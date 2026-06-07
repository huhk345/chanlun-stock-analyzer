import React, { useState, useEffect } from 'react';
import { Settings, Key, CheckCircle2, AlertTriangle, Eye, EyeOff, X } from 'lucide-react';

interface ConfigViewProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ApiKeys {
  tickflow: string;
  gemini: string;
  openrouter: string;
}

export default function ConfigView({ isOpen, onClose }: ConfigViewProps) {
  const [apiKeys, setApiKeys] = useState<ApiKeys>({
    tickflow: '',
    gemini: '',
    openrouter: ''
  });
  const [showKeys, setShowKeys] = useState({
    tickflow: false,
    gemini: false,
    openrouter: false
  });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  // Load keys from localStorage on mount
  useEffect(() => {
    const savedKeys = localStorage.getItem('api_keys');
    if (savedKeys) {
      try {
        setApiKeys(JSON.parse(savedKeys));
      } catch (e) {
        console.error('Failed to parse saved API keys');
      }
    }
  }, []);

  const handleSave = () => {
    try {
      localStorage.setItem('api_keys', JSON.stringify(apiKeys));
      setSaved(true);
      setError('');
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError('保存失败，请重试');
    }
  };

  const handleClear = (key: keyof ApiKeys) => {
    setApiKeys(prev => ({ ...prev, [key]: '' }));
  };

  const toggleShowKey = (key: keyof ApiKeys) => {
    setShowKeys(prev => ({ ...prev, [key]: !prev[key] }));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4">
      <div className="w-full max-w-2xl bg-zinc-900 text-zinc-100 rounded-2xl shadow-2xl border border-zinc-800 relative overflow-hidden animate-fade-in">
        
        {/* Header */}
        <div className="absolute top-0 left-0 w-full h-1.5 bg-emerald-500" />
        <div className="p-6 border-b border-zinc-800">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3">
              <Settings className="h-6 w-6 text-emerald-400" />
              <h3 className="text-lg font-bold text-zinc-100">API 密钥配置</h3>
            </div>
            <button
              onClick={onClose}
              className="text-zinc-500 hover:text-zinc-300 font-bold text-xl px-2 py-1 rounded cursor-pointer transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <p className="text-xs text-zinc-500 mt-2 ml-9">配置您的 API 密钥以使用高级功能</p>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">
          
          {/* TickFlow API Key */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Key className="h-4 w-4 text-zinc-400" />
              <label className="text-sm font-semibold text-zinc-200">TickFlow API Key</label>
              <span className="text-[10px] text-zinc-500">(可选)</span>
            </div>
            <div className="relative">
              <input
                type={showKeys.tickflow ? 'text' : 'password'}
                value={apiKeys.tickflow}
                onChange={(e) => setApiKeys(prev => ({ ...prev, tickflow: e.target.value }))}
                className="w-full px-3 py-2.5 pr-20 text-sm bg-zinc-950 text-zinc-100 border border-zinc-800 rounded-xl focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 font-mono"
                placeholder="留空使用免费 API"
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                <button
                  onClick={() => toggleShowKey('tickflow')}
                  className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  {showKeys.tickflow ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
                {apiKeys.tickflow && (
                  <button
                    onClick={() => handleClear('tickflow')}
                    className="p-1 text-zinc-500 hover:text-red-400 transition-colors"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              获取完整服务 API Key: <a href="https://api.tickflow.org" target="_blank" className="text-emerald-400 hover:underline">https://api.tickflow.org</a>
            </p>
          </div>

          {/* Gemini API Key */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Key className="h-4 w-4 text-zinc-400" />
              <label className="text-sm font-semibold text-zinc-200">Gemini API Key</label>
              <span className="text-[10px] text-zinc-500">(AI 分析必需)</span>
            </div>
            <div className="relative">
              <input
                type={showKeys.gemini ? 'text' : 'password'}
                value={apiKeys.gemini}
                onChange={(e) => setApiKeys(prev => ({ ...prev, gemini: e.target.value }))}
                className="w-full px-3 py-2.5 pr-20 text-sm bg-zinc-950 text-zinc-100 border border-zinc-800 rounded-xl focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 font-mono"
                placeholder="从 Google AI Studio 获取"
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                <button
                  onClick={() => toggleShowKey('gemini')}
                  className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  {showKeys.gemini ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
                {apiKeys.gemini && (
                  <button
                    onClick={() => handleClear('gemini')}
                    className="p-1 text-zinc-500 hover:text-red-400 transition-colors"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              从 Google AI Studio 获取: <a href="https://aistudio.google.com/app/apikey" target="_blank" className="text-emerald-400 hover:underline">https://aistudio.google.com/app/apikey</a>
            </p>
          </div>

          {/* OpenRouter API Key */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Key className="h-4 w-4 text-zinc-400" />
              <label className="text-sm font-semibold text-zinc-200">OpenRouter API Key</label>
              <span className="text-[10px] text-zinc-500">(AI 分析可选)</span>
            </div>
            <div className="relative">
              <input
                type={showKeys.openrouter ? 'text' : 'password'}
                value={apiKeys.openrouter}
                onChange={(e) => setApiKeys(prev => ({ ...prev, openrouter: e.target.value }))}
                className="w-full px-3 py-2.5 pr-20 text-sm bg-zinc-950 text-zinc-100 border border-zinc-800 rounded-xl focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 font-mono"
                placeholder="使用 OpenRouter 的 AI 模型"
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                <button
                  onClick={() => toggleShowKey('openrouter')}
                  className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  {showKeys.openrouter ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
                {apiKeys.openrouter && (
                  <button
                    onClick={() => handleClear('openrouter')}
                    className="p-1 text-zinc-500 hover:text-red-400 transition-colors"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              OpenRouter 支持多种 AI 模型: <a href="https://openrouter.ai/keys" target="_blank" className="text-emerald-400 hover:underline">https://openrouter.ai/keys</a>
            </p>
          </div>

          {/* Status Messages */}
          {saved && (
            <div className="p-3 bg-emerald-950/20 border border-emerald-900/30 rounded-xl flex items-center gap-2 text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              <span className="text-xs font-semibold">配置已保存</span>
            </div>
          )}

          {error && (
            <div className="p-3 bg-red-950/20 border border-red-900/30 rounded-xl flex items-center gap-2 text-red-400">
              <AlertTriangle className="h-4 w-4" />
              <span className="text-xs font-semibold">{error}</span>
            </div>
          )}

          {/* Info Box */}
          <div className="p-4 bg-zinc-950 border border-zinc-800 rounded-xl">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
              <div className="text-xs text-zinc-400 leading-relaxed">
                <p className="font-semibold text-zinc-300 mb-1">安全提示</p>
                <p>API 密钥将保存在浏览器的本地存储中。请勿在公共计算机上保存敏感密钥。如果未设置密钥，系统将尝试从环境变量中读取。</p>
              </div>
            </div>
          </div>

        </div>

        {/* Footer */}
        <div className="p-6 border-t border-zinc-800 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2.5 text-sm text-zinc-400 hover:text-zinc-200 transition-colors font-medium"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            className="px-6 py-2.5 bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-zinc-950 font-bold text-sm rounded-xl shadow-lg shadow-emerald-500/10 cursor-pointer transition-all"
          >
            保存配置
          </button>
        </div>

      </div>
    </div>
  );
}
