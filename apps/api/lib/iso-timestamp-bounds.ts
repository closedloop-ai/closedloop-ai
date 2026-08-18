/**
 * The single pair of ISO-timestamp bound helpers used whenever two usage
 * buckets are folded into one.
 *
 * Two independent copies existed: `earliestTimestamp`/`latestTimestamp` in
 * `app/agent-sessions/service/component-usage.ts` (the ISS-4778 skill-shadow
 * fold) and `earlier`/`later` in `lib/command-key-admission.ts` (the
 * ISS-4795/ISS-4796 command-key fold). They did the same job for the same kind
 * of caller — a `mergeUsage` widening a first/last-invoked window — but had
 * already drifted on implementation: one compared with `Date.parse`, the other
 * compared the raw strings. Raw string comparison only agrees with instant
 * ordering when both sides are in the same normalized form, so a payload
 * carrying `2026-01-01T00:00:00+02:00` alongside a `Z` timestamp would order
 * differently in the two folds. Extracted here so the two merge paths cannot
 * quietly disagree about which timestamp wins (thadeusb, PR #4322).
 *
 * `Date.parse` is the surviving implementation because it compares the instant
 * rather than the spelling. An unparseable input yields `NaN`, and every `NaN`
 * comparison is false, so the right-hand side is returned — a defined timestamp
 * is preferred over a garbage one rather than propagating the garbage.
 */

/** Earliest of two optional ISO timestamps, ignoring absent ones. */
export function earliestTimestamp(
  left: string | null | undefined,
  right: string | null | undefined
): string | null {
  if (!left) {
    return right ?? null;
  }
  if (!right) {
    return left;
  }
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

/** Latest of two optional ISO timestamps, ignoring absent ones. */
export function latestTimestamp(
  left: string | null | undefined,
  right: string | null | undefined
): string | null {
  if (!left) {
    return right ?? null;
  }
  if (!right) {
    return left;
  }
  return Date.parse(left) >= Date.parse(right) ? left : right;
}
