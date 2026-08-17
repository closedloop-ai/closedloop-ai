/**
 * ISS-4675: the numeric READER for the pre-formatted duration strings the
 * desktop collector emits on the session sync payload (`wallClock`,
 * `activeAgent`, `waitingUser`).
 *
 * Those fields cross the wire as DISPLAY strings, not numbers — the collector
 * formats them once with `formatTraceDuration`
 * (`apps/desktop/src/main/database/session-trace-duration.ts`) and every
 * consumer has, until now, only ever rendered them. But two surfaces need the
 * NUMBER behind the string, not the string:
 *
 *   - the cloud `?sortBy=duration` comparator
 *     (`apps/api/app/agent-sessions/service/session-display-sort.ts`), which has
 *     to ORDER rows by the same value the Duration cell renders, and
 *   - the session-detail Overview event-rate denominator
 *     (`packages/app/agents/components/detail/detail-content.ts`), which has to
 *     DIVIDE by it so the rate reconciles with the Duration card above it.
 *
 * Both live in different packages, so the parse lives here — one reader shared
 * by `apps/api`, `packages/app`, and `apps/desktop` — rather than being
 * re-derived (and drifting) at each call site.
 */

/**
 * One `<number><unit>` token of a formatted duration, e.g. `4h`, `54m`, `12s`.
 *
 * ANCHORED (`^…$`) and applied per whitespace-separated token, so the grammar is
 * FULLY CONSUMED: every character of the value has to belong to a token or the
 * whole value is rejected. A scanning (`matchAll`) match would have accepted any
 * payload that merely CONTAINED a token — `-5m` would have yielded a positive
 * five minutes and `garbage 5m` five minutes — and the sort/rate callers would
 * then have used that plausible-but-wrong number instead of taking their safe
 * calendar/null fallback.
 *
 * The unit is matched as ANY letter run (not just `[hms]`) so an unrecognized
 * unit is DETECTED rather than skipped over — see the null-on-unknown-unit rule
 * in {@link parseTraceDurationMs}. Declared at module scope for Ultracite's
 * `useTopLevelRegex` rule.
 */
const DURATION_TOKEN_PATTERN = /^(\d+(?:\.\d+)?)([a-z]+)$/i;

/** Whitespace run separating two `<number><unit>` tokens (`4h 54m`). */
const TOKEN_SEPARATOR_PATTERN = /\s+/;

/**
 * The ONE legacy suffix the grammar tolerates: a trailing `idle` token
 * (case-insensitive).
 *
 * FEA-4275: the desktop trace collector historically baked the display label
 * INTO the `waitingUser` value (`"41s idle"`), so already-synced sessions carry
 * the word inside the string. Stripping it here — and ONLY it — keeps those rows
 * readable without loosening the grammar for arbitrary trailing prose. The
 * collector stopped baking the label in, but the already-synced rows are still
 * out there, so the strip stays load-bearing for this reader.
 *
 * The display-side normalizer this pattern was exported FOR
 * (`resolveSessionDurationBreakdown`) is GONE: ISS-5131 retired the Duration
 * row's sub-facts, so nothing renders `activeAgent`/`waitingUser` today and
 * `parseTraceDurationMs` below is now the only consumer. The `export` STAYS —
 * a renderer that re-presents these values (ISS-4571) has to strip
 * byte-identically to the reader, which is the whole reason the pattern is
 * shared rather than inlined.
 */
export const TRAILING_IDLE_TOKEN_PATTERN = /\s*\bidle\s*$/i;

/**
 * The longest duration string any producer can legitimately emit, used as an
 * ingest bound and as this reader's own up-front reject.
 *
 * `formatTraceDuration`'s widest output is `<hours>h <minutes>m`, and
 * `formatDuration`'s is the same shape, so even an absurd five-digit hour count
 * with the legacy `idle` suffix fits well inside 32 characters. The field
 * crosses the wire as an arbitrary string and is then bulk-read for the
 * `?sortBy=duration` candidate scan (10,000 rows), so an unbounded value is a
 * memory amplifier on the read path, not just an unreadable one — the sync
 * boundary caps it at this width (`apps/api/lib/desktop-agent-sessions-schema.ts`)
 * and this reader refuses anything longer even if a legacy row predates the cap.
 */
