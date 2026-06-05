import React, { useState, useEffect } from 'react';
import { Database, User, LogOut, Key, CheckCircle, AlertTriangle, ShieldCheck } from 'lucide-react';
import { getCurrentUser, signInUser, signUpUser, signOutUser, isUsingMockDb, SupabaseUser } from '../utils/supabase';

interface NavbarProps {
  onUserChanged: (user: SupabaseUser | null) => void;
  currentUser: SupabaseUser | null;
}

export default function Navbar({ onUserChanged, currentUser }: NavbarProps) {
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [loading, setLoading] = useState(false);

  const usingMock = isUsingMockDb();

  useEffect(() => {
    getCurrentUser().then(user => {
      if (user) onUserChanged(user);
    });
  }, []);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setErrorMsg('Please input email and password');
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
          setSuccessMsg('Registration successful! Auto logged in.');
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
          setSuccessMsg('Logged in successfully!');
          onUserChanged(user);
          setTimeout(() => {
            setIsLoginModalOpen(false);
            resetForm();
          }, 1500);
        }
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Authentication error');
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

  return (
    <nav className="border-b border-zinc-800 bg-zinc-900/80 backdrop-blur-md sticky top-0 z-50 px-6 py-4 text-zinc-100">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        
        {/* Brand */}
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-emerald-500 flex items-center justify-center shadow-lg shadow-emerald-500/10">
            <span className="text-zinc-950 font-mono font-black text-xl tracking-wider">缠</span>
          </div>
          <div>
            <h1 className="text-lg font-bold font-sans tracking-tight text-zinc-100 leading-none">
              ZenTheory <span className="text-xs text-zinc-500 font-normal">缠论分析系统</span>
            </h1>
            <p className="text-[10px] font-mono text-zinc-500 mt-1 uppercase">Advanced Technical Bento Canvas</p>
          </div>
        </div>

        {/* Database & Identity Statuses */}
        <div className="flex items-center gap-4">
          
          {/* DB Indicator */}
          <div className={`hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-mono font-medium border ${
            usingMock 
              ? 'bg-amber-950/20 text-amber-400 border-amber-900/40' 
              : 'bg-emerald-950/20 text-emerald-400 border-emerald-900/30'
          }`}>
            {usingMock ? (
              <>
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500 animate-pulse" />
                <span>Simulation Store</span>
              </>
            ) : (
              <>
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                <span>Supabase Active</span>
              </>
            )}
          </div>

          {/* Account Portal */}
          {currentUser ? (
            <div className="flex items-center gap-3">
              <div className="hidden md:flex flex-col items-end">
                <span className="text-xs font-semibold text-zinc-200">{currentUser.email}</span>
                <span className="text-[10px] font-mono text-emerald-400">Premium Account</span>
              </div>
              <div className="h-9 w-9 rounded-full bg-zinc-850 flex items-center justify-center border border-zinc-750">
                <User className="h-4 w-4 text-zinc-400" />
              </div>
              <button
                onClick={handleLogout}
                className="flex items-center justify-center p-2 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-950/20 transition-colors cursor-pointer"
                title="Log Out"
                id="btn-logout"
              >
                <LogOut className="h-5 w-5" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => {
                setIsLoginModalOpen(true);
                setIsSignUp(false);
              }}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-900 text-zinc-100 text-xs font-medium font-sans tracking-wide border border-zinc-700 cursor-pointer transition-all"
              id="btn-login-trigger"
            >
              <User className="h-3.5 w-3.5 text-emerald-400" />
              <span>Login Portal</span>
            </button>
          )}
        </div>
      </div>

      {/* Auth Modular Dialog */}
      {isLoginModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4">
          <div className="w-full max-w-md bg-zinc-900 text-zinc-100 rounded-2xl shadow-2xl border border-zinc-800 p-6 relative overflow-hidden animate-fade-in" id="login-modal-box">
            
            <div className="absolute top-0 left-0 w-full h-1.5 bg-emerald-500" />

            <div className="flex justify-between items-center mb-6">
              <h3 className="text-lg font-bold text-zinc-100">
                {isSignUp ? 'Create Quant Account' : 'Access ZenTheory Engine'}
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
                  The portal is currently in <strong>Local Storage mode</strong>. Credentials can be entered safely to test the secure account layouts.
                </p>
              </div>
            )}

            <form onSubmit={handleAuthSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-400 mb-1.5 font-sans">Email Address</label>
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
                <label className="block text-xs font-semibold text-zinc-400 mb-1.5 font-sans">Security Key / Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm bg-zinc-950 text-zinc-100 border border-zinc-800 rounded-xl focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500"
                  placeholder="Min 6 characters"
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
                {loading ? 'Processing Workspace...' : isSignUp ? 'Sign Up New Account' : 'Authenticate Identity'}
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
                {isSignUp ? 'Already registered? Authenticate here' : 'Fresh quant trader? Create account now'}
              </button>
            </div>
            
          </div>
        </div>
      )}
    </nav>
  );
}
