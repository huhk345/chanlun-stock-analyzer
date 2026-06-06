import { BacktestResult } from '../types/stock';

// User structures
export interface SupabaseUser {
  id: string;
  email: string;
  created_at: string;
}

export function isUsingMockDb(): boolean {
  return true;
}

/**
 * --- AUTHENTICATION INTERFACE (LocalStorage) ---
 */

export async function signUpUser(email: string, password: string): Promise<{ user: SupabaseUser | null; error: Error | null }> {
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

export async function signInUser(email: string, password: string): Promise<{ user: SupabaseUser | null; error: Error | null }> {
  const users = JSON.parse(localStorage.getItem('chanlun_users') || '[]');
  const matched = users.find((u: any) => u.email === email && u.password === password);
  if (!matched) {
    return { user: null, error: new Error('Invalid email or password') };
  }
  const usr = { id: matched.id, email: matched.email, created_at: matched.created_at };
  localStorage.setItem('chanlun_current_user', JSON.stringify(usr));
  return { user: usr, error: null };
}

export async function signOutUser(): Promise<void> {
  localStorage.removeItem('chanlun_current_user');
}

export async function getCurrentUser(): Promise<SupabaseUser | null> {
  const cached = localStorage.getItem('chanlun_current_user');
  return cached ? JSON.parse(cached) : null;
}

/**
 * --- DATA SAVE & RETRIEVAL INTERFACE (LocalStorage) ---
 */

export async function fetchBacktests(userId: string): Promise<BacktestResult[]> {
  const tests = JSON.parse(localStorage.getItem('chanlun_backtests') || '[]');
  return tests.filter((t: BacktestResult) => t.userId === userId);
}

export async function saveBacktestResult(result: Omit<BacktestResult, 'id' | 'createdAt'>): Promise<BacktestResult> {
  const newRecord: BacktestResult = {
    ...result,
    id: `bt-${Math.random().toString(36).substr(2, 9)}`,
    createdAt: new Date().toISOString()
  };

  const tests = JSON.parse(localStorage.getItem('chanlun_backtests') || '[]');
  tests.push(newRecord);
  localStorage.setItem('chanlun_backtests', JSON.stringify(tests));

  return newRecord;
}

export async function deleteBacktestResult(id: string): Promise<boolean> {
  const tests = JSON.parse(localStorage.getItem('chanlun_backtests') || '[]');
  const filtered = tests.filter((t: BacktestResult) => t.id !== id);
  localStorage.setItem('chanlun_backtests', JSON.stringify(filtered));
  return true;
}
