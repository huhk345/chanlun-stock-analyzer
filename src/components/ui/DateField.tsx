import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { useDismiss, usePopoverPosition } from './usePopover';

type Props = {
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
};

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

const pad = (n: number) => String(n).padStart(2, '0');

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const monthOf = (iso: string) => (iso ? iso.slice(0, 7) : todayIso().slice(0, 7));

const shiftMonth = (month: string, delta: number) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};

/**
 * 日期选择器：原生 `input[type=date]` 的字号 / 弹出层样式在 macOS 上不可控，
 * 这里换成自绘日历 —— 单元格更大、字更大，也支持 min / max 约束。
 */
export default function DateField({
  value,
  onChange,
  min,
  max,
  placeholder = '选择日期',
  className = '',
  ariaLabel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => monthOf(value));
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const style = usePopoverPosition(open, triggerRef, { width: 286, minSpace: 300 });
  useDismiss(open, [triggerRef, panelRef], () => setOpen(false));

  // 打开时把视图拉到当前选中值所在的月份
  useEffect(() => {
    if (open) setMonth(monthOf(value));
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const cells = useMemo(() => {
    const [y, m] = month.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    // 周一为一周起点
    const lead = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(y, m, 0).getDate();
    const out: { iso: string; day: number }[] = [];
    for (let day = 1; day <= daysInMonth; day += 1) {
      out.push({ iso: `${y}-${pad(m)}-${pad(day)}`, day });
    }
    return { lead, list: out };
  }, [month]);

  const today = todayIso();
  const [year, mon] = month.split('-').map(Number);
  const inRange = (iso: string) => (!min || iso >= min) && (!max || iso <= max);

  const pick = (iso: string) => {
    onChange(iso);
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        ref={triggerRef}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className={`w-full h-9 px-2.5 flex items-center gap-1.5 rounded-lg border transition-colors cursor-pointer font-mono text-[14px] ${
          open
            ? 'bg-zinc-900 border-violet-500/60 ring-2 ring-violet-500/15'
            : 'bg-zinc-950 border-zinc-800 hover:border-zinc-700'
        }`}
      >
        <CalendarDays
          className={`h-4 w-4 shrink-0 ${open ? 'text-violet-400' : 'text-zinc-500'}`}
        />
        <span className={`flex-1 text-left ${value ? 'text-zinc-100' : 'text-zinc-600'}`}>
          {value || placeholder}
        </span>
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="选择日期"
            style={style}
            className="rounded-xl border border-zinc-700/80 bg-zinc-900 p-2.5 shadow-2xl shadow-black/70"
          >
            <div className="flex items-center gap-1 mb-2">
              <button
                type="button"
                aria-label="上个月"
                onClick={() => setMonth((prev) => shiftMonth(prev, -1))}
                className="h-7 w-7 rounded-md border border-zinc-800 text-zinc-400 hover:text-zinc-100 hover:border-zinc-700 flex items-center justify-center cursor-pointer"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="flex-1 text-center text-[13px] font-semibold text-zinc-200 font-mono">
                {year} 年 {mon} 月
              </span>
              <button
                type="button"
                aria-label="下个月"
                onClick={() => setMonth((prev) => shiftMonth(prev, 1))}
                className="h-7 w-7 rounded-md border border-zinc-800 text-zinc-400 hover:text-zinc-100 hover:border-zinc-700 flex items-center justify-center cursor-pointer"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="grid grid-cols-7 gap-0.5 mb-1">
              {WEEKDAYS.map((d) => (
                <div
                  key={d}
                  className="h-6 flex items-center justify-center text-[11px] font-semibold text-zinc-500"
                >
                  {d}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-0.5">
              {Array.from({ length: cells.lead }).map((_, i) => (
                <div key={`lead-${i}`} />
              ))}
              {cells.list.map(({ iso, day }) => {
                const disabled = !inRange(iso);
                const isSelected = iso === value;
                const isToday = iso === today;
                return (
                  <button
                    key={iso}
                    type="button"
                    disabled={disabled}
                    onClick={() => pick(iso)}
                    className={`h-8 rounded-md text-[13px] font-mono transition-colors ${
                      disabled
                        ? 'text-zinc-700 cursor-not-allowed'
                        : isSelected
                          ? 'bg-violet-500 text-white font-bold cursor-pointer'
                          : isToday
                            ? 'text-violet-300 ring-1 ring-inset ring-violet-500/50 hover:bg-zinc-800 cursor-pointer'
                            : 'text-zinc-300 hover:bg-zinc-800 cursor-pointer'
                    }`}
                  >
                    {day}
                  </button>
                );
              })}
            </div>

            <div className="mt-2 pt-2 border-t border-zinc-800 flex items-center justify-between">
              <button
                type="button"
                disabled={!inRange(today)}
                onClick={() => pick(today)}
                className="h-7 px-2 rounded-md text-[12px] text-zinc-400 hover:text-violet-300 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                今天
              </button>
              <span className="text-[12px] font-mono text-zinc-600">
                {min || '—'} ~ {max || '—'}
              </span>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
