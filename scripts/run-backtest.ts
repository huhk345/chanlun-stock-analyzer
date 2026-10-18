/**
 * 单股策略回测 CLI (基于腾讯行情)
 *
 * 从腾讯 fqkline 接口拉取历史 K 线, 运行指定策略回测, 打印绩效报告与逐笔成交。
 *
 * 启动后端: pnpm server   (默认 http://localhost:8899)
 * 然后:      pnpm exec tsx scripts/run-backtest.ts --symbol 000001.sz --strategy ma-cross
 *
 * 示例:
 *   pnpm exec tsx scripts/run-backtest.ts \
 *     --symbol 000001.sz --strategy ma-cross --cash 100000 --count 500 \
 *     --commission 2.5 --start 2023-01-01 --end 2025-12-31
 */

import { runServerBacktest, type ServerBacktestInput } from '../server/backtest.ts';

function parseArgs(): Record<string, string> {
  const args = process.argv.slice(2);
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1];
      if (val && !val.startsWith('--')) {
        options[key] = val;
        i++;
      } else {
        options[key] = 'true';
      }
    }
  }
  return options;
}

function fmt(n: number): string {
  return n.toFixed(2);
}

function pct(n: number): string {
  return `${n >= 0 ? '+' : ''}${fmt(n)}%`;
}

async function main(): Promise<void> {
  const options = parseArgs();

  if (options.help || options.h || Object.keys(options).length === 0) {
    console.log(`
单股策略回测 CLI (基于腾讯行情)
===============================
成交模型 (与网页端引擎一致):
  信号当日收盘价成交 (尾盘/收盘竞价模型, 不使用未来数据); 涨跌停按收盘价拦截;
  固定止损为盘中止损单 (触及按止损价, 跳空低开按开盘价, 一字跌停顺延), T+1 当日买入不可卖。

用法:
  pnpm exec tsx scripts/run-backtest.ts --symbol <symbol> --strategy <strategyId> [options]

必填:
  --symbol      交易代码, 如 000001.sz / 600519.ss
  --strategy    策略 ID (需先启动后端 pnpm server, 从 /api/strategies 获取; 内建: ma-cross)

可选:
  --period      K 线周期: 1d | 1w (默认 1d)
  --count       拉取根数 (默认 500; 腾讯单次最多 800, 超出自动翻页)
  --adjust      复权: forward | backward | (默认 forward)
  --cash        初始资金 CNY (默认 100000)
  --commission  佣金费率 (‱, 万分之几, 默认 2.5 即 万分之二点五)
  --minComm     最低佣金/笔 CNY (默认 5)
  --stopLoss    固定止损百分比 (可选)
  --start       回测起始日 YYYY-MM-DD (可选)
  --end         回测结束日 YYYY-MM-DD (可选)
  --params      策略参数 JSON, 如 {"fastPeriod":10,"slowPeriod":30} (可选)
  --refresh     强制刷新腾讯缓存 (可选)
  --help, -h    显示本帮助
`);
    process.exit(0);
  }

  const symbol = options.symbol;
  const strategyId = options.strategy;
  if (!symbol || !strategyId) {
    console.error('错误: 必须提供 --symbol 和 --strategy');
    process.exit(1);
  }

  const input: ServerBacktestInput = {
    symbol,
    strategyId,
    period: (options.period as '1d' | '1w') || '1d',
    count: options.count ? parseInt(options.count, 10) : 500,
    adjust: options.adjust || 'forward',
    force: options.refresh === 'true',
    initialCash: options.cash ? parseFloat(options.cash) : 100_000,
    commissionRate: (options.commission ? parseFloat(options.commission) : 2.5) / 10_000,
    minCommission: options.minComm ? parseFloat(options.minComm) : 5,
    stopLossPercent: options.stopLoss ? parseFloat(options.stopLoss) : undefined,
    params: options.params ? JSON.parse(options.params) : {},
    rangeStart: options.start || undefined,
    rangeEnd: options.end || undefined,
  };

  const startedAt = Date.now();
  const elapsed = () => ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[run-backtest] 开始回测 ${symbol} (${strategyId}) …`);
  const output = await runServerBacktest(input, (update) => {
    console.log(`[run-backtest] +${elapsed()}s [${update.phase}] ${update.message}`);
  });
  console.log(`[run-backtest] +${elapsed()}s 回测完成`);
  const { result, diagnostics, equityCurve, klinesCount, dateRange } = output;

  console.log('\n==================================================');
  console.log(`  单股策略回测报告 (腾讯行情)`);
  console.log('==================================================');
  console.log(`  标的:            ${symbol} (${output.period}, ${output.adjust})`);
  console.log(`  策略:            ${result.symbol} → ${strategyId}`);
  console.log(`  K 线根数:        ${klinesCount}`);
  console.log(`  数据区间:        ${dateRange.start} ~ ${dateRange.end}`);
  console.log(`  初始资金:        ¥${fmt(result.initialBalance)}`);
  console.log(`  期末权益:        ¥${fmt(result.finalBalance)}`);
  console.log(`  总收益率:        ${pct(result.totalReturnPercent)}`);
  console.log(`  买入持有收益:    ${pct(result.buyHoldReturnPercent)}`);
  console.log(`  最大回撤:        ${result.maxDrawdownPercent ?? 0}%`);
  console.log(`  夏普比率:        ${fmt(result.sharpeRatio)}`);
  console.log(`  胜率:            ${fmt(result.winRate)}% (${result.winningTrades}/${result.trades.filter((t) => t.type === 'SELL').length})`);
  console.log(`  总交易次数:      ${result.totalTrades}`);
  console.log(`  总手续费:        ¥${fmt(result.totalFees)}`);
  console.log('==================================================\n');

  // 权益曲线简述
  if (equityCurve.length > 0) {
    const peak = Math.max(...equityCurve);
    const trough = Math.min(...equityCurve);
    console.log(`  权益曲线: 起点 ¥${fmt(equityCurve[0])} | 峰值 ¥${fmt(peak)} | 谷值 ¥${fmt(trough)} | 终点 ¥${fmt(equityCurve[equityCurve.length - 1])}`);
  }

  // 逐笔成交
  if (result.trades.length > 0) {
    console.log('\n逐笔成交明细:');
    console.log('日期       方向   价格     股数   金额       费用     盈亏       盈亏%    理由');
    for (const t of result.trades) {
      const pnlStr = t.pnl !== undefined ? `¥${fmt(t.pnl)}` : '-';
      const pnlPctStr = t.pnlPercent !== undefined ? `${fmt(t.pnlPercent)}%` : '-';
      console.log(
        `${t.date}  ${t.type === 'BUY' ? '买入' : '卖出'.padEnd(5)} ${fmt(t.price).padStart(8)} ` +
        `${String(t.shares).padStart(5)} ¥${fmt(t.value).padStart(10)} ¥${fmt(t.fee ?? 0).padStart(8)} ` +
        `${pnlStr.padStart(9)} ${pnlPctStr.padStart(7)} ${t.reason ?? t.signalType}`,
      );
    }
  } else {
    console.log('\n(无交易触发)');
  }

  if (diagnostics.length > 0) {
    console.log('\n诊断信息:');
    for (const d of diagnostics) {
      console.log(`  [${d.level}] ${d.date ? d.date + ' ' : ''}${d.message}`);
    }
  }

  console.log('\n回测完成。');
}

main().catch((err) => {
  console.error('回测失败:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
