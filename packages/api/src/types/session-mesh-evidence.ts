import { z } from "zod";

/**
 * Per-delivery usefulness evidence, observed from the recipient's tool stream
 * (ISS-11755, ISS-11761). No prompt, no self-report, no model call — operator
 * ruling 2026-10-01, "we can't prompt".
 *
 * EVERY PROXY IS REPORTED SEPARATELY, never folded into a composite index
 * (operator direction, same date). A composite hides which proxy failed, and
 * these are inferences about behavior — the one that breaks is the one you most
 * need to see break.
 *
 * Each proxy also ships its control, because an uncontrolled behavioral proxy is
 * numerology:
 *   - `placeboAdopted` runs the adoption test against a path the message did NOT
 *     name. If named and unnamed subjects are adopted at the same rate, adoption
 *     is measuring session churn and nothing else.
 *   - `arm` marks whether the message actually reached the model. A withheld
 *     message (held/refused/dismissed) was composed and routed but never
 *     injected, so its proxies are the no-treatment baseline — free, because
 *     those dispositions are already columns on the delivery row.
 */
export const SessionMeshEvidenceArm = {
  /** The context reached the model; its receipt was confirmed. */
  Delivered: "delivered",
  /** Routed but never injected — the no-treatment control. */
  Withheld: "withheld",
} as const;
export type SessionMeshEvidenceArm =
  (typeof SessionMeshEvidenceArm)[keyof typeof SessionMeshEvidenceArm];

/** Derived from the const object so the two can never drift apart. */
export const SESSION_MESH_EVIDENCE_ARM = Object.values(SessionMeshEvidenceArm);

export const sessionMeshDeliveryEvidenceValidator = z.object({
  messageId: z.string().trim().min(1).max(500),
  arm: z.enum(SessionMeshEvidenceArm),
  /** The overlapping subject this evidence is about. */
  subject: z.string().trim().min(1).max(1000),

  /** Collision evidence — feeds `classifySessionMeshCollision`. */
  intentBeforeDelivery: z.boolean(),
  editedDuringClaim: z.boolean(),
  editedAfterClaim: z.boolean(),

  /**
   * Subject adoption: the recipient had NEVER referenced this token before the
   * message, and did after. The strongest causal proxy available, because the
   * token's provenance is traceable — it was not reachable from the session's
   * own context beforehand.
   *
   * `null` is UNKNOWN, never false: the observer's per-session history is capped,
   * and once it saturates an absent token means "not recorded" rather than
   * "never referenced". A `true` there would credit the message for a file the
   * session had already been working on. Any aggregate must exclude `null` from
   * both the numerator and the denominator.
   */
  subjectAdopted: z.boolean().nullable(),
  /**
   * The recipient had an edit in flight on the subject that never completed
   * after the message landed. The literal collision-avoidance event.
   *
   * `null` is UNKNOWN, never false: Desktop installs `PreToolUse` only
   * (`SESSION_MESH_CLAUDE_HOOK_TYPES`, and `removeObsoleteToolHooks` deletes any
   * `PostToolUse` entry), so an observed edit usually carries no completion
   * signal at all. A `false` there would claim a measured absence of
   * abandonment on every such delivery, and a `true` would claim every
   * announced edit was abandoned. Any aggregate must exclude `null` from both
   * the numerator and the denominator.
   */
  abandonedInFlight: z.boolean().nullable(),
  /**
   * Round-trips from delivery to the recipient's first edit of the subject, or
   * `null` when it never edited it. Priced against the fleet's measured
   * discovery baseline to dollarize this delivery; `null` is unknown, not zero.
   */
  convergenceTrips: z.number().int().nonnegative().nullable(),

  /**
   * Control: the same adoption test against a path the message did not name.
   * `null` on a saturated history, for the same reason as `subjectAdopted` —
   * the control must carry the same uncertainty or the lift is computed over
   * asymmetric cohorts.
   */
  placeboAdopted: z.boolean().nullable(),
});
export type SessionMeshDeliveryEvidence = z.infer<
  typeof sessionMeshDeliveryEvidenceValidator
>;

/**
 * Round-trips this delivery saved, against the measured discovery baseline.
 *
 * `baselineTrips` is the fleet's own median/mean/p90 cost of finding a file
 * unaided; the caller supplies it, so no sampled constant lives here. Returns
 * `null` when the recipient never edited the subject (nothing converged) or the
 * baseline is unknown — never 0, which would read as "this delivery saved
 * nothing" rather than "this delivery was not measurable".
 *
 * Clamped at 0: a delivery that took LONGER than the unaided baseline did not
 * save negative work, it simply saved none, and a negative would subtract real
 * savings from other deliveries in any sum.
 */
export function sessionMeshTripsSavedBy(
  evidence: Pick<SessionMeshDeliveryEvidence, "convergenceTrips">,
  baselineTrips: number | null
): number | null {
  const { convergenceTrips } = evidence;
  if (convergenceTrips === null) {
    return null;
  }
  if (
    !(
      typeof baselineTrips === "number" &&
      Number.isFinite(baselineTrips) &&
      baselineTrips >= 0
    )
  ) {
    return null;
  }
  return Math.max(0, baselineTrips - convergenceTrips);
}

export const sessionMeshProxyTotalsValidator = z.object({
  observed: z.number().int().nonnegative(),
  subjectAdopted: z.number().int().nonnegative(),
  abandonedInFlight: z.number().int().nonnegative(),
  converged: z.number().int().nonnegative(),
  placeboAdopted: z.number().int().nonnegative(),
});
export type SessionMeshProxyTotals = z.infer<
  typeof sessionMeshProxyTotalsValidator
>;

/**
 * Adoption lift over the placebo: how much more often a NAMED subject is adopted
 * than an unnamed one, in the same sessions.
 *
 * This is the number that says whether adoption means anything at all. At or
 * below zero the proxy is measuring churn and must not be reported as evidence
 * of usefulness. `null` when nothing was observed — not 0, which would claim a
 * measured absence of lift.
 */
export function sessionMeshAdoptionLift(
  totals: SessionMeshProxyTotals
): number | null {
  if (!(Number.isFinite(totals.observed) && totals.observed > 0)) {
    return null;
  }
  const lift =
    (totals.subjectAdopted - totals.placeboAdopted) / totals.observed;
  return Number.isFinite(lift) ? lift : null;
}
