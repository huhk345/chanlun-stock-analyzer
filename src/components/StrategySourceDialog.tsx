/**
 * 内置策略源码查看弹窗。
 *
 * 数据来自 GET /api/strategies/:id/source: 服务端从 server/strategies (内置)
 * 或 data/user-strategies (自建) 读取策略代码并原样返回, 前端只负责高亮展示。
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, FileCode2, Loader2, X } from 'lucide-react';
import Prism from 'prismjs';
import 'prismjs/components/prism-javascript';
import 'prismjs/themes/prism-tomorrow.css';

interface StrategySourceResponse {
  id: string;
  name: string;
  file: string;
  exportName: string | null;
  source: string;
}

export default function StrategySourceDialog({
  strategyId,
  strategyName,
  isOpen,
  onClose,
}: {
  strategyId: string;
  strategyName?: string;
  isOpen: boolean;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState<StrategySourceResponse | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isOpen || !strategyId) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setData(null);
    setCopied(false);

    fetch(`/api/strategies/${encodeURIComponent(strategyId)}/source`, { signal: controller.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || `加载失败 (HTTP ${res.status})`);
        return body as StrategySourceResponse;
      })
      .then((body) => setData(body))
      .catch((err) => {
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : '策略源码加载失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [isOpen, strategyId]);

  if (!isOpen) return null;

  const title = data?.name || strategyName || strategyId;

  const handleCopy = async () => {
    if (!data?.source) return;
    try {
      await navigator.clipboard.writeText(data.source);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // 剪贴板不可用时静默失败, 用户仍可手动选中复制
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 backdrop-blur-sm md:p-4">
      <div className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl md:max-h-[90vh]">
        <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3.5 md:px-6 md:py-4">
          <FileCode2 className="h-5 w-5 shrink-0 text-blue-400" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-bold text-zinc-100">
              策略源码 · {title}
            </h2>
            <p className="truncate font-mono text-[10px] text-zinc-500">
              {strategyId}
              {data?.file ? ` · ${data.file}` : ''}
              {data?.exportName ? ` · ${data.exportName}` : ''}
            </p>
          </div>
          <button
            onClick={() => void handleCopy()}
            disabled={!data?.source}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/70 px-2.5 py-1.5 text-[11px] font-semibold text-zinc-300 transition hover:border-blue-500/50 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
            title="复制源码"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? '已复制' : '复制'}
          </button>
          <button
            onClick={onClose}
            className="rounded-lg p-2 transition-colors hover:bg-zinc-800"
            title="关闭"
          >
            <X className="h-5 w-5 text-zinc-400" />
          </button>
        </div>

        <div className="flex-1 overflow-auto bg-[#09090b] p-3 md:p-4">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-16 text-xs text-zinc-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在加载策略源码…
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-xs text-red-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {data?.source && (
            <pre className="overflow-x-auto text-[11px] leading-relaxed">
              <code
                className="language-javascript"
                dangerouslySetInnerHTML={{
                  __html: Prism.highlight(data.source, Prism.languages.javascript, 'javascript'),
                }}
              />
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
