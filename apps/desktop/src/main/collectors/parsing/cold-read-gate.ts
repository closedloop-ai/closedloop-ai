/**
 * FEA-3132 (B1/B5): memory-aware concurrency cap for cold full-file reads.
 *
 * Two collector paths buffer a whole file into the db-host heap on their cold
 * branch: `parseChatSessionFile` (Copilot chat JSON) and the cold transcript
 * token extraction (`readFileSync` + `split("\n")`). Each read is bounded by a
 * `statSync` size-admission gate, but N concurrent cold reads of near-cap files
 * still co-peak — N full buffers materialized in the one worker heap at once.
 *
 * This module bounds that fan-out: at most `maxConcurrency` cold reads run at
 * a time. It is a counting semaphore (not the promise-chain mutex used by
 * `heavy-op-gate.ts`) because a small parallel width (default 2) parses faster
 * than strict serialization while still capping the peak buffer count. Like the
 * heavy-op gate, a rejected task releases its permit so one failing read can
 * never wedge the gate shut for the reads queued behind it.
 *
 * The cap is conservative and configurable: `COLD_READ_MAX_CONCURRENCY` env
 * override, falling back to `DEFAULT_COLD_READ_CONCURRENCY`. The P1 streaming
 * rewrite (readline over `requests[]`) is deferred — this only bounds the
 * existing full-buffer reads.
 */

/** Conservative default parallel width for cold full-file reads. */
export const DEFAULT_COLD_READ_CONCURRENCY = 2;

/**
 * Resolve the configured cold-read concurrency cap. `COLD_READ_MAX_CONCURRENCY`
 * overrides the default; a missing/invalid/non-positive value falls back to the
 * conservative default.
 */
export function resolveColdReadConcurrency(): number {
  const raw = Number(process.env.COLD_READ_MAX_CONCURRENCY);
  if (Number.isInteger(raw) && raw > 0) {
    return raw;
  }
  return DEFAULT_COLD_READ_CONCURRENCY;
}

export type ColdReadGate = {
  /**
   * Run `task` once a permit is available, never letting more than
   * `maxConcurrency` tasks hold a permit at once.
   */
  run: <T>(task: () => T | Promise<T>) => Promise<T>;
  /** Number of tasks currently holding a permit (for tests/observability). */
  readonly active: number;
};

/**
 * Create a counting-semaphore gate bounding concurrent cold reads.
 *
 * @param maxConcurrency permits to hand out at once (defaults to the resolved
 *   configured cap). Values < 1 are clamped to 1.
 */
export function createColdReadGate(
  maxConcurrency: number = resolveColdReadConcurrency()
): ColdReadGate {
  const max = Math.max(1, Math.floor(maxConcurrency));
  let active = 0;
  const waiters: Array<() => void> = [];

  const release = (): void => {
    active -= 1;
    const next = waiters.shift();
    if (next) {
      next();
    }
  };

  const acquire = (): Promise<void> => {
    if (active < max) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push(() => {
        active += 1;
        resolve();
      });
    });
  };

  return {
    async run<T>(task: () => T | Promise<T>): Promise<T> {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
    get active(): number {
      return active;
    },
  };
}

/**
 * Process-wide default gate shared by the cold Copilot-chat and transcript
 * reads so their peaks are bounded against EACH OTHER, not just within one
 * collector — the db-host worker heap is a single shared budget.
 */
export const coldReadGate = createColdReadGate();
