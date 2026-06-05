import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { BacktestResult, BacktestTrade } from '../types/stock';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

let supabase: SupabaseClient | null = null;
let isMockDb = true;

// Check if valid keys exist
if (supabaseUrl && supabaseAnonKey && supabaseUrl !== 'undefined' && supabaseAnonKey !== 'undefined') {
  try {
    supabase = createClient(supabaseUrl, supabaseAnonKey);
    isMockDb = false;
  } catch (error) {
    console.warn('Failed to initialize Supabase. Falling back to local storage:', error);
    isMockDb = true;
  }
} else {
  isMockDb = true;
}

export function isUsingMockDb(): boolean {
  return isMockDb;
}

// User structures
export interface SupabaseUser {
  id: string;
  email: string;
  created_at: string;
}

/**
 * --- AUTHENTICATION INTERFACE ---
 */

export async function signUpUser(email: string, password: string): Promise<{ user: SupabaseUser | null; error: Error | null }> {
  if (isMockDb || !supabase) {
    // Simulated Signup
    const users = JSON.parse(localStorage.getItem('chanlun_users') || '[]');
    if (users.find((u: any) => u.email === email)) {
      return { user: null, error: new Error('User already exists') };
    }
    const newUser = {
      id: `usr-${Math.random().toString(36).substr(2, 9)}`,
      email,
      created_at: new Date().toISOString()
    };
    users.push({ ...newUser, password });
    localStorage.setItem('chanlun_users', JSON.stringify(users));
    localStorage.setItem('chanlun_current_user', JSON.stringify(newUser));
    return { user: newUser, error: null };
  }

  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return { user: null, error };
  return {
    user: data.user ? { id: data.user.id, email: data.user.email || '', created_at: data.user.created_at } : null,
    error: null
  };
}

export async function signInUser(email: string, password: string): Promise<{ user: SupabaseUser | null; error: Error | null }> {
  if (isMockDb || !supabase) {
    // Simulated SignIn
    const users = JSON.parse(localStorage.getItem('chanlun_users') || '[]');
    const matched = users.find((u: any) => u.email === email && u.password === password);
    if (!matched) {
      return { user: null, error: new Error('Invalid email or password') };
    }
    const usr = { id: matched.id, email: matched.email, created_at: matched.created_at };
    localStorage.setItem('chanlun_current_user', JSON.stringify(usr));
    return { user: usr, error: null };
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { user: null, error };
  return {
    user: data.user ? { id: data.user.id, email: data.user.email || '', created_at: data.user.created_at } : null,
    error: null
  };
}

export async function signOutUser(): Promise<void> {
  if (isMockDb || !supabase) {
    localStorage.removeItem('chanlun_current_user');
    return;
  }
  await supabase.auth.signOut();
}

export async function getCurrentUser(): Promise<SupabaseUser | null> {
  if (isMockDb || !supabase) {
    const cached = localStorage.getItem('chanlun_current_user');
    return cached ? JSON.parse(cached) : null;
  }
  const { data } = await supabase.auth.getUser();
  if (data.user) {
    return { id: data.user.id, email: data.user.email || '', created_at: data.user.created_at };
  }
  return null;
}

/**
 * --- DATA SAVE & RETRIEVAL INTERFACE ---
 */

export async function fetchBacktests(userId: string): Promise<BacktestResult[]> {
  if (isMockDb || !supabase) {
    const tests = JSON.parse(localStorage.getItem('chanlun_backtests') || '[]');
    return tests.filter((t: BacktestResult) => t.userId === userId);
  }

  const { data, error } = await supabase
    .from('backtests')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching backtests from Supabase:', error);
    // Silent failover to localStorage for testing
    const tests = JSON.parse(localStorage.getItem('chanlun_backtests') || '[]');
    return tests.filter((t: BacktestResult) => t.userId === userId);
  }

  // Convert DB fields (snake_case) to client types (camelCase)
  return (data || []).map(row => ({
    id: row.id,
    userId: row.user_id,
    symbol: row.symbol,
    startDate: row.start_date,
    endDate: row.end_date,
    initialBalance: row.initial_balance,
    finalBalance: row.final_balance,
    totalReturnPercent: row.total_return_percent,
    totalTrades: row.total_trades,
    winningTrades: row.winning_trades,
    winRate: row.win_rate,
    trades: typeof row.trades === 'string' ? JSON.parse(row.trades) : row.trades,
    createdAt: row.created_at
  }));
}

export async function saveBacktestResult(result: Omit<BacktestResult, 'id' | 'createdAt'>): Promise<BacktestResult> {
  const newRecord: BacktestResult = {
    ...result,
    id: `bt-${Math.random().toString(36).substr(2, 9)}`,
    createdAt: new Date().toISOString()
  };

  // Always back up locally
  const tests = JSON.parse(localStorage.getItem('chanlun_backtests') || '[]');
  tests.push(newRecord);
  localStorage.setItem('chanlun_backtests', JSON.stringify(tests));

  if (isMockDb || !supabase) {
    return newRecord;
  }

  try {
    const { error } = await supabase.from('backtests').insert([{
      id: newRecord.id,
      user_id: newRecord.userId,
      symbol: newRecord.symbol,
      start_date: newRecord.startDate,
      end_date: newRecord.endDate,
      initial_balance: newRecord.initialBalance,
      final_balance: newRecord.finalBalance,
      total_return_percent: newRecord.totalReturnPercent,
      total_trades: newRecord.totalTrades,
      winning_trades: newRecord.winningTrades,
      win_rate: newRecord.winRate,
      trades: JSON.stringify(newRecord.trades),
      created_at: newRecord.createdAt
    }]);

    if (error) {
      console.warn('Failed to insert in Supabase database, saved locally instead:', error);
    }
  } catch (err) {
    console.warn('Network error saving to Supabase, stored in Local Cache:', err);
  }

  return newRecord;
}

export async function deleteBacktestResult(id: string): Promise<boolean> {
  const tests = JSON.parse(localStorage.getItem('chanlun_backtests') || '[]');
  const filtered = tests.filter((t: BacktestResult) => t.id !== id);
  localStorage.setItem('chanlun_backtests', JSON.stringify(filtered));

  if (isMockDb || !supabase) {
    return true;
  }

  const { error } = await supabase.from('backtests').delete().eq('id', id);
  if (error) {
    console.warn('Failed to delete on Supabase:', error);
    return false;
  }
  return true;
}
