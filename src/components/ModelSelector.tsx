import { Cpu, ChevronDown, Search, RefreshCw } from 'lucide-react';
import { formatPricingLabel } from '../utils/openrouter';
import type { AiModelSelector } from '../hooks/useAiModelSelector';

interface ModelSelectorProps {
  selector: AiModelSelector;
}

/** 完整尺寸的 AI 模型下拉选择器 (IndicatorDialog / StrategyDialog 共用) */
export default function ModelSelector({ selector }: ModelSelectorProps) {
  const {
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
  } = selector;

  return (
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
  );
}
