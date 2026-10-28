import { z } from "zod";

/**
 * The outcome of a DETECTED collision: what the recipient did after being told
 * a peer was working the same path (ISS-11755).
 *
 * A collision is detected at publish time — `relevanceFor` computes the path and
 * symbol overlap and persists it on the delivery. This module classifies what
 * happened NEXT, from the recipient's own tool stream. No model call, no prompt,
 * no self-report — operator ruling 2026-10-01: "if we had something like Jev we
 * could use a classifier; but that isn't guaranteed to be there and we don't
 * want to cost another LLM turn to save them."
 *
 * THE LOAD-BEARING RULE IS `unknown`. "The recipient did not edit the path" is
 * not avoidance — most recipients were never going to touch it, and counting
 * those would drive `avoided` to near 100% and make the metric worthless.
 * Avoidance requires INTENT DEMONSTRATED BEFORE the message arrived: the
 * recipient had read the path, had it in its working set, or had an edit in
 * flight on it. Intent before and absent after is avoidance. No prior intent is
 * `unknown`, and `unknown` is never folded into the numerator.
 */
export const SessionMeshCollisionOutcome = {
  /** Recipient edited the overlapping path while the peer's claim was live. */
  Realized: "realized",
  /** Intent before the message, no concurrent edit after it. */
  Avoided: "avoided",
  /** Edited only once the peer's claim had expired — coordinated, not avoided. */
  Deferred: "deferred",
  /** Overlap existed but the recipient never showed intent; no credit claimed. */
  Unknown: "unknown",
} as const;
export type SessionMeshCollisionOutcome =
  (typeof SessionMeshCollisionOutcome)[keyof typeof SessionMeshCollisionOutcome];

/** Derived from the const object so the two can never drift apart. */
export const SESSION_MESH_COLLISION_OUTCOME = Object.values(
  SessionMeshCollisionOutcome
);

export const sessionMeshCollisionEvidenceValidator = z.object({
  /** The overlapping repository path the peer claimed. */
  path: z.string().trim().min(1).max(1000),
  /** The recipient touched this path BEFORE the message reached it. */
  intentBeforeDelivery: z.boolean(),
  /** The recipient edited it while the peer's claim was still live. */
  editedDuringClaim: z.boolean(),
  /** The recipient edited it only after the claim lapsed. */
  editedAfterClaim: z.boolean(),
});
export type SessionMeshCollisionEvidence = z.infer<
  typeof sessionMeshCollisionEvidenceValidator
>;

/**
 * Classify one detected collision from its evidence.
 *
 * Ordered deliberately: a concurrent edit is `realized` whatever else is true,
 * because the product's claim is that it prevents exactly that. Reading the
 * branches in any other order lets a realized collision be scored as deferred.
 */
export function classifySessionMeshCollision(
  evidence: SessionMeshCollisionEvidence
): SessionMeshCollisionOutcome {
  if (evidence.editedDuringClaim) {
    return SessionMeshCollisionOutcome.Realized;
  }
  if (!evidence.intentBeforeDelivery) {
    return SessionMeshCollisionOutcome.Unknown;
  }
  if (evidence.editedAfterClaim) {
    return SessionMeshCollisionOutcome.Deferred;
  }
  return SessionMeshCollisionOutcome.Avoided;
}

export const sessionMeshCollisionTotalsValidator = z.object({
  detected: z.number().int().nonnegative(),
  realized: z.number().int().nonnegative(),
  avoided: z.number().int().nonnegative(),
  deferred: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
});
export type SessionMeshCollisionTotals = z.infer<
  typeof sessionMeshCollisionTotalsValidator
>;

/**
 * The hit rate on collisions where intent was actually demonstrated:
 * `avoided / (avoided + realized)`.
 *
 * `deferred` and `unknown` are excluded from BOTH sides on purpose. A deferred
 * edit is coordination rather than avoidance and belongs in its own column; an
 * unknown has no demonstrated intent, so it can neither succeed nor fail.
 * Returns `null` — never 0 — when no collision carried demonstrated intent,
 * because "nothing to judge" is not "the product worked 0% of the time".
 */
export function sessionMeshAvoidanceRate(
  totals: SessionMeshCollisionTotals
): number | null {
  const judged = totals.avoided + totals.realized;
  if (!(Number.isFinite(judged) && judged > 0)) {
    return null;
  }
  const rate = totals.avoided / judged;
  return Number.isFinite(rate) ? rate : null;
}
