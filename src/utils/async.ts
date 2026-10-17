/**
 * Shared async helpers, safe to use from the browser, the Node server and CLI scripts.
 */

/** Resolve after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
