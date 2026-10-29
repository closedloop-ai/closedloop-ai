import { z } from "zod";
import type { DesktopFeatureFlagAssignment } from "./desktop-feature-flags.ts";
import { FeatureAssignmentDelivery } from "./feature-assignment-delivery.ts";

/**
 * ISS-8372 — the boundary read every surface performs on a feature assignment
 * that has crossed a process, a wire, or a structured clone.
 *
 * TOLERANT, NOT `.strict()`. This payload crosses a deploy boundary: an already
 * installed Desktop build and a newer API will not upgrade together, so an
 * additive optional field the receiver has never heard of MUST NOT reject the
 * whole assignment. `.strict()` here would drop the entire unit — and re-drop it
 * on every retry — closing every gate for a user whose only offence is running
 * yesterday's build. Zod's default strip keeps the assignment and discards the
 * unknown key, which is the degrade-gracefully direction the repo's version-skew
 * rule asks for.
 */
const assignmentShape = {
  userId: z.string(),
  resolved: z.boolean(),
  // A non-boolean verdict is rejected rather than coerced: an unparseable
  // assignment is UNKNOWN, and unknown is closed.
  flags: z.record(z.string(), z.boolean()),
  // ISS-12552: a marker this build cannot read is no marker, which the reader
  // treats as no organization answer; it never drops the rest of the flags.
  organizationEvaluated: z.array(z.string()).optional().catch(undefined),
  // Compile-time keys-covered guard. A field added to the assignment type fails
  // `tsc` HERE, rather than silently arriving unvalidated at a boundary whose
  // producer-side tests never exercise this schema at all.
} satisfies Record<keyof DesktopFeatureFlagAssignment, z.ZodTypeAny>;

const featureAssignmentSchema = z.object(assignmentShape);

export type FeatureAssignmentRead = {
  readonly delivery: FeatureAssignmentDelivery;
  /**
   * The per-key verdict, and ONLY when `delivery` is
   * {@link FeatureAssignmentDelivery.Assigned}. Every other delivery yields an
   * empty record, so a caller cannot read a verdict out of a non-answer.
   */
  readonly flags: Readonly<Record<string, boolean>>;
  /** ISS-12552: present only on an assigned read whose payload carried it. */
  readonly organizationEvaluated?: readonly string[];
};

const NO_FLAGS: Readonly<Record<string, boolean>> = Object.freeze({});

/**
 * Classify a payload that arrived over a boundary for `subject`.
 *
 * Four of the six fail-closed inputs are decided here — malformed, identity
 * mismatch, evaluation failure, and the absent payload a failed transport
 * produces. Timeout, offline, and missing-bridge are transport facts the caller
 * knows and this function never sees.
 *
 * @param subject the account the assignment was REQUESTED for. `null` means
 *   anonymous/pre-auth, where any subject the service evaluated for is
 *   acceptable — there is no account to mismatch against yet.
 */
export function readFeatureAssignment(
  payload: unknown,
  subject: string | null
): FeatureAssignmentRead {
  if (payload === null || payload === undefined) {
    // The transport resolved with nothing. Main already folds its own timeout,
    // transport error, and schema failure into this, so it is an evaluation that
    // did not produce an answer rather than a shape problem.
    return {
      delivery: FeatureAssignmentDelivery.EvaluationFailed,
      flags: NO_FLAGS,
    };
  }

  const parsed = featureAssignmentSchema.safeParse(payload);
  if (!parsed.success) {
    return { delivery: FeatureAssignmentDelivery.Malformed, flags: NO_FLAGS };
  }
  if (subject !== null && parsed.data.userId !== subject) {
    return {
      delivery: FeatureAssignmentDelivery.IdentityMismatch,
      flags: NO_FLAGS,
    };
  }
  if (!parsed.data.resolved) {
    return {
      delivery: FeatureAssignmentDelivery.EvaluationFailed,
      flags: NO_FLAGS,
    };
  }
  return {
    delivery: FeatureAssignmentDelivery.Assigned,
    flags: parsed.data.flags,
    ...(parsed.data.organizationEvaluated
      ? { organizationEvaluated: parsed.data.organizationEvaluated }
      : {}),
  };
}
