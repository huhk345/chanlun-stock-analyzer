/**
 * 「可交易范围」chip 组 —— 扫描页 / 回测页共用。
 *
 * 语义: chip 亮 = 保留, 暗 = 排除 (与同页的买卖点类型筛选一致)。
 * 主板不可取消 (没有任何权限门槛, 取消了就没有「普通股票」可看了)。
 * ST/退市 由 tradeFilter 恒定剔除, 不占 UI 位置 (用户要求不在界面上出现)。
 */
import { ShieldCheck } from 'lucide-react';
import useTradeFilter from '../hooks/useTradeFilter';
import { BOARD_HINTS, OPEN_TRADE_FILTER, isTradeFilterActive } from '../utils/tradeFilter';
import { EXCLUDABLE_BOARDS } from '../utils/symbols';

interface TradeFilterBarProps {
  /** 被当前设置挡掉的数量, 用于「隐藏 N 只」; 0 或不传则不显示 */
  hiddenCount?: number;
  hiddenUnit?: string;
  size?: 'sm' | 'md';
  className?: string;
}

export default function TradeFilterBar({
  hiddenCount = 0,
  hiddenUnit = '只',
  size = 'sm',
  className = '',
}: TradeFilterBarProps) {
  const [filter, setFilter] = useTradeFilter();
  const active = isTradeFilterActive(filter);

  const chip = size === 'md' ? 'px-2.5 h-7 text-[12px]' : 'px-2 py-1 text-[10px]';
  const on = 'border-blue-500/60 bg-blue-500/10 text-blue-300';
  const off = 'border-zinc-800 bg-zinc-900 text-zinc-600 hover:text-zinc-400 hover:border-zinc-700';

  const toggleBoard = (id: (typeof EXCLUDABLE_BOARDS)[number]['id']) => {
    const excluded = filter.boards.includes(id);
    setFilter({
      ...filter,
      boards: excluded ? filter.boards.filter((b) => b !== id) : [...filter.boards, id],
    });
  };

  return (
    <div className={`flex items-center gap-1.5 flex-wrap ${className}`}>
      <span
        className={`flex items-center gap-1 text-zinc-600 font-semibold uppercase tracking-wider mr-0.5 ${
          size === 'md' ? 'text-[12px]' : 'text-[10px]'
        }`}
        title="按你的账户权限过滤: 暗掉的板块会被隐藏, 不出现在列表和回测里"
      >
        <ShieldCheck className="h-3 w-3" />
        可交易
      </span>

      {/* 隐藏数量紧跟标签: 放行尾会在窄屏被挤到第二行, 孤零零一行很难看 */}
      {hiddenCount > 0 && (
        <span
          className={`font-mono text-zinc-600 whitespace-nowrap ${
            size === 'md' ? 'text-[12px]' : 'text-[10px]'
          }`}
          title="被「可交易范围」隐藏的数量; 点后面的 chip 可以放宽"
        >
          隐藏 <span className="text-amber-500/90">{hiddenCount}</span> {hiddenUnit}
        </span>
      )}

      {/* 主板: 无门槛, 始终保留 */}
      <span
        className={`inline-flex items-center rounded-md border font-medium ${chip} border-zinc-700 bg-zinc-800/60 text-zinc-300`}
        title="沪深主板 (600/601/603/605/000/001/002) —— 无开户门槛"
      >
        主板
      </span>

      {EXCLUDABLE_BOARDS.map((b) => {
        const kept = !filter.boards.includes(b.id);
        return (
          <button
            key={b.id}
            type="button"
            onClick={() => toggleBoard(b.id)}
            aria-pressed={kept}
            className={`inline-flex items-center rounded-md border font-medium transition-all cursor-pointer ${chip} ${
              kept ? on : off
            }`}
            title={`${b.hint} · ${BOARD_HINTS[b.id]}${kept ? '\n点击排除' : '\n点击保留'}`}
          >
            {b.label}
          </button>
        );
      })}

      {active && (
        <button
          type="button"
          onClick={() => setFilter(OPEN_TRADE_FILTER)}
          className={`hidden sm:inline-flex items-center rounded-md border border-transparent text-zinc-600 hover:text-zinc-300 transition-colors cursor-pointer ${
            size === 'md' ? 'text-[12px] px-1' : 'text-[10px] px-1'
          }`}
          title="放开创业板 / 科创板 / 北交所"
        >
          全部
        </button>
      )}
    </div>
  );
}
