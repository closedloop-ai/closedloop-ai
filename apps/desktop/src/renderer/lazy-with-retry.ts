import { type ComponentType, type LazyExoticComponent, lazy } from "react";

/**
 * Options controlling the retry behavior of {@link importWithRetry}.
 */
type ImportRetryOptions = {
  /** Extra attempts after the first (default 2 → 3 total attempts). */
  retries?: number;
  /** Base backoff in ms; the Nth retry waits `baseDelayMs * N` (default 200). */
  baseDelayMs?: number;
  /**
   * Injectable delay so tests can run without real timers. Defaults to a
   * `setTimeout`-backed sleep. `baseDelayMs: 0` also short-circuits the wait.
   */
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 200;

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Runs a dynamic-import factory, retrying a few times with linear backoff
 * before giving up.
 *
 * WHY: Lazily-imported route chunks can fail to load for transient reasons —
 * a dev-server restart, a momentary network blip, or a stale/renamed chunk
 * requested right after an app update. A single such rejection would otherwise
 * propagate through Suspense to the root error boundary and white-screen the
 * whole renderer. Retrying lets a momentary hiccup self-heal instead of
 * bricking the window; a genuinely-broken chunk still rejects (with the last
 * error) after all attempts are exhausted, so the boundary still catches it.
 */
export async function importWithRetry<T>(
  factory: () => Promise<T>,
  options?: ImportRetryOptions
): Promise<T> {
  const retries = options?.retries ?? DEFAULT_RETRIES;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = options?.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await factory();
    } catch (error) {
      lastError = error;
      // Wait before the next attempt only if one remains; linear backoff keeps
      // the total delay small while still spacing out reload attempts.
      if (attempt < retries) {
        await sleep(baseDelayMs * (attempt + 1));
      }
    }
  }
  throw lastError;
}

/**
 * Drop-in replacement for {@link lazy} that retries the import factory before
 * surfacing a failure. See {@link importWithRetry} for the WHY.
 */
export function lazyWithRetry<
  // Mirrors React's own `lazy` constraint (`ComponentType<any>`): components
  // have differing, invariant prop shapes, so a narrower constraint such as
  // `ComponentType<unknown>` would reject any component that declares props.
  // biome-ignore lint/suspicious/noExplicitAny: matches React.lazy's signature so this stays a drop-in replacement.
  T extends ComponentType<any>,
>(
  factory: () => Promise<{ default: T }>,
  options?: { retries?: number; baseDelayMs?: number }
): LazyExoticComponent<T> {
  return lazy(() => importWithRetry(factory, options));
}
