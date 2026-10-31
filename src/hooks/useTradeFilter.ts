/**
 * 「可交易范围」设置的 React 绑定。
 *
 * 状态存在 utils/tradeFilter.ts 的模块级 store 里 (localStorage 持久化 + 全局广播),
 * 所以扫描页、回测页拿到的是同一份设置, 在一处改动另一处立刻生效。
 */
import { useSyncExternalStore } from 'react';
import {
  getTradeFilter,
  setTradeFilter,
  subscribeTradeFilter,
  type TradeFilter,
} from '../utils/tradeFilter';

export default function useTradeFilter(): [TradeFilter, (next: TradeFilter) => void] {
  const filter = useSyncExternalStore(subscribeTradeFilter, getTradeFilter, getTradeFilter);
  return [filter, setTradeFilter];
}
