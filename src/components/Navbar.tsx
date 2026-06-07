import React, { useState, useEffect, useRef } from 'react';
import { User, LogOut, CheckCircle, AlertTriangle, Settings, Search, LineChart, Clock, X, Bell, ChevronDown } from 'lucide-react';
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
  const [marketTime, setMarketTime] = useState(new Date());
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  const usingMock = isUsingMockDb();

  useEffect(() => {
    const timer = setInterval(() => setMarketTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

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

  const saveToHistory = (symbol: string) => {
    const newItem: SearchHistoryItem = {
      symbol: symbol.toUpperCase(),
      timestamp: Date.now(),
    };

    setSearchHistory(prev => {
      const filtered = prev.filter(item => item.symbol !== newItem.symbol);
      const updated = [newItem, ...filtered].slice(0, MAX_HISTORY);

      try {
        localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(updated));
      } catch (err) {
        console.error('Failed to save search history:', err);
      }

      return updated;
    });
  };

  const clearHistory = () => {
    setSearchHistory([]);
    localStorage.removeItem(SEARCH_HISTORY_KEY);
  };

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
    setUserMenuOpen(false);
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

  const formatMarketTime = (date: Date) => {
    return date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const formatMarketDate = (date: Date) => {
    return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
  };

  const isMarketOpen = () => {
    const day = marketTime.getDay();
    if (day === 0 || day === 6) return false;
    const minutes = marketTime.getHours() * 60 + marketTime.getMinutes();
    return (minutes >= 570 && minutes <= 690) || (minutes >= 780 && minutes <= 900);
  };

  return (
    <nav className="sticky top-0 z-50 text-zinc-100 bg-gradient-to-b from-zinc-950 via-zinc-950 to-zinc-900 border-b border-zinc-800/80 shadow-[0_1px_0_0_rgba(16,185,129,0.08),0_4px_24px_-8px_rgba(0,0,0,0.6)] backdrop-blur-xl">
      <div className="w-full h-14 flex items-center">

        {/* Left: Brand */}
        <div className="flex items-center gap-3 shrink-0 pl-4 md:pl-5 pr-3 h-full border-r border-zinc-800/60">
          <div className="relative h-9 w-9 rounded-lg bg-gradient-to-br from-emerald-400 via-emerald-500 to-emerald-600 flex items-center justify-center shadow-[0_0_0_1px_rgba(16,185,129,0.3),0_4px_12px_-2px_rgba(16,185,129,0.4)]">
            <span className="text-zinc-950 font-mono font-black text-lg leading-none">缠</span>
            <div className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-300 ring-2 ring-zinc-950 animate-pulse" />
          </div>
          <div className="hidden sm:flex flex-col leading-none">
            <h1 className="text-[15px] font-bold tracking-tight text-zinc-50 font-sans">
              缠论量化工作台
            </h1>
            <div className="flex items-center gap-1.5 mt-1">
              <span className="text-[9px] font-mono text-zinc-500 tracking-wider uppercase">ChanLun Pro</span>
              <span className="h-0.5 w-0.5 rounded-full bg-zinc-700" />
              <span className="text-[9px] font-mono text-emerald-500/80 tracking-wider">v2.6.0</span>
            </div>
          </div>
        </div>

        {/* Vertical Divider */}
        <div className="hidden md:block h-7 w-px bg-gradient-to-b from-transparent via-zinc-800 to-transparent" />

        {/* Center: Search */}
        {onSearch && (
          <div className="hidden md:flex items-center flex-1 max-w-2xl relative px-4">
            <form onSubmit={handleSearchSubmit} className="relative w-full group">
              <div className="absolute left-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5 pointer-events-none">
                <Search className="h-3.5 w-3.5 text-zinc-500 group-focus-within:text-emerald-400 transition-colors" />
              </div>
              <input
                ref={searchInputRef}
                type="text"
                value={ticker}
                onChange={(e) => setTicker(e.target.value)}
                onFocus={() => setShowHistory(true)}
                onBlur={() => setTimeout(() => setShowHistory(false), 200)}
                placeholder="搜索股票代码 — 例如 600519, 000001, AAPL..."
                disabled={isLoading}
                className="w-full h-9 pl-9 pr-24 text-[13px] bg-zinc-900/70 text-zinc-100 border border-zinc-800 rounded-md focus:outline-none focus:bg-zinc-900 focus:border-emerald-500/60 focus:shadow-[0_0_0_3px_rgba(16,185,129,0.08)] font-mono transition-all placeholder:text-zinc-600"
              />
              <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-1">
                <kbd className="hidden lg:inline-block px-1.5 py-0.5 text-[9px] font-mono text-zinc-500 bg-zinc-800/80 border border-zinc-700/50 rounded">
                  ⌘K
                </kbd>
                <button
                  type="submit"
                  disabled={isLoading}
                  className="p-1.5 rounded bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-zinc-950 transition-all disabled:opacity-50 cursor-pointer shadow-sm shadow-emerald-500/20"
                >
                  <Search className="h-3 w-3" strokeWidth={2.5} />
                </button>
              </div>
            </form>

            {/* History Dropdown */}
            {showHistory && searchHistory.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-2 bg-zinc-900/95 border border-zinc-800 rounded-lg shadow-2xl shadow-black/60 overflow-hidden z-50 backdrop-blur-xl">
                <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800 bg-zinc-950/50">
                  <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 font-semibold uppercase tracking-wider">
                    <Clock className="h-3 w-3" />
                    <span>搜索历史</span>
                  </div>
                  <button
                    onClick={clearHistory}
                    className="text-[10px] text-zinc-500 hover:text-red-400 transition-colors cursor-pointer font-medium"
                  >
                    清空
                  </button>
                </div>
                <div className="max-h-72 overflow-y-auto py-1">
                  {searchHistory.map((item) => (
                    <div
                      key={item.symbol}
                      onClick={() => handleHistoryClick(item.symbol)}
                      className="flex items-center justify-between px-3 py-2 hover:bg-zinc-800/60 cursor-pointer transition-colors group"
                    >
                      <div className="flex items-center gap-3">
                        <div className="h-6 w-6 rounded bg-zinc-800 group-hover:bg-emerald-500/10 flex items-center justify-center transition-colors">
                          <LineChart className="h-3 w-3 text-zinc-500 group-hover:text-emerald-400" />
                        </div>
                        <span className="text-xs font-mono font-semibold text-zinc-200 group-hover:text-emerald-400 transition-colors">{item.symbol}</span>
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

        {/* Right: Status + Actions */}
        <div className="flex items-center gap-1 shrink-0 h-full ml-auto pr-2 md:pr-3">

          {/* Market Status */}
          <div className="hidden xl:flex items-center gap-2 h-9 px-3 rounded-md bg-zinc-900/50 border border-zinc-800/60">
            <div className="flex items-center gap-1.5">
              <div className={`h-1.5 w-1.5 rounded-full ${isMarketOpen() ? 'bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.6)]' : 'bg-zinc-600'} ${isMarketOpen() ? 'animate-pulse' : ''}`} />
              <span className="text-[10px] font-mono font-semibold tracking-wider uppercase text-zinc-400">
                {isMarketOpen() ? 'Live' : 'Closed'}
              </span>
            </div>
            <div className="h-3 w-px bg-zinc-800" />
            <div className="flex flex-col leading-none">
              <span className="text-[10px] font-mono font-semibold text-zinc-300">{formatMarketTime(marketTime)}</span>
              <span className="text-[8px] font-mono text-zinc-600 mt-0.5">{formatMarketDate(marketTime)}</span>
            </div>
          </div>

          {/* Active Symbol Badge */}
          {activeSymbol && (
            <div className="hidden lg:flex items-center gap-2 h-9 px-3 rounded-md bg-gradient-to-r from-emerald-500/10 to-emerald-500/5 border border-emerald-500/30">
              <LineChart className="h-3.5 w-3.5 text-emerald-400" strokeWidth={2.5} />
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-zinc-500 font-mono uppercase tracking-wider">Symbol</span>
                <span className="text-xs font-bold font-mono text-emerald-300 tracking-tight">{activeSymbol}</span>
              </div>
              <div className="flex items-center gap-0.5 ml-1">
                <span className="h-1 w-1 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-[9px] font-mono text-emerald-400/80">+2.4%</span>
              </div>
            </div>
          )}

          {/* Mobile Search Toggle */}
          {onSearch && (
            <button
              onClick={() => setShowSearch(!showSearch)}
              className="md:hidden flex items-center justify-center h-9 w-9 rounded-md text-zinc-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors cursor-pointer"
            >
              <Search className="h-4 w-4" />
            </button>
          )}

          {/* Notification */}
          <button
            className="hidden sm:flex items-center justify-center h-9 w-9 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 transition-colors cursor-pointer relative"
            title="通知"
          >
            <Bell className="h-4 w-4" />
            <span className="absolute top-2 right-2 h-1.5 w-1.5 rounded-full bg-emerald-400" />
          </button>

          {/* Settings */}
          <button
            onClick={onOpenConfig}
            className="flex items-center justify-center h-9 w-9 rounded-md text-zinc-400 hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors cursor-pointer"
            title="API 配置"
          >
            <Settings className="h-4 w-4" />
          </button>

          {/* User / Auth */}
          {currentUser ? (
            <div className="relative" ref={userMenuRef}>
              <button
                onClick={() => setUserMenuOpen(!userMenuOpen)}
                className="flex items-center gap-2 h-9 pl-1.5 pr-2.5 rounded-md hover:bg-zinc-800/60 transition-colors cursor-pointer border border-transparent hover:border-zinc-800"
              >
                <div className="h-7 w-7 rounded-md bg-gradient-to-br from-emerald-500/20 to-emerald-600/10 border border-emerald-500/30 flex items-center justify-center">
                  <User className="h-3.5 w-3.5 text-emerald-400" />
                </div>
                <div className="hidden md:flex flex-col items-start leading-none">
                  <span className="text-[11px] font-semibold text-zinc-200 max-w-[120px] truncate">
                    {currentUser.email?.split('@')[0] || 'Quant'}
                  </span>
                  <span className="text-[9px] font-mono text-emerald-400/80 mt-0.5">PRO</span>
                </div>
                <ChevronDown className={`h-3 w-3 text-zinc-500 transition-transform ${userMenuOpen ? 'rotate-180' : ''}`} />
              </button>

              {userMenuOpen && (
                <div className="absolute right-0 top-full mt-2 w-56 bg-zinc-900/95 border border-zinc-800 rounded-lg shadow-2xl shadow-black/60 overflow-hidden z-50 backdrop-blur-xl">
                  <div className="p-3 border-b border-zinc-800">
                    <p className="text-xs font-semibold text-zinc-200 truncate">{currentUser.email}</p>
                    <p className="text-[10px] font-mono text-emerald-400 mt-0.5">高级量化账户</p>
                  </div>
                  <div className="p-1">
                    <button
                      onClick={handleLogout}
                      className="w-full flex items-center gap-2 px-2.5 py-2 rounded text-xs text-zinc-300 hover:bg-red-500/10 hover:text-red-400 transition-colors cursor-pointer"
                    >
                      <LogOut className="h-3.5 w-3.5" />
                      <span>登出账户</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>

      {/* Mobile Search Panel */}
      {showSearch && onSearch && (
        <div className="md:hidden w-full border-t border-zinc-800/80 bg-zinc-950/95 px-4 py-3 space-y-3">
          <form onSubmit={handleSearchSubmit}>
            <input
              type="text"
              value={ticker}
              onChange={(e) => setTicker(e.target.value)}
              placeholder="股票代码: 600519, 000001..."
              disabled={isLoading}
              className="w-full h-9 pl-3 pr-10 text-[13px] bg-zinc-900 text-zinc-100 border border-zinc-800 rounded-md focus:outline-none focus:border-emerald-500/60 focus:shadow-[0_0_0_3px_rgba(16,185,129,0.08)] font-mono"
            />
          </form>

          {searchHistory.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 font-semibold uppercase tracking-wider">
                  <Clock className="h-3 w-3" />
                  <span>搜索历史</span>
                </div>
                <button
                  onClick={clearHistory}
                  className="text-[10px] text-zinc-500 hover:text-red-400 transition-colors cursor-pointer font-medium"
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
                    className="px-2.5 py-1 rounded-md border border-zinc-800 bg-zinc-900 text-[11px] font-mono font-semibold text-emerald-400 hover:border-emerald-500/60 transition-all cursor-pointer"
                  >
                    {item.symbol}
                  </button>
                ))}
              </div>
            </div>
          )}

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
                  className={`px-2.5 py-1 rounded-md border text-[11px] font-medium transition-all cursor-pointer ${
                    activeSymbol === item.symbol
                      ? 'border-emerald-500 bg-emerald-500/10 text-emerald-400'
                      : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-emerald-500/60 hover:text-emerald-400'
                  }`}
                >
                  {item.symbol}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Auth Modal Dialog */}
      {isLoginModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4">
          <div className="w-full max-w-md bg-zinc-900 text-zinc-100 rounded-2xl shadow-2xl border border-zinc-800 p-6 relative overflow-hidden animate-fade-in" id="login-modal-box">
            
            <div className="absolute top-0 left-0 w-full h-1.5 bg-gradient-to-r from-emerald-400 via-emerald-500 to-emerald-600" />

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
