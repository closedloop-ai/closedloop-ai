import type { DesktopHelloNackReason } from "@repo/api/src/types/compute-target";

/**
 * Races a promise against a timeout. If the promise does not settle within
 * `timeoutMs`, the returned promise rejects with a descriptive Error whose
 * message begins with `${label} timed out after `. Callers can detect the
 * timeout case via `isTimeoutError(error, label)`.
 *
 * The timer is always cleaned up regardless of outcome, so it won't keep
 * the Node.js event loop alive after the race settles.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).then(
    (value) => {
      clearTimeout(timer);
      return value;
    },
    (error: unknown) => {
      clearTimeout(timer);
      throw error;
    }
  );
}

/**
 * Times an async operation and records the elapsed milliseconds into
 * `timings[key]`. Returns the resolved value of the promise.
 *
 * This is a convenience wrapper that eliminates the repeated
 * `const start = performance.now(); ... timings.x = Math.round(performance.now() - start)`
 * pattern in hello handlers.
 */
export async function timeStage<K extends string, T>(
  timings: Partial<Record<K, number>>,
  key: K,
  fn: () => Promise<T>
): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    timings[key] = Math.round(performance.now() - start);
  }
}

/**
 * Returns true iff `error` was produced by `withTimeout` for the given
 * `label`. Use this at call sites to distinguish a deadline expiry from
 * an underlying rejection that `withTimeout` simply rethrows.
 */
export function isTimeoutError(error: unknown, label: string): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith(`${label} timed out after `)
  );
}

/**
 * Result variant returned by `runStage` — never throws, always settles.
 * On failure, `cause` carries the original error so call sites can log it
 * and `isTimeoutError(cause, label)` can disambiguate the failure mode.
 */
export type StageResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: DesktopHelloNackReason; cause: unknown };

/**
 * Race `promise` against `timeoutMs` and convert any rejection into a typed
 * StageResult. `timeoutReason` is used when the deadline expires; any other
 * rejection maps to `failureReason` (or `timeoutReason` when omitted).
 *
 * Distinct from `withTimeout` in that it never throws — call sites narrow
 * on `.ok` instead of wrapping in try/catch. Used by both desktop-gateway
 * hello paths (relay + direct socket) so per-stage nack reasons flow as
 * values, not as parsed error messages.
 */
export async function runStage<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  timeoutReason: DesktopHelloNackReason,
  failureReason?: DesktopHelloNackReason
): Promise<StageResult<T>> {
  try {
    const value = await withTimeout(promise, timeoutMs, label);
    return { ok: true, value };
  } catch (cause) {
    const reason = isTimeoutError(cause, label)
      ? timeoutReason
      : (failureReason ?? timeoutReason);
    return { ok: false, reason, cause };
  }
}
