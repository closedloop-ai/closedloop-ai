/**
 * @file retry-after-header.ts
 * @description ISS-8689: parse an HTTP `Retry-After` header into milliseconds.
 *
 * PRD-699 Appendix A (the approved classification standard) requires every
 * ENVIRONMENTAL defer to honor `Retry-After`; fix F7 names the transcript lane
 * specifically. This is the whole of that parse, kept as a leaf so it can be
 * tested against the wire forms directly.
 *
 * RFC 9110 allows two spellings and this accepts both: `delta-seconds` (a
 * non-negative integer) and an HTTP-date. Anything else — a float, a negative,
 * a word, an empty string, a date already in the past, a value so large it
 * cannot be a real instruction — answers `undefined`, which callers must read
 * as "the server said nothing I can use" and NOT as a stand-down. Inferring a
 * wait from a value we could not read is the failure this returns `undefined`
 * to avoid.
 *
 * No existing parser was reusable: `packages/github/provider-error-classification.ts`
 * has one but it is unexported and lives in a server package the desktop main
 * process cannot import, and `scripts/deploy/vercel-deployments.ts` handles
 * delta-seconds only.
 */

/**
 * A `Retry-After` past this is not an instruction, it is a bug or an attack.
 *
 * RFC 9110 sets no upper bound, so this is deliberately far above any real one:
 * the lane's own 24h run ceiling is what actually bounds an accepted value, and
 * clamping there rather than here means a long-but-sane hint is HONORED and
 * capped instead of discarded. This exists only to stop an absurd value from
 * being carried into that arithmetic at all.
 */
const MAX_RETRY_AFTER_MS = 30 * 24 * 60 * 60_000;

/** `delta-seconds` is defined as a non-negative INTEGER; a float is malformed. */
const DELTA_SECONDS_PATTERN = /^\d+$/;

/**
 * All three HTTP-date forms RFC 9110 permits begin with a weekday name —
 * `Wed, 09 Jul 2026 …`, `Wednesday, 09-Jul-26 …`, `Wed Jul  9 …` — so requiring
 * one before handing the value to `Date.parse` is load-bearing, not tidiness.
 * `Date.parse` accepts a great deal that is not a date: `Date.parse("-5")` and
 * `Date.parse("Retry-After: 60")` both return real instants, both in the past,
 * and a past instant reads downstream as "the wait is over, retry now". A
 * garbage header must produce NO instruction rather than the most aggressive
 * one, which is why this rejects by shape instead of trusting the parse.
 */
const HTTP_DATE_PREFIX_PATTERN = /^(?:mon|tue|wed|thu|fri|sat|sun)/i;

/**
 * Milliseconds the server asked us to wait, or `undefined` when the header is
 * absent or unparseable. `nowMs` is the instant the HTTP-date form is measured
 * against, passed in so the caller's clock is the only clock.
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
  nowMs: number
): number | undefined {
  if (!header) {
    return undefined;
  }
  const value = header.trim();
  if (value.length === 0) {
    return undefined;
  }
  const deltaMs = DELTA_SECONDS_PATTERN.test(value)
    ? Number(value) * 1000
    : parseHttpDateDelayMs(value, nowMs);
  if (deltaMs === undefined) {
    return undefined;
  }
  // A zero delay is a legitimate "retry immediately" and is preserved as 0; the
  // caller's own floor is what decides whether that is honored.
  if (
    !Number.isFinite(deltaMs) ||
    deltaMs < 0 ||
    deltaMs > MAX_RETRY_AFTER_MS
  ) {
    return undefined;
  }
  return deltaMs;
}

/**
 * The HTTP-date form, resolved against `nowMs`. A date in the past means the
 * wait has already elapsed, which is `0` — not a rejection, and not a negative
 * that would later read as "unparseable".
 */
function parseHttpDateDelayMs(
  value: string,
  nowMs: number
): number | undefined {
  if (!HTTP_DATE_PREFIX_PATTERN.test(value)) {
    return undefined;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return Math.max(0, parsed - nowMs);
}
