export type Backoff = {
  minMs: number;
  maxMs: number;
  /** The delay varies by up to this fraction either way. */
  randomizationFactor: number;
};

/** Doubles from `minMs` per attempt (0-based), jittered, never past `maxMs`. */
export function backoffDelayMs(
  attempt: number,
  backoff: Backoff,
  random: () => number
): number {
  const base = Math.min(backoff.maxMs, backoff.minMs * 2 ** attempt);
  const jitter = base * backoff.randomizationFactor * (random() * 2 - 1);
  return Math.min(backoff.maxMs, Math.max(0, Math.round(base + jitter)));
}

/** Node's timer ceiling; a longer delay would fire at once. */
export function clampTimerDelayMs(delayMs: number): number {
  return Math.min(Math.max(0, delayMs), MAX_TIMER_DELAY_MS);
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;
