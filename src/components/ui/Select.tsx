import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { useDismiss, usePopoverPosition } from './usePopover';

export type SelectOption = {
  value: string;
  label: string;
  /** 右侧的辅助说明，例如 "12 只" */
  hint?: string;
};

type Props = {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
  className?: string;
  title?: string;
  ariaLabel?: string;
  /** 弹层宽度；不传则跟随触发器宽度（不小于 180px） */
  panelWidth?: number;
};

const SIZES = {
  sm: {
    trigger: 'h-8 px-2 rounded-md text-[13px]',
    item: 'h-8 px-2 rounded-md text-[13px]',
    panel: 'p-1',
  },
  md: {
    trigger: 'h-9 px-2.5 rounded-lg text-[14px]',
    item: 'h-9 px-2.5 rounded-md text-[14px]',
    panel: 'p-1',
  },
} as const;

/**
 * 深色主题下拉框：原生 <select> 的弹出层由系统绘制，字号、行高、配色都改不了，
 * 这里换成自绘 listbox —— 弹层 portal 到 body，不会被左栏的滚动容器裁掉。
 */
export default function Select({
  value,
  onChange,
  options,
  placeholder = '请选择',
  size = 'md',
  disabled = false,
  className = '',
  title,
  ariaLabel,
  panelWidth,
}: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const s = SIZES[size];

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  const style = usePopoverPosition(open, triggerRef, {
    width: panelWidth,
    minSpace: 180,
  });
  useDismiss(open, [triggerRef, panelRef], () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const node = panelRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const commit = (index: number) => {
    const option = options[index];
    if (option) onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        ref={triggerRef}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) {
              setOpen(true);
              return;
            }
            const delta = event.key === 'ArrowDown' ? 1 : -1;
            setActive((prev) => Math.min(Math.max(prev + delta, 0), options.length - 1));
            return;
          }
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            if (open) commit(active);
            else setOpen(true);
            return;
          }
          if (event.key === 'Escape') {
            setOpen(false);
            return;
          }
          if (event.key === 'Tab') setOpen(false);
        }}
        className={`w-full flex items-center gap-1.5 border transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${s.trigger} ${
          open
            ? 'bg-zinc-900 border-blue-500/60 ring-2 ring-blue-500/15'
            : 'bg-zinc-950 border-zinc-800 hover:border-zinc-700'
        }`}
      >
        <span
          className={`flex-1 min-w-0 truncate text-left ${
            selected ? 'text-zinc-100' : 'text-zinc-600'
          }`}
        >
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${
            open ? 'rotate-180 text-blue-400' : 'text-zinc-500'
          }`}
        />
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="listbox"
            aria-label={ariaLabel}
            style={style}
            className={`overflow-y-auto rounded-xl border border-zinc-700/80 bg-zinc-900 shadow-2xl shadow-black/70 ${s.panel}`}
          >
            {options.map((option, index) => {
              const isSelected = option.value === value;
              const isActive = index === active;
              return (
                <div
                  key={option.value}
                  data-index={index}
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => commit(index)}
                  className={`flex items-center gap-2 cursor-pointer transition-colors ${s.item} ${
                    isActive ? 'bg-zinc-800' : ''
                  } ${isSelected ? 'text-blue-300' : 'text-zinc-200'}`}
                >
                  <span className="flex-1 min-w-0 truncate">{option.label}</span>
                  {option.hint && (
                    <span className="shrink-0 font-mono text-[12px] text-zinc-500">{option.hint}</span>
                  )}
                  {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-blue-400" />}
                </div>
              );
            })}
            {options.length === 0 && (
              <div className="px-2.5 py-2 text-[13px] text-zinc-600">暂无选项</div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
