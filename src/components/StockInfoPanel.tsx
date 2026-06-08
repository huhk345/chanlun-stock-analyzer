import { TrendingDown, ExternalLink, Calendar, FileText } from 'lucide-react';

interface ReductionPlan {
  title: string;
  url: string;
  reduction_date: string;
  announcement_type: string;
  announcement_date: string;
}

interface StockData {
  stock_code: string;
  stock_name: string;
  industry: string;
  actual_controller: string;
  reduction_plans: ReductionPlan[];
}

interface StockInfoPanelProps {
  stockData: StockData | null;
}

export default function StockInfoPanel({ stockData }: StockInfoPanelProps) {
  if (!stockData || !stockData.reduction_plans || stockData.reduction_plans.length === 0) {
    return null;
  }

  return (
    <div className="space-y-0 md:space-y-4">
      <div className="mobile-flat bg-orange-950/10 md:border md:border-orange-900/30 md:rounded-xl overflow-hidden md:backdrop-blur-sm">
        <div className="px-3 py-2 md:px-5 md:py-3 border-b border-orange-900/20 bg-gradient-to-r from-orange-950/20 to-orange-950/10">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <TrendingDown className="h-3.5 w-3.5 md:h-4 md:w-4 text-orange-400" />
              <h4 className="text-[11px] md:text-xs font-bold text-orange-300">减持计划</h4>
            </div>
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-orange-500/10 border border-orange-500/20">
              <span className="text-[9px] md:text-[10px] font-semibold text-orange-400">
                {stockData.reduction_plans.length} 条公告
              </span>
            </div>
          </div>
        </div>

        <div className="divide-y divide-orange-900/20">
          {stockData.reduction_plans.map((plan, index) => (
            <div
              key={index}
              className="px-3 py-2 md:px-5 md:py-3 hover:bg-orange-950/20 transition-colors group"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <a
                    href={plan.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-medium text-zinc-200 hover:text-orange-400 transition-colors line-clamp-2 flex items-start gap-1.5 group/link"
                  >
                    <FileText className="h-3.5 w-3.5 text-zinc-500 shrink-0 mt-0.5 group-hover/link:text-orange-400 transition-colors" />
                    <span className="flex-1">{plan.title}</span>
                    <ExternalLink className="h-3 w-3 text-zinc-600 shrink-0 mt-0.5 opacity-0 group-hover/link:opacity-100 transition-opacity" />
                  </a>

                  <div className="flex items-center gap-3 mt-2 ml-5">
                    <div className="flex items-center gap-1.5">
                      <Calendar className="h-3 w-3 text-orange-400/60" />
                      <span className="text-[10px] text-zinc-500">减持日期</span>
                      <span className="text-[10px] font-mono font-semibold text-orange-400">
                        {plan.reduction_date}
                      </span>
                    </div>

                    <div className="h-3 w-px bg-orange-900/30"></div>

                    <span className="text-[10px] text-zinc-500 bg-zinc-800/50 px-2 py-0.5 rounded">
                      {plan.announcement_type}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
