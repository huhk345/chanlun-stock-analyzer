import { useEffect, useState, type ReactNode } from 'react';

interface KeepAliveProps {
  /** Whether this page is currently the visible route. */
  active: boolean;
  children: ReactNode;
}

/**
 * Page-level keep-alive.
 *
 * React unmounts a page whenever a route switch removes it from the tree,
 * which wipes local state (backtest results, form inputs, chart zoom, chat
 * threads, ...). This wrapper mounts a page on its first visit and then keeps
 * it in the DOM: inactive pages are hidden with `display: none` instead of
 * being destroyed.
 *
 * The active page uses `display: contents`, so the wrapped <main> keeps
 * participating in the App flex layout exactly as before.
 */
export default function KeepAlive({ active, children }: KeepAliveProps) {
  // Lazy mount: never render a page the user has not visited yet.
  const [mounted, setMounted] = useState(active);

  useEffect(() => {
    if (active) setMounted(true);
  }, [active]);

  if (!mounted) return null;

  return (
    <div
      className={active ? 'contents' : 'hidden'}
      aria-hidden={!active}
      // Inert also blocks tab focus / screen-reader access while hidden.
      inert={active ? undefined : true}
    >
      {children}
    </div>
  );
}
