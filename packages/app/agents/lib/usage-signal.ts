/**
 * ISS-5363 (wongk review): the ONE derivation of "does this component have
 * usage?" that every component-detail surface keys its empty state off.
 *
 * `AgentComponentDetail.invocations`/`.sessions` are `number | null` on the
 * wire: a producer that cannot compute the count sends `null` (the desktop
 * detail reader), and a version-skewed producer can omit the field entirely.
 * `componentMetrics` already dashes on both. The tabs and the token-trend chart
 * did NOT — they collapsed the unknown into `0` with `?? 0` and then rendered a
 * confident denial ("No sessions yet", "No usage recorded for this component
 * yet") directly beneath a card showing a dash. One payload, two contradictory
 * claims.
 *
 * Three states, never two, because "we measured none" and "we could not measure"
 * are different facts and only one of them is safe to state as a denial.
 */

/** Whether a detail surface can claim usage, claim none, or claim neither. */
export const UsageSignal = {
  /** Measured usage exists (a positive count, or attributed usage rows). */
  Present: "present",
  /** Measured, and there is none. Safe to state as a denial. */
  None: "none",
  /** Not measurable from this payload. Never state as a denial. */
  Unknown: "unknown",
} as const;
export type UsageSignal = (typeof UsageSignal)[keyof typeof UsageSignal];

/**
 * Resolve the usage signal for a component detail surface.
 *
 * Attributed usage rows win outright: they are direct evidence, whatever the
 * count says. Otherwise the count decides — but only when it IS a count.
 * `Number.isFinite` rather than `!= null` for the same reason `componentMetrics`
 * uses it: the payload is wire data, so an omitted field arrives as `undefined`
 * and must land in `Unknown`, not be coerced to a zero nobody measured.
 */
export function resolveUsageSignal(
  sessions: number | null | undefined,
  attributedUsageCount: number
): UsageSignal {
  if (attributedUsageCount > 0) {
    return UsageSignal.Present;
  }
  if (typeof sessions === "number" && Number.isFinite(sessions)) {
    return sessions > 0 ? UsageSignal.Present : UsageSignal.None;
  }
  return UsageSignal.Unknown;
}
