import { setTimeout as sleep } from "node:timers/promises";

/** Polls `predicate` until it holds, rejecting once `timeoutMs` has elapsed. */
export async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  intervalMs = 10,
  timeoutMessage:
    | string
    | (() => string) = `waitForCondition timed out after ${timeoutMs}ms`
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error(
        typeof timeoutMessage === "function" ? timeoutMessage() : timeoutMessage
      );
    }
    await sleep(intervalMs);
  }
}

/**
 * Polls `probe` until it returns a value other than `undefined` and resolves
 * with that value, rejecting with `onTimeout()` once `timeoutMs` has elapsed.
 */
export async function pollUntilDefined<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  options: { timeoutMs: number; intervalMs: number; onTimeout: () => unknown }
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    await sleep(options.intervalMs);
  }
  throw options.onTimeout();
}
