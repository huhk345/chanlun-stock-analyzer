/**
 * Shared TickFlow rate limiter.
 *
 * The free TickFlow API caps traffic at 60 requests / minute. We throttle
 * proactively to 55 / minute (just under the cap) so callers rarely hit the
 * hard limit and the server's 429 / "请求频率超限" response.
 *
 * The limiter is a sliding-window counter keyed on real wall-clock time and is
 * safe to call from both the browser (via api.ts) and the Node scripts.
 */

const DEFAULT_MAX_PER_MIN = 55;
const WINDOW_MS = 60_000;

// Module-level timestamp ring. In the browser this is shared by every
// fetchStockData call; in a Node script it is shared by the whole process.
const requestTimestamps: number[] = [];

/**
 * Block until a request slot is available under the given per-minute cap, then
 * record the outgoing request timestamp and return. Call this immediately
 * before issuing a TickFlow HTTP request.
 */
export async function acquireTickFlowSlot(
  maxPerMin: number = DEFAULT_MAX_PER_MIN,
): Promise<void> {
  while (true) {
    const now = Date.now();

    // Drop timestamps that have aged out of the rolling window.
    while (requestTimestamps.length && now - requestTimestamps[0] > WINDOW_MS) {
      requestTimestamps.shift();
    }

    if (requestTimestamps.length < maxPerMin) {
      requestTimestamps.push(Date.now());
      return;
    }

    // We're at the cap: wait until the oldest timestamp leaves the window,
    // plus a tiny safety margin.
    const waitMs = WINDOW_MS - (now - requestTimestamps[0]) + 50;
    const delay = Math.max(waitMs, 0);
    console.warn(
      `[TickFlow] Rate limiter: at ${maxPerMin}/min cap, throttling ${delay}ms`,
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/** Exposed for tests / manual tuning. */
export const TICKFLOW_MAX_PER_MIN = DEFAULT_MAX_PER_MIN;
