import { useEffect, useState } from 'react';
import { fetchRustHealth } from '../utils/rustSimApi';

/**
 * 回测引擎 (engine-rs, :8901) 的可用性。
 *
 * 引擎是独立进程，前端拿不到它就只剩一张报错面板 —— 所以「策略回测」这个
 * 页面和导航入口在引擎不可用时整体不渲染，而不是渲染出来再提示用户去启动。
 *
 * 返回 `null` 表示还没探测完（首帧），`true` / `false` 是探测结果。
 * 离线时每 15s 重探一次，并在窗口重新获得焦点 / 切回标签页时立刻重探，
 * 这样先把 `pnpm start` 里的引擎拉起来、再回到页面就能直接看到入口。
 */

const RETRY_MS = 15_000;
const TIMEOUT_MS = 2_500;

export default function useEngineStatus(): boolean | null {
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    // 全部状态都是本次 effect 私有的：StrictMode 下 effect 会 mount→cleanup→mount，
    // 若用 ref 共享「请求在途」标记，第二次挂载会被第一次的残留标记挡住，
    // 结果就是 probe 永远不落地、入口永远不出现。
    let cancelled = false;
    let inFlight = false;
    let retryTimer: number | null = null;

    const clearRetry = () => {
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const probe = async () => {
      // focus / visibilitychange 可能和定时器同时触发，只保留一个在途请求
      if (cancelled || inFlight) return;
      inFlight = true;
      clearRetry();

      let ok = false;
      try {
        const health = await fetchRustHealth(AbortSignal.timeout(TIMEOUT_MS));
        ok = health?.ok !== false;
      } catch {
        ok = false;
      } finally {
        inFlight = false;
      }

      if (cancelled) return;
      setOnline(ok);
      if (!ok) retryTimer = window.setTimeout(probe, RETRY_MS);
    };

    const probeWhenVisible = () => {
      if (document.visibilityState === 'visible') probe();
    };

    probe();
    window.addEventListener('focus', probeWhenVisible);
    document.addEventListener('visibilitychange', probeWhenVisible);

    return () => {
      cancelled = true;
      clearRetry();
      window.removeEventListener('focus', probeWhenVisible);
      document.removeEventListener('visibilitychange', probeWhenVisible);
    };
  }, []);

  return online;
}
