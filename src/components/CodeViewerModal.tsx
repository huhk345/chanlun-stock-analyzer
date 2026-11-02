import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, ShieldAlert, X } from 'lucide-react';
import Prism from 'prismjs';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-rust';
import 'prismjs/themes/prism-tomorrow.css';

export type CodeLanguage = 'javascript' | 'typescript' | 'rust';

interface CodeViewerModalProps {
  open: boolean;
  title: string;
  /** 文件路径 / 策略 id 等副标题 */
  subtitle?: string;
  code: string | null;
  language: CodeLanguage;
  loading?: boolean;
  error?: string;
  onClose: () => void;
}

/** 只读源码弹窗: 语法高亮 + 复制 + Esc 关闭 */
export default function CodeViewerModal({
  open,
  title,
  subtitle,
  code,
  language,
  loading = false,
  error = '',
  onClose,
}: CodeViewerModalProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCopied(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleCopy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* 剪贴板不可用时忽略 */
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/70 backdrop-blur-sm p-2 md:p-6"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 md:px-5 py-3 border-b border-zinc-800">
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-zinc-100 truncate">{title}</h3>
            {subtitle && <p className="text-[11px] text-zinc-500 font-mono truncate">{subtitle}</p>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleCopy}
              disabled={!code}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-zinc-300 bg-zinc-800 hover:bg-zinc-700 disabled:text-zinc-600 rounded-lg border border-zinc-700 cursor-pointer transition-colors"
              id="btn-copy-code"
            >
              <Copy className="h-3.5 w-3.5" />
              <span>{copied ? '已复制' : '复制'}</span>
            </button>
            <button
              onClick={onClose}
              className="p-2 hover:bg-zinc-800 rounded-lg transition-colors"
              title="关闭"
            >
              <X className="h-4 w-4 text-zinc-400" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto bg-zinc-950">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-zinc-500 text-sm gap-2">
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-zinc-500 border-t-transparent" />
              正在加载源码...
            </div>
          ) : error ? (
            <div className="flex items-start gap-2 p-5 text-xs text-red-400">
              <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          ) : code ? (
            <pre className="p-4 text-[11px] leading-relaxed font-mono text-zinc-200 whitespace-pre min-w-fit">
              <code
                dangerouslySetInnerHTML={{
                  __html: Prism.highlight(code, Prism.languages[language], language),
                }}
              />
            </pre>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