export const TRACE_DURATION_MAX_CHARS = 32;

/**
 * Milliseconds per unit token, keyed by the lower-cased unit string.
 *
 * Built on a NULL-prototype object, not an object literal: the key is a token
 * lifted straight out of a cross-repo payload string, so `"5constructor"` on a
 * plain `{}` would resolve to `Object.prototype.constructor` — a function, not
 * `undefined` — and the unknown-unit guard below would wave it through into
 * `amount * unitMs`, returning `NaN` instead of `null`. Same reason the repo
 * builds every untrusted-key dispatch table this way.
 */
const UNIT_MS: Readonly<Record<string, number>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, number>, {
    h: 3_600_000,
    m: 60_000,
    s: 1000,
  })
);

/**
 * Parse a formatted duration string to milliseconds, or `null` when the value
 * is absent, blank, or carries no recognizable `<number><unit>` token.
 *
 * Accepts every shape the two producers emit, so a version-skewed row parses
 * whichever formatter wrote it:
 *   - `formatTraceDuration` (the collector / `wallClock`): `45s`, `30m`,
 *     `4h`, `4h 54m`;
 *   - `formatDuration` (`packages/app/shared/lib/format-utils.ts`, the
 *     calendar fallback): `45s`, `30m 12s`, `4h 54m`.
 *
 * Returns `null` — never a fabricated `0` — for anything it cannot read, so a
 * caller can fall back to its own derivation rather than ordering or dividing
 * by a value that was never measured. An explicitly measured zero (`"0s"`)
 * parses to `0`, which is a real duration and distinct from `null`.
 *
 * The grammar is FULLY CONSUMED, not scanned: the value must be nothing but
 * whitespace-separated `<number><unit>` tokens (optionally followed by the one
 * legacy `idle` suffix, {@link TRAILING_IDLE_TOKEN_PATTERN}), within
 * {@link TRACE_DURATION_MAX_CHARS}. A PARTIAL match is a rejection, because the
 * field crosses the sync boundary as an arbitrary string: a corrupt or
 * version-skewed `"-5m"` must not read as a POSITIVE five minutes while the
 * Duration cell prints `-5m`, and `"garbage 5m"` must not read as five minutes
 * at all. Both now degrade to `null`, which sends the sort and the event-rate
 * denominator to their own safe calendar fallback.
 *
 * A numeric token in an UNKNOWN unit (a `2d` from a future Desktop build) makes
 * the WHOLE value unreadable — `null`, not the readable remainder. Cross-repo
 * skew is real here, and silently dropping the largest component would emit a
 * plausible-but-wrong number (`"2d 4h"` → `4h`) that would sort the row into the
 * wrong place and divide the wrong denominator. Degrading to `null` sends the
 * caller to its own fallback instead, which is honest; it never throws, so a
 * newer producer can never crash a list render or a sort.
 */
export function parseTraceDurationMs(
  value: string | null | undefined
): number | null {
  if (value == null || value.length > TRACE_DURATION_MAX_CHARS) {
    return null;
  }
  const normalized = value.replace(TRAILING_IDLE_TOKEN_PATTERN, "").trim();
  if (normalized.length === 0) {
    return null;
  }
  let totalMs = 0;
  for (const token of normalized.split(TOKEN_SEPARATOR_PATTERN)) {
    // Anchored per token, so any character the grammar does not define — a
    // sign, a stray word, punctuation — fails the whole value rather than being
    // skipped over.
    const match = DURATION_TOKEN_PATTERN.exec(token);
    const amount = Number.parseFloat(match?.[1] ?? "");
    const unitMs = UNIT_MS[(match?.[2] ?? "").toLowerCase()];
    if (!(Number.isFinite(amount) && unitMs !== undefined)) {
      return null;
    }
    totalMs += amount * unitMs;
  }
  if (!Number.isFinite(totalMs)) {
    return null;
  }
  return Math.round(totalMs);
}
