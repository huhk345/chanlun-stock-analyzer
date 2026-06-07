import React, { useState, useEffect } from 'react';
import {
  User,
  TrendingDown,
  ExternalLink,
  Calendar,
  FileText,
  ChevronRight,
  AlertCircle,
  Briefcase,
  Users
} from 'lucide-react';

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
  stockCode: string;
}

// Cache for stock data to prevent redundant fetches
let stockDataCache: Record<string, any> | null = null;

export default function StockInfoPanel({ stockCode }: StockInfoPanelProps) {
  const [stockData, setStockData] = useState<StockData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStockData = async () => {
      setLoading(true);
      setError(null);

      try {
        // Use cached data if available
        if (!stockDataCache) {
          const response = await fetch('/merged_stock_data.json');
          if (!response.ok) {
            throw new Error('Failed to load stock data');
          }
          stockDataCache = await response.json();
        }

        // Extract pure stock code (remove exchange suffix like .SH, .SZ)
        const pureCode = stockCode.split('.')[0];
        const stock = stockDataCache[pureCode];

        if (stock) {
          setStockData(stock);
        } else {
          setError(`未找到股票 ${pureCode} 的信息`);
        }
      } catch (err) {
        setError('加载股票数据失败');
        console.error('Error loading stock data:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchStockData();
  }, [stockCode]);

  if (loading) {
    return (
      <div className="bg-zinc-900/50 border border-zinc-800/60 rounded-xl p-6 animate-pulse">
        <div className="h-4 bg-zinc-800 rounded w-1/3 mb-4"></div>
        <div className="h-3 bg-zinc-800 rounded w-2/3 mb-3"></div>
        <div className="h-3 bg-zinc-800 rounded w-1/2"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-950/20 border border-red-900/30 rounded-xl p-4 flex items-start gap-3">
        <AlertCircle className="h-4 w-4 text-red-400 mt-0.5 shrink-0" />
        <div>
          <p className="text-xs font-semibold text-red-400">数据加载错误</p>
          <p className="text-[11px] text-red-400/70 mt-1">{error}</p>
        </div>
      </div>
    );
  }

  if (!stockData) {
    return null;
  }

  const hasReductionPlans = stockData.reduction_plans && stockData.reduction_plans.length > 0;

  // Parse industry hierarchy
  const industryParts = stockData.industry.split(' > ');

  return (
    <div className="space-y-4">
      {/* Stock Basic Info Card */}
      <div className="bg-zinc-900/50 border border-zinc-800/60 rounded-xl overflow-hidden backdrop-blur-sm">
        {/* Content */}
        <div className="p-5 space-y-4">
          {/* Industry */}
          <div className="group">
            <div className="flex items-start gap-3">
              <div className="h-8 w-8 rounded-md bg-zinc-800/80 border border-zinc-700/50 flex items-center justify-center shrink-0 mt-0.5">
                <Briefcase className="h-4 w-4 text-zinc-400" />
              </div>
              <div className="flex-1 min-w-0">
                <label className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider block mb-1.5">
                  行业分类
                </label>
                <div className="flex flex-wrap items-center gap-1.5">
                  {industryParts.map((part, index) => (
                    <React.Fragment key={index}>
                      <span className={`text-xs font-medium ${
                        index === industryParts.length - 1
                          ? 'text-blue-400 font-semibold'
                          : 'text-zinc-400'
                      }`}>
                        {part}
                      </span>
                      {index < industryParts.length - 1 && (
                        <ChevronRight className="h-3 w-3 text-zinc-600" />
                      )}
                    </React.Fragment>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Actual Controller */}
          <div className="group">
            <div className="flex items-start gap-3">
              <div className="h-8 w-8 rounded-md bg-zinc-800/80 border border-zinc-700/50 flex items-center justify-center shrink-0 mt-0.5">
                <Users className="h-4 w-4 text-zinc-400" />
              </div>
              <div className="flex-1 min-w-0">
                <label className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider block mb-1.5">
                  实际控制人
                </label>
                <div className="flex items-center gap-2">
                  <User className="h-3.5 w-3.5 text-zinc-500 shrink-0" />
                  <span className={`text-xs font-medium ${
                    stockData.actual_controller === '无'
                      ? 'text-zinc-500 italic'
                      : 'text-zinc-200'
                  }`}>
                    {stockData.actual_controller}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Reduction Plans Card */}
      {hasReductionPlans && (
        <div className="bg-orange-950/10 border border-orange-900/30 rounded-xl overflow-hidden backdrop-blur-sm">
          {/* Header */}
          <div className="px-5 py-3 border-b border-orange-900/20 bg-gradient-to-r from-orange-950/20 to-orange-950/10">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <TrendingDown className="h-4 w-4 text-orange-400" />
                <h4 className="text-xs font-bold text-orange-300">减持计划</h4>
              </div>
              <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-orange-500/10 border border-orange-500/20">
                <span className="text-[10px] font-semibold text-orange-400">
                  {stockData.reduction_plans.length} 条公告
                </span>
              </div>
            </div>
          </div>

          {/* Plans List */}
          <div className="divide-y divide-orange-900/20">
            {stockData.reduction_plans.map((plan, index) => (
              <div
                key={index}
                className="px-5 py-3 hover:bg-orange-950/20 transition-colors group"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    {/* Title */}
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

                    {/* Meta Info */}
                    <div className="flex items-center gap-3 mt-2 ml-5">
                      {/* Reduction Date */}
                      <div className="flex items-center gap-1.5">
                        <Calendar className="h-3 w-3 text-orange-400/60" />
                        <span className="text-[10px] text-zinc-500">减持日期</span>
                        <span className="text-[10px] font-mono font-semibold text-orange-400">
                          {plan.reduction_date}
                        </span>
                      </div>

                      {/* Divider */}
                      <div className="h-3 w-px bg-orange-900/30"></div>

                      {/* Announcement Type */}
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
      )}

      {/* No Reduction Plans Notice */}
      {!hasReductionPlans && (
        <div className="bg-zinc-900/30 border border-zinc-800/40 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-md bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
              <TrendingDown className="h-4 w-4 text-emerald-400" />
            </div>
            <div>
              <p className="text-xs font-semibold text-zinc-300">暂无减持计划</p>
              <p className="text-[10px] text-zinc-500 mt-0.5">该股票目前没有披露减持计划公告</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
