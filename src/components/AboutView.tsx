import React from 'react';
import { Info, Database, CheckCircle2, BarChart3, Cpu, Code2, Github, ExternalLink, X, Sparkles } from 'lucide-react';

interface AboutViewProps {
  isOpen: boolean;
  onClose: () => void;
  dataSource?: string;
}

const FEATURES = [
  {
    icon: BarChart3,
    title: '分型 / 笔 / 线段 / 中枢',
    desc: '严格遵循缠论原始定义, 自动识别顶底分型、连接成笔、合并笔为线段、并提取多级别中枢结构。',
  },
  {
    icon: Sparkles,
    title: '买卖点与背驰识别',
    desc: '基于一买 / 二买 / 三买与对应卖点判定, 自动检测顶底背驰, 输出可执行的结构化交易信号。',
  },
  {
    icon: Cpu,
    title: 'AI 多因子分析',
    desc: '通过 Google Gemini 或 OpenRouter 路由, 将完整结构化上下文注入提示词, 输出专业中文量化报告。',
  },
  {
    icon: Database,
    title: '回测与历史记录',
    desc: '本地浏览器持久化搜索历史与回测任务, 支持 Supabase 云端账户同步量化策略。',
  },
];

const STACK = [
  { label: 'React 19 + TypeScript', desc: '前端框架与类型系统' },
  { label: 'Vite 6 + Tailwind 4', desc: '极速构建与原子化样式' },
  { label: 'Lightweight Charts', desc: 'K线与成交量高性能渲染' },
  { label: 'D3 + Recharts', desc: '自绘几何与统计图表' },
  { label: 'Lucide + Motion', desc: '图标与微动效' },
];

export default function AboutView({ isOpen, onClose, dataSource }: AboutViewProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4">
      <div className="w-full max-w-2xl bg-zinc-900 text-zinc-100 rounded-2xl shadow-2xl border border-zinc-800 relative overflow-hidden animate-fade-in">

        {/* Header */}
        <div className="absolute top-0 left-0 w-full h-1.5 bg-gradient-to-r from-emerald-400 via-emerald-500 to-emerald-600" />
        <div className="p-6 border-b border-zinc-800">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-emerald-400 via-emerald-500 to-emerald-600 flex items-center justify-center shadow-[0_0_0_1px_rgba(16,185,129,0.3),0_4px_12px_-2px_rgba(16,185,129,0.4)]">
                <Info className="h-5 w-5 text-zinc-950" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-zinc-100">关于缠论量化工作台</h3>
                <p className="text-[10px] font-mono text-emerald-400/80 tracking-wider uppercase mt-0.5">ChanLun Pro · v2.6.0</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="text-zinc-500 hover:text-zinc-300 font-bold text-xl px-2 py-1 rounded cursor-pointer transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">

          {/* Status Row: data source + analysis completion */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="p-3.5 bg-zinc-950/60 border border-zinc-800 rounded-xl">
              <div className="flex items-center gap-2 mb-1.5">
                <Database className="h-3.5 w-3.5 text-zinc-500" />
                <span className="text-[10px] font-mono font-semibold uppercase tracking-wider text-zinc-500">数据源</span>
              </div>
              <p className="text-sm font-mono font-bold text-zinc-200">
                {dataSource || 'TickFlow API'}
              </p>
            </div>
            <div className="p-3.5 bg-zinc-950/60 border border-zinc-800 rounded-xl">
              <div className="flex items-center gap-2 mb-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                <span className="text-[10px] font-mono font-semibold uppercase tracking-wider text-zinc-500">结构分析</span>
              </div>
              <p className="text-sm font-mono font-bold text-emerald-400 flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                结构分析完成
              </p>
            </div>
          </div>

          {/* Description */}
          <div className="space-y-2">
            <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-400">项目简介</h4>
            <p className="text-sm text-zinc-300 leading-relaxed">
              缠论量化工作台是一款基于 <strong className="text-emerald-400">ChanLun (缠论)</strong> 理论构建的 A 股技术分析平台。
              通过自动识别分型、笔、线段、中枢等核心结构, 结合 AI 大模型进行多因子量化解读,
              帮助交易者客观理解市场走势、定位关键支撑压力位并识别潜在买卖点。
            </p>
          </div>

          {/* Features */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-400">核心功能</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {FEATURES.map((f) => (
                <div key={f.title} className="p-3.5 bg-zinc-950/60 border border-zinc-800 rounded-xl">
                  <div className="flex items-center gap-2 mb-1.5">
                    <f.icon className="h-3.5 w-3.5 text-emerald-400" />
                    <span className="text-xs font-semibold text-zinc-200">{f.title}</span>
                  </div>
                  <p className="text-[11px] text-zinc-400 leading-relaxed">{f.desc}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Tech Stack */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-400">技术栈</h4>
            <div className="space-y-1.5">
              {STACK.map((s) => (
                <div key={s.label} className="flex items-center justify-between px-3 py-2 bg-zinc-950/40 border border-zinc-800/60 rounded-lg">
                  <div className="flex items-center gap-2">
                    <Code2 className="h-3.5 w-3.5 text-zinc-500" />
                    <span className="text-xs font-mono font-semibold text-zinc-200">{s.label}</span>
                  </div>
                  <span className="text-[10px] text-zinc-500">{s.desc}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Footer / Credits */}
          <div className="pt-2 border-t border-zinc-800 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <a
                href="https://github.com"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-zinc-300 bg-zinc-950/60 border border-zinc-800 hover:border-emerald-500/60 hover:text-emerald-400 rounded-lg transition-colors"
              >
                <Github className="h-3.5 w-3.5" />
                <span>源代码</span>
                <ExternalLink className="h-2.5 w-2.5 opacity-60" />
              </a>
              <a
                href="https://aistudio.google.com/app/apikey"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-zinc-300 bg-zinc-950/60 border border-zinc-800 hover:border-emerald-500/60 hover:text-emerald-400 rounded-lg transition-colors"
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>Google AI Studio</span>
                <ExternalLink className="h-2.5 w-2.5 opacity-60" />
              </a>
              <a
                href="https://openrouter.ai/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] text-zinc-300 bg-zinc-950/60 border border-zinc-800 hover:border-emerald-500/60 hover:text-emerald-400 rounded-lg transition-colors"
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>OpenRouter</span>
                <ExternalLink className="h-2.5 w-2.5 opacity-60" />
              </a>
            </div>
            <p className="text-[10px] text-zinc-500 font-mono leading-relaxed">
              © 2026 缠论量化工作台。由 Google AI Studio 构建。
              <br />
              本工具仅供学习研究使用, 不构成任何投资建议, 投资有风险, 入市需谨慎。
            </p>
          </div>

        </div>
      </div>
    </div>
  );
}
