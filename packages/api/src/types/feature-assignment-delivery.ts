/**
 * ISS-8372 — HOW a feature assignment reached the surface that is about to act
 * on it, as opposed to what the assignment said.
 *
 * The two are separate because a closed gate and a gate that could not be read
 * render the same and mean opposite things. Collapsing them is what lets a
 * transport failure be reported as an evaluated "not enrolled", so every
 * non-answer keeps its own member here and the fold in `workspace-experience.ts`
 * maps each to an outcome explicitly.
 *
 * Deliberately transport-agnostic: Web reaches these members from the PostHog
 * browser adapter and Desktop from the API → main → preload → renderer path, and
 * both then call the same fold. That shared vocabulary IS the parity mechanism.
 */
export const FeatureAssignmentDelivery = {
  /** In flight. Not an answer, and must never be rendered as one. */
  Pending: "pending",
  /** A well-formed assignment for the current subject actually arrived. */
  Assigned: "assigned",
  /** The bounded wait for {@link FeatureAssignmentDelivery.Pending} elapsed. */
  Timeout: "timeout",
  /** A payload arrived and failed the boundary schema. */
  Malformed: "malformed",
  /**
   * A payload arrived that was evaluated for a DIFFERENT subject — a reply for
   * the previous account, or the anonymous flag set still standing after
   * sign-in. Stale, therefore not an answer about this subject.
   */
  IdentityMismatch: "identity-mismatch",
  /** No transport at all: the preload bridge is absent on this build. */
  MissingBridge: "missing-bridge",
  /** No network at startup, so no assignment could be requested. */
  Offline: "offline",
  /** The flag service answered, and its answer was "I could not evaluate". */
  EvaluationFailed: "evaluation-failed",
  /**
   * The assignment path is not mounted for this surface — signed out with no
   * identity to evaluate for, or a build whose cutover to the server-evaluated
   * path is still off. Terminal, NOT pending: nothing further will arrive, and a
   * root left pending forever never renders a tree at all.
   */
  Unavailable: "unavailable",
} as const;
export type FeatureAssignmentDelivery =
  (typeof FeatureAssignmentDelivery)[keyof typeof FeatureAssignmentDelivery];
