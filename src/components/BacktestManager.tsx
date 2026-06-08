import React, { useState, useEffect } from 'react';
import { Play, TrendingUp, History, ShieldAlert, CheckCircle, Database, Trash2, Calendar } from 'lucide-react';
import { Kline, BacktestResult, BacktestTrade } from '../types/stock';
import { saveBacktestResult, fetchBacktests, deleteBacktestResult, SupabaseUser } from '../utils/supabase';

interface BacktestManagerProps {
  klines: Kline[];
  symbol: string;
  currentUser: SupabaseUser | null;
}

export default function BacktestManager({ klines, symbol, currentUser }: BacktestManagerProps) {
  const [initialCapital, setInitialCapital] = useState(10000);
  const [stopLossPercent, setStopLossPercent] = useState(5);
  const [activeTab, setActiveTab] = useState<'run' | 'history'>('run');

  // Simulation outcome
  const [backtest, setBacktest] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'failed'>('idle');

  // Historical records
  const [records, setRecords] = useState<BacktestResult[]>([]);

  // Load history if logged in
  useEffect(() => {
    if (currentUser) {
      fetchBacktests(currentUser.id).then(setRecords);
    } else {
      setRecords([]);
    }
  }, [currentUser, backtest]);

  const handleRunBacktest = () => {
    // 买卖点功能已移除
    setLoading(true);
    setSaveStatus('idle');

    setTimeout(() => {
      const res: BacktestResult = {
        id: `bt-${Math.random().toString(36).substr(2, 9)}`,
        userId: currentUser?.id || 'anonymous',
        symbol,
        startDate: klines[0]?.date || '',
        endDate: klines[klines.length - 1]?.date || '',
        initialBalance: initialCapital,
        finalBalance: initialCapital,
        totalReturnPercent: 0,
        totalTrades: 0,
        winningTrades: 0,
        winRate: 0,
        trades: [],
        createdAt: new Date().toISOString()
      };

      setBacktest(res);
      setLoading(false);
    }, 500);
  };

  const handleSaveBacktest = async () => {
    if (!backtest) return;
    if (!currentUser) {
      alert('需要先登录/注册!请在导航栏注册账户以永久存储回测结果。');
      return;
    }

    try {
      await saveBacktestResult(backtest);
      setSaveStatus('success');
      // Reload history
      fetchBacktests(currentUser.id).then(setRecords);
    } catch {
      setSaveStatus('failed');
    }
  };

  const handleDeleteHistory = async (id: string) => {
    if (!confirm('确定要删除此回测执行吗?')) return;
    const ok = await deleteBacktestResult(id);
    if (ok && currentUser) {
      fetchBacktests(currentUser.id).then(setRecords);
    }
  };

  return (
    <div className="bg-zinc-900 rounded-2xl border border-zinc-800 p-6 shadow-sm text-zinc-100">
      
      {/* Sub Tabs */}
      <div className="flex border-b border-zinc-800 mb-6 gap-6">
        <button
          onClick={() => setActiveTab('run')}
          className={`pb-3 text-xs font-bold font-sans flex items-center gap-2 border-b-2 cursor-pointer transition-all ${
            activeTab === 'run'
              ? 'border-blue-500 text-zinc-100'
              : 'border-transparent text-zinc-500 hover:text-zinc-300'
          }`}
          id="tab-run-backtest"
        >
          <Play className="h-4 w-4 text-blue-400" />
          <span>交互式回测器</span>
        </button>

        <button
          onClick={() => setActiveTab('history')}
          className={`pb-3 text-xs font-bold font-sans flex items-center gap-2 border-b-2 cursor-pointer transition-all ${
            activeTab === 'history'
              ? 'border-blue-500 text-zinc-100'
              : 'border-transparent text-zinc-500 hover:text-zinc-300'
          }`}
          id="tab-history-backtests"
        >
          <History className="h-4 w-4 text-blue-400" />
          <span>模拟账本 ({currentUser ? records.length : '需要登录'})</span>
        </button>
      </div>

      {activeTab === 'run' ? (
        <div className="space-y-6">
          
          {/* Settings Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 bg-zinc-950 p-5 rounded-2xl border border-zinc-800/80">
            <div>
              <label className="block text-xs font-semibold text-zinc-400 mb-2 font-sans">初始资金</label>
              <div className="relative">
                <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-xs font-bold text-zinc-650 font-mono">$</span>
                <input
                  type="number"
                  value={initialCapital}
                  onChange={(e) => setInitialCapital(Math.max(100, parseInt(e.target.value) || 1000))}
                  className="w-full pl-7 pr-3 py-2 text-xs bg-zinc-900 text-zinc-100 border border-zinc-800 rounded-xl focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-zinc-400 mb-2 font-sans">模拟保护止损</label>
              <div className="relative">
                <input
                  type="number"
                  value={stopLossPercent}
                  onChange={(e) => setStopLossPercent(Math.max(1, parseInt(e.target.value) || 5))}
                  className="w-full px-3 py-2 text-xs bg-zinc-900 text-zinc-100 border border-zinc-800 rounded-xl focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                />
                <span className="absolute inset-y-0 right-0 pr-3 flex items-center text-xs font-bold text-zinc-650 font-mono">%</span>
              </div>
            </div>

            <div className="flex items-end">
              <button
                onClick={handleRunBacktest}
                disabled={loading || klines.length === 0}
                className="w-full py-2 bg-blue-500 hover:bg-blue-400 active:bg-blue-600 text-white font-bold text-xs rounded-xl shadow-lg shadow-blue-500/10 cursor-pointer transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                id="btn-run-simulation"
              >
                <Play className="h-4.5 w-4.5 fill-current text-zinc-955" />
                <span>{loading ? '模拟交易中...' : '运行自动回测'}</span>
              </button>
            </div>
          </div>

          {/* Strategy Details Explanation */}
          <div className="flex gap-3 p-3.5 bg-zinc-950/40 border border-zinc-855 rounded-xl">
            <ShieldAlert className="h-4.5 w-4.5 text-blue-400 shrink-0 mt-0.5" />
            <p className="text-[11px] text-zinc-400 leading-relaxed font-sans">
              <strong>缠论交易规则设置:</strong> 在一类或二类买入信号(一买/二买)触发时建立100%多头仓位。在一类或二类卖出信号(一卖/二卖)或跟踪止损触发时完全平仓。使用日线收盘历史价格。
            </p>
          </div>

          {/* Simulation Output Overview */}
          {backtest && (
            <div className="space-y-6 transition-all animate-fade-in text-zinc-100">
              <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-400 border-b border-zinc-800 pb-2">模拟器报告概览</h4>
              
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="p-4 bg-zinc-950 border border-zinc-850 rounded-xl">
                  <span className="text-[10px] text-zinc-500 font-mono uppercase">起始资金</span>
                  <p className="text-sm font-extrabold font-mono text-zinc-200 mt-1">${backtest.initialBalance}</p>
                </div>

                <div className="p-4 bg-zinc-950 border border-zinc-850 rounded-xl">
                  <span className="text-[10px] text-zinc-500 font-mono uppercase">结束余额</span>
                  <p className="text-sm font-extrabold font-mono text-zinc-200 mt-1">${backtest.finalBalance}</p>
                </div>

                <div className="p-4 bg-zinc-950 border border-zinc-850 rounded-xl">
                  <span className="text-[10px] text-zinc-500 font-mono uppercase">净总收益</span>
                  <p className={`text-sm font-extrabold font-mono mt-1 ${backtest.totalReturnPercent >= 0 ? 'text-blue-400' : 'text-red-400'}`}>
                    {backtest.totalReturnPercent >= 0 ? '+' : ''}{backtest.totalReturnPercent}%
                  </p>
                </div>

                <div className="p-4 bg-zinc-950 border border-zinc-850 rounded-xl">
                  <span className="text-[10px] text-zinc-500 font-mono uppercase">胜率(交易)</span>
                  <p className="text-sm font-extrabold font-mono mt-1 text-zinc-200">
                    {backtest.winRate}% <span className="text-[10px] font-normal text-zinc-500 font-sans">({backtest.winningTrades}/{backtest.totalTrades})</span>
                  </p>
                </div>
              </div>

              {/* Action Save Results options */}
              <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-xl bg-zinc-950 border border-zinc-850 text-zinc-100">
                <div className="flex gap-2 items-center">
                  <Database className="h-4.5 w-4.5 text-blue-400" />
                  <span className="text-xs font-semibold">保存此回测配置</span>
                </div>
                
                {currentUser ? (
                  <button
                    onClick={handleSaveBacktest}
                    disabled={saveStatus === 'success'}
                    className={`px-4 py-2 font-semibold text-xs rounded-lg shadow cursor-pointer transition-all ${
                      saveStatus === 'success' 
                        ? 'bg-blue-500 text-white font-bold' 
                        : 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700 border border-zinc-705'
                    }`}
                    id="btn-save-report"
                  >
                    {saveStatus === 'success' ? '保存成功! ✓' : '保存到Supabase'}
                  </button>
                ) : (
                  <span className="text-[11px] text-amber-500 font-medium bg-amber-950/20 border border-amber-900/30 px-3 py-1 rounded">
                    需要账户注册/登录才能永久保存结果!
                  </span>
                )}
              </div>

              {/* Trades Ledger Table */}
              <div>
                <h5 className="text-xs font-bold text-zinc-400 mb-3 uppercase tracking-wider">交易账本</h5>
                <div className="overflow-x-auto rounded-xl border border-zinc-850 bg-zinc-950">
                  <table className="w-full text-left text-xs text-zinc-300">
                    <thead className="bg-zinc-900 border-b border-zinc-850 text-zinc-500 font-mono font-semibold">
                      <tr>
                        <th className="px-4 py-2.5">日期</th>
                        <th className="px-4 py-2.5">类型</th>
                        <th className="px-4 py-2.5">信号来源</th>
                        <th className="px-4 py-2.5">执行价格</th>
                        <th className="px-4 py-2.5">交易分配</th>
                        <th className="px-4 py-2.5 text-right">盈亏结果</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-900 font-mono">
                      {backtest.trades.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="text-center py-6 text-zinc-500 font-sans">未触发任何交易。请尝试延长分析周期。</td>
                        </tr>
                      ) : (
                        backtest.trades.map((tr, i) => (
                          <tr key={`tr-led-${tr.id}-${i}`} className="hover:bg-zinc-900/40">
                            <td className="px-4 py-2 text-zinc-400 font-sans">{tr.date}</td>
                            <td className="px-4 py-2">
                              <span className={`px-2 py-0.5 rounded text-[10px] font-extrabold ${
                                tr.type === 'BUY' ? 'bg-blue-950/30 text-blue-400 border border-blue-900/20' : 'bg-red-950/30 text-red-400 border border-red-900/20'
                              }`}>
                                {tr.type}
                              </span>
                            </td>
                            <td className="px-4 py-2 text-zinc-400 font-sans text-[11px]">{tr.signalType}</td>
                            <td className="px-4 py-2 font-bold">${tr.price}</td>
                            <td className="px-4 py-2 text-zinc-500">{tr.shares} shares (${tr.value})</td>
                            <td className={`px-4 py-2 text-right font-extrabold ${
                              tr.pnl !== undefined 
                                ? (tr.pnl >= 0 ? 'text-blue-400' : 'text-red-400') 
                                : 'text-zinc-500 font-normal'
                            }`}>
                              {tr.pnl !== undefined ? `${tr.pnl >= 0 ? '+' : ''}$${tr.pnl} (${tr.pnlPercent}%)` : '--'}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          {!currentUser ? (
            <div className="p-8 border border-zinc-800 rounded-xl text-center bg-zinc-950/40">
              <Database className="h-8 w-8 text-zinc-700 mx-auto mb-2" />
              <p className="text-sm font-semibold text-zinc-300 font-sans">请登录查看记录</p>
              <p className="text-xs text-zinc-500 mt-1 font-sans">请在右上角完成注册或登录以检索Supabase中同步的历史回测记录。</p>
            </div>
          ) : records.length === 0 ? (
            <div className="p-8 border border-zinc-805 rounded-xl text-center bg-zinc-955 border-zinc-800">
              <Calendar className="h-8 w-8 text-zinc-700 mx-auto mb-2" />
              <p className="text-sm font-semibold text-zinc-300 font-sans font-medium">未找到记录</p>
              <p className="text-xs text-zinc-500 mt-1 font-sans">您之前的回测模拟将在此处保存到数据库时保留。</p>
            </div>
          ) : (
            <div className="divide-y divide-zinc-800/80 text-xs text-zinc-300">
              {records.map((rec) => (
                <div key={rec.id} className="py-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 first:pt-0 last:pb-0" id={`history-item-${rec.id}`}>
                  <div className="space-y-1">
                    <p className="font-extrabold text-sm text-zinc-100 font-mono tracking-tight">{rec.symbol} <span className="text-xs font-normal text-zinc-500 font-sans">({rec.startDate} to {rec.endDate})</span></p>
                    <p className="text-zinc-400 font-sans">
                      起始资金: <strong className="font-mono text-zinc-305">${rec.initialBalance}</strong> | 结束余额: <strong className="font-mono text-zinc-100">${rec.finalBalance}</strong>
                    </p>
                    <p className="text-[11px] text-zinc-505 font-mono text-zinc-500">运行于: {new Date(rec.createdAt).toLocaleString()}</p>
                  </div>

                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <p className={`text-base font-extrabold font-mono leading-none ${rec.totalReturnPercent >= 0 ? 'text-blue-400' : 'text-red-400'}`}>
                        {rec.totalReturnPercent >= 0 ? '+' : ''}{rec.totalReturnPercent}%
                      </p>
                      <p className="text-[10px] text-zinc-500 font-mono mt-1">胜率: {rec.winRate}%</p>
                    </div>

                    <button
                      onClick={() => handleDeleteHistory(rec.id)}
                      className="p-2 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors cursor-pointer"
                      title="删除配置"
                      id={`btn-delete-${rec.id}`}
                    >
                      <Trash2 className="h-4.5 w-4.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

    </div>
  );
}
