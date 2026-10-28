/// <reference types="node" />

/** Shortest delay a Node timer honours; anything below is rounded up to it. */
export const MIN_TIMER_DELAY_MS = 1;
/** Largest delay a Node timer can hold; above this it fires on the next tick. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * A millisecond duration knob bounded to what a Node timer can actually honour,
 * because the value reaches `setTimeout`/`setInterval` directly and every
 * out-of-range input there collapses the delay to roughly nothing rather than
 * being rejected. A bare `??` fallback is nullish-only, so it defends the UNSET
 * case and nothing else: `""` parses to 0, a non-numeric string parses to NaN,
 * a sub-millisecond value rounds up to 1, and a value past the 32-bit ceiling
 * overflows — all four pass straight through and fire near-immediately.
 *
 * `warn` is injected because this package is consumed cross-repo and must not
 * import `@repo/observability/log`, which pulls in the workspace-only
 * `@repo/api`. The `console.warn` default is the floor, not the target: a
 * caller that owns a structured logger passes its own sink so the warning
 * reaches that surface's monitored channel instead of anonymous stderr.
 */
export function parsePositiveEnvMs(
  name: string,
  defaultMs: number,
  warn: EnvWarnSink = (message, context) => {
    console.warn(message, context);
  }
): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultMs;
  }
  const value = Number(raw);
  if (
    !Number.isFinite(value) ||
    value < MIN_TIMER_DELAY_MS ||
    value > MAX_TIMER_DELAY_MS
  ) {
    warn(`Invalid ${name}, defaulting to ${defaultMs}`, { value: raw });
    return defaultMs;
  }
  return value;
}

/**
 * Sink for the invalid-value warning. Shaped `(message, context)` to match
 * `@repo/observability/log`'s `log.warn`, so a caller holding that logger can
 * pass it straight through without an adapter.
 */
export type EnvWarnSink = (message: string, context: { value: string }) => void;

/**
 * Clamp a caller-supplied millisecond timeout to what a Node timer can honour,
 * yielding `undefined` for a value that is not a finite number and for a
 * nonpositive one.
 *
 * Shares `[MIN_TIMER_DELAY_MS, MAX_TIMER_DELAY_MS]` with `parsePositiveEnvMs`
 * because both feed `setTimeout`, where an out-of-range delay collapses rather
 * than being rejected — and it collapses in OPPOSITE directions at the two
 * ends, so a single-sided guard inverts the caller's intent. Past the ceiling
 * Node fires after roughly a millisecond, turning the longest expressible
 * timeout into the shortest; below a millisecond the value truncates to 0,
 * which a downstream `> 0` guard reads as "no timeout at all", turning the
 * shortest expressible timeout into an unbounded wait. A sub-millisecond
 * request is therefore floored to 1 rather than dropped.
 *
 * A nonpositive value is dropped instead of floored, because it carries no
 * short-timeout intent to preserve. Flooring `0` or `-5` to 1 would abort an
 * otherwise valid command about a millisecond after dispatch, so a
 * version-skewed peer that put junk in this one optional field would lose
 * every command it sends. Omitting the field routes it to the absent-timeout
 * path it already takes today, where the executor's own route-aware watchdog
 * still bounds the wait for response headers.
 *
 * Never throws. This reads a version-skewed cross-repo payload, so a value it
 * dislikes is clamped or dropped, never raised.
 */
export function clampTimerDelayMs(
  value: unknown,
  onRejected?: TimerDelayRejectionSink
): number | undefined {
  const clamped =
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.min(
          Math.max(Math.trunc(value), MIN_TIMER_DELAY_MS),
          MAX_TIMER_DELAY_MS
        )
      : undefined;
  if (value !== undefined && clamped !== value) {
    onRejected?.({ value, clampedTo: clamped });
  }
  return clamped;
}

/**
 * Notified when {@link clampTimerDelayMs} changes or drops a value that was
 * actually PRESENT, so a server caller can route malformed cross-repo input to
 * its monitored channel instead of coercing it away in silence. An absent
 * field is the normal case and never notifies.
 *
 * Injected for the same reason `parsePositiveEnvMs` injects `warn`: this
 * package is consumed cross-repo and must not import `@repo/observability/log`,
 * which pulls in the workspace-only `@repo/api`. Browser callers pass nothing —
 * a client-side log is banned by the `no-client-debug-logging` gate.
 */
export type TimerDelayRejectionSink = (context: {
  value: unknown;
  clampedTo: number | undefined;
}) => void;
