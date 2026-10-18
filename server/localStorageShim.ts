/**
 * Node.js 环境下为 src/utils 中依赖 localStorage 的模块提供最小化 shim。
 *
 * 回测引擎在服务端运行时会调用 loadStoredIndicators() → userCodeStorage.getAll()
 * → localStorage.getItem。服务端没有浏览器 localStorage, 返回空即可
 * (等价于用户尚未保存任何自定义指标/策略; 内建指标 MA/BOLL/MACD 不受影响)。
 *
 * 在调用 runBacktest / createBacktestStepper 之前导入并执行 installLocalStorageShim()。
 */

export function installLocalStorageShim(): void {
  if (typeof globalThis.localStorage !== 'undefined') return;

  const store = new Map<string, string>();
  const keyList = () => Array.from(store.keys());

  globalThis.localStorage = {
    get length(): number {
      return store.size;
    },
    getItem(key: string): string | null {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string): void {
      store.set(key, String(value));
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    clear(): void {
      store.clear();
    },
    key(index: number): string | null {
      return keyList()[index] ?? null;
    },
  } as unknown as Storage;
}
