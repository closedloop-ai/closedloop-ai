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
 * a dev-server restart or a momentary network blip. A single such rejection
 * would otherwise propagate through Suspense to the root error boundary and
 * white-screen the whole renderer. Retrying lets a momentary hiccup self-heal
 * instead of bricking the window; a genuinely-broken chunk still rejects
 * (with the last error) after all attempts are exhausted, so the boundary
 * still catches it.
 *
 * NOTE: only a static renderer (`pnpm dev:static`, `pnpm start`) reads `dist/`
 * — `pnpm dev` serves from Vite — so only it is exposed to a concurrent
 * `pnpm build` rewriting those files. A chunk whose content changed is then
 * gone permanently under its old hashed name (an unchanged one re-emits at the
 * same hash); retrying cannot recover that, so restart the app.
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
  // Bounded by its OWN props: a fixed props type such as `unknown` would reject
  // every component that declares props, since props sit in a parameter
  // position.
  T extends ComponentType<PropsOf<T>>,
>(
  factory: () => Promise<{ default: T }>,
  options?: { retries?: number; baseDelayMs?: number }
): LazyExoticComponent<T> {
  return lazy(() => importWithRetry(factory, options));
}

/** The props a component declares. */
type PropsOf<T> = T extends ComponentType<infer Props> ? Props : never;
