import React, { useState, useEffect, useRef } from 'react';
import { User, LogOut, CheckCircle, AlertTriangle, Settings, Search, LineChart, Clock, X } from 'lucide-react';
import { getCurrentUser, signInUser, signUpUser, signOutUser, isUsingMockDb, SupabaseUser } from '../utils/supabase';

interface NavbarProps {
  onUserChanged: (user: SupabaseUser | null) => void;
  currentUser: SupabaseUser | null;
  onOpenConfig: () => void;
  onSearch?: (symbol: string) => void;
  isLoading?: boolean;
  activeSymbol?: string;
}

interface SearchHistoryItem {
  symbol: string;
  timestamp: number;
}

const PRESET_STOCKS = [
  { symbol: '600519', name: '茅台' },
  { symbol: '002594', name: '比亚迪' },
  { symbol: '000001', name: '平安银行' },
  { symbol: '600036', name: '招商银行' },
];

const MAX_HISTORY = 30;
const SEARCH_HISTORY_KEY = 'chanlun_search_history';

export default function Navbar({ onUserChanged, currentUser, onOpenConfig, onSearch, isLoading, activeSymbol }: NavbarProps) {
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [ticker, setTicker] = useState(activeSymbol || '600000');
  const [showSearch, setShowSearch] = useState(false);
  const [searchHistory, setSearchHistory] = useState<SearchHistoryItem[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const usingMock = isUsingMockDb();

  // Load search history from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(SEARCH_HISTORY_KEY);
      if (stored) {
        const history = JSON.parse(stored) as SearchHistoryItem[];
        setSearchHistory(history.slice(0, MAX_HISTORY));
      }
    } catch (err) {
      console.error('Failed to load search history:', err);
    }
  }, []);

  // Save search to history
  const saveToHistory = (symbol: string) => {
    const newItem: SearchHistoryItem = {
      symbol: symbol.toUpperCase(),
      timestamp: Date.now(),
    };

    setSearchHistory(prev => {
      // Remove duplicate if exists
      const filtered = prev.filter(item => item.symbol !== newItem.symbol);
      // Add new item at the beginning
      const updated = [newItem, ...filtered].slice(0, MAX_HISTORY);

      // Save to localStorage
      try {
        localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(updated));
      } catch (err) {
        console.error('Failed to save search history:', err);
      }

      return updated;
    });
  };

  // Clear history
  const clearHistory = () => {
    setSearchHistory([]);
    localStorage.removeItem(SEARCH_HISTORY_KEY);
  };

  // Remove single history item
  const removeHistoryItem = (symbol: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSearchHistory(prev => {
      const updated = prev.filter(item => item.symbol !== symbol);
      localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(updated));
      return updated;
    });
  };

  useEffect(() => {
    getCurrentUser().then(user => {
      if (user) onUserChanged(user);
    });
  }, []);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setErrorMsg('请输入邮箱和密码');
      return;
    }
    setLoading(true);
    setErrorMsg('');
    setSuccessMsg('');

    try {
      if (isSignUp) {
        const { user, error } = await signUpUser(email, password);
        if (error) {
          setErrorMsg(error.message);
        } else {
          setSuccessMsg('注册成功!已自动登录。');
          onUserChanged(user);
          setTimeout(() => {
            setIsLoginModalOpen(false);
            resetForm();
          }, 1500);
        }
      } else {
        const { user, error } = await signInUser(email, password);
        if (error) {
          setErrorMsg(error.message);
        } else {
          setSuccessMsg('登录成功!');
          onUserChanged(user);
          setTimeout(() => {
            setIsLoginModalOpen(false);
            resetForm();
          }, 1500);
        }
      }
    } catch (err: any) {
      setErrorMsg(err.message || '认证错误');
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setEmail('');
    setPassword('');
    setErrorMsg('');
    setSuccessMsg('');
  };

  const handleLogout = async () => {
    await signOutUser();
    onUserChanged(null);
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ticker.trim() || !onSearch) return;
    const symbol = ticker.toUpperCase().trim();
    saveToHistory(symbol);
    onSearch(symbol);
    setShowSearch(false);
    setShowHistory(false);
  };

  const handlePresetClick = (symbol: string) => {
    if (!onSearch) return;
    setTicker(symbol);
    saveToHistory(symbol);
    onSearch(symbol);
    setShowSearch(false);
    setShowHistory(false);
  };

  const handleHistoryClick = (symbol: string) => {
    if (!onSearch) return;
    setTicker(symbol);
    saveToHistory(symbol);
    onSearch(symbol);
    setShowSearch(false);
    setShowHistory(false);
  };

  // Format timestamp to relative time
  const formatTime = (timestamp: number) => {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes}分钟前`;
    if (hours < 24) return `${hours}小时前`;
    if (days < 7) return `${days}天前`;
    return new Date(timestamp).toLocaleDateString('zh-CN');
  };

  return (
    <nav className="border-b border-zinc-800 bg-zinc-900/95 backdrop-blur-xl sticky top-0 z-50 text-zinc-100">
      <div className="max-w-7xl mx-auto px-4 md:px-6 py-3">

        {/* Main Row */}
        <div className="flex items-center justify-between gap-4">

          {/* Left: Brand + Title */}
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-600 flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <span className="text-zinc-950 font-mono font-black text-lg">缠</span>
            </div>
            <div className="hidden sm:block">
              <h1 className="text-base font-bold font-sans tracking-tight text-zinc-100 leading-tight">
                缠论量化交易工作台
              </h1>
              <p className="text-[10px] font-mono text-zinc-500 mt-0.5">高级技术分析系统</p>
            </div>
          </div>

          {/* Center: Search (Desktop) */}
          {onSearch && (
            <div className="hidden md:flex items-center gap-2 flex-1 max-w-md mx-4 relative">
              <form onSubmit={handleSearchSubmit} className="relative flex-1">
                <input
                  ref={searchInputRef}
                  type="text"
                  value={ticker}
                  onChange={(e) => setTicker(e.target.value)}
                  onFocus={() => setShowHistory(true)}
                  onBlur={() => setTimeout(() => setShowHistory(false), 200)}
                  placeholder="股票代码: 600519, 000001..."
                  disabled={isLoading}
                  className="w-full pl-3 pr-10 py-1.5 text-xs bg-zinc-950/80 text-zinc-100 border border-zinc-800 rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 font-mono transition-all"
                />
                <button
                  type="submit"
                  disabled={isLoading}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded bg-emerald-500 hover:bg-emerald-400 text-zinc-950 transition-all disabled:opacity-50 cursor-pointer"
                >
                  <Search className="h-3.5 w-3.5" />
                </button>
              </form>

              {/* History Dropdown */}
              {showHistory && searchHistory.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl overflow-hidden z-50">
                  <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 bg-zinc-950/50">
                    <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 font-semibold uppercase tracking-wider">
                      <Clock className="h-3 w-3" />
                      <span>搜索历史</span>
                    </div>
                    <button
                      onClick={clearHistory}
                      className="text-[10px] text-zinc-500 hover:text-red-400 transition-colors cursor-pointer"
                    >
                      清空
                    </button>
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    {searchHistory.map((item) => (
                      <div
                        key={item.symbol}
                        onClick={() => handleHistoryClick(item.symbol)}
                        className="flex items-center justify-between px-3 py-2 hover:bg-zinc-800/50 cursor-pointer transition-colors group"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono font-semibold text-emerald-400">{item.symbol}</span>
                          <span className="text-[10px] text-zinc-500">{formatTime(item.timestamp)}</span>
                        </div>
                        <button
                          onClick={(e) => removeHistoryItem(item.symbol, e)}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-zinc-700 transition-all cursor-pointer"
                        >
                          <X className="h-3 w-3 text-zinc-500 hover:text-red-400" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Right: Actions */}
          <div className="flex items-center gap-2">
            {/* Mobile Search Toggle */}
            {onSearch && (
              <button
                onClick={() => setShowSearch(!showSearch)}
                className="md:hidden flex items-center justify-center p-2 rounded-lg text-zinc-500 hover:text-emerald-400 hover:bg-emerald-950/20 transition-colors cursor-pointer"
              >
                <Search className="h-4 w-4" />
              </button>
            )}

            {/* Active Symbol Badge */}
            {activeSymbol && (
              <div className="hidden lg:flex items-center gap-2 px-3 py-1.5 bg-zinc-950/50 rounded-lg border border-zinc-800">
                <LineChart className="h-3.5 w-3.5 text-emerald-400" />
                <span className="text-[10px] text-zinc-500 font-mono">当前:</span>
                <span className="text-xs font-bold font-mono text-emerald-400">{activeSymbol}</span>
              </div>
            )}

            {/* Settings */}
            <button
              onClick={onOpenConfig}
              className="flex items-center justify-center p-2 rounded-lg text-zinc-500 hover:text-emerald-400 hover:bg-emerald-950/20 transition-colors cursor-pointer"
              title="API 配置"
            >
              <Settings className="h-4 w-4" />
            </button>

            {/* User */}
            {currentUser && (
              <>
                <div className="hidden md:flex flex-col items-end">
                  <span className="text-[10px] font-semibold text-zinc-300">{currentUser.email}</span>
                  <span className="text-[9px] font-mono text-emerald-400">高级账户</span>
                </div>
                <div className="h-8 w-8 rounded-full bg-zinc-850 flex items-center justify-center border border-zinc-750">
                  <User className="h-3.5 w-3.5 text-zinc-400" />
                </div>
                <button
                  onClick={handleLogout}
                  className="flex items-center justify-center p-2 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-950/20 transition-colors cursor-pointer"
                  title="登出"
                >
                  <LogOut className="h-4 w-4" />
                </button>
              </>
            )}
          </div>
        </div>

        {/* Mobile Search Panel */}
        {showSearch && onSearch && (
          <div className="md:hidden mt-3 pt-3 border-t border-zinc-800 space-y-3">
            <form onSubmit={handleSearchSubmit}>
              <input
                type="text"
                value={ticker}
                onChange={(e) => setTicker(e.target.value)}
                placeholder="股票代码: 600519, 000001..."
                disabled={isLoading}
                className="w-full pl-3 pr-10 py-2 text-xs bg-zinc-950 text-zinc-100 border border-zinc-800 rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-500 font-mono"
              />
            </form>

            {/* Search History */}
            {searchHistory.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between px-1">
                  <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 font-semibold uppercase tracking-wider">
                    <Clock className="h-3 w-3" />
                    <span>搜索历史</span>
                  </div>
                  <button
                    onClick={clearHistory}
                    className="text-[10px] text-zinc-500 hover:text-red-400 transition-colors cursor-pointer"
                  >
                    清空
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {searchHistory.slice(0, 10).map((item) => (
                    <button
                      key={item.symbol}
                      type="button"
                      onClick={() => handleHistoryClick(item.symbol)}
                      className="px-2.5 py-1 rounded-lg border border-zinc-800 bg-zinc-950 text-[10px] font-mono font-semibold text-emerald-400 hover:border-emerald-500 transition-all cursor-pointer"
                    >
                      {item.symbol}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Preset Stocks */}
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 px-1 text-[10px] text-zinc-500 font-semibold uppercase tracking-wider">
                <span>热门股票</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {PRESET_STOCKS.map(item => (
                  <button
                    key={item.symbol}
                    type="button"
                    onClick={() => handlePresetClick(item.symbol)}
                    className={`px-2.5 py-1 rounded-lg border text-[10px] font-medium transition-all cursor-pointer ${
                      activeSymbol === item.symbol
                        ? 'border-emerald-500 bg-emerald-500/10 text-emerald-400'
                        : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-emerald-500 hover:text-emerald-400'
                    }`}
                  >
                    {item.symbol}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

      </div>

      {/* Auth Modular Dialog */}
      {isLoginModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4">
          <div className="w-full max-w-md bg-zinc-900 text-zinc-100 rounded-2xl shadow-2xl border border-zinc-800 p-6 relative overflow-hidden animate-fade-in" id="login-modal-box">
            
            <div className="absolute top-0 left-0 w-full h-1.5 bg-emerald-500" />

            <div className="flex justify-between items-center mb-6">
              <h3 className="text-lg font-bold text-zinc-100">
                {isSignUp ? '创建量化账户' : '访问缠论引擎'}
              </h3>
              <button 
                onClick={() => {
                  setIsLoginModalOpen(false);
                  resetForm();
                }}
                className="text-zinc-500 hover:text-zinc-300 font-bold text-sm px-2 py-1 rounded cursor-pointer"
              >
                ✕
              </button>
            </div>

            {usingMock && (
              <div className="p-3 bg-amber-950/20 rounded-xl mb-4 border border-amber-900/30 flex gap-2.5">
                <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                <p className="text-[11px] text-amber-400 leading-normal font-sans">
                  门户当前处于<strong>本地存储模式</strong>。可以安全输入凭据以测试安全账户布局。
                </p>
              </div>
            )}

            <form onSubmit={handleAuthSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-400 mb-1.5 font-sans">邮箱地址</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm bg-zinc-950 text-zinc-100 border border-zinc-800 rounded-xl focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500"
                  placeholder="name@company.com"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-400 mb-1.5 font-sans">安全密钥/密码</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm bg-zinc-950 text-zinc-100 border border-zinc-800 rounded-xl focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500"
                  placeholder="最少6个字符"
                  required
                />
              </div>

              {errorMsg && (
                <div className="p-3 bg-red-950/20 text-red-400 text-xs rounded-xl border border-red-900/30 flex items-center gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  <span>{errorMsg}</span>
                </div>
              )}

              {successMsg && (
                <div className="p-3 bg-emerald-950/20 text-emerald-400 text-xs rounded-xl border border-emerald-900/30 flex items-center gap-2">
                  <CheckCircle className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                  <span>{successMsg}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 mt-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-zinc-950 font-bold text-sm transition-all cursor-pointer flex items-center justify-center shadow-lg shadow-emerald-500/10"
              >
                {loading ? '处理工作空间...' : isSignUp ? '注册新账户' : '验证身份'}
              </button>
            </form>

            <div className="mt-4 pt-4 border-t border-zinc-850 text-center">
              <button
                onClick={() => {
                  setIsSignUp(!isSignUp);
                  setErrorMsg('');
                }}
                className="text-xs text-zinc-500 hover:text-emerald-400 transition-colors font-medium cursor-pointer"
              >
                {isSignUp ? '已注册?在此登录' : '新量化交易者?立即创建账户'}
              </button>
            </div>
            
          </div>
        </div>
      )}
    </nav>
  );
}
