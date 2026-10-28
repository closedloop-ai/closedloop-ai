/**
 * @file derived-projection-promotion.ts
 * @description ISS-8741: the atomic build → validate → promote primitive that a
 * schema or parser change goes through before any last-known-good projection can
 * be retired.
 *
 * THE INVARIANT. The prior projection is never cleared first. A candidate is
 * built and put to its target views' own validators while the known-good copy is
 * still standing, and only a candidate that every target accepts reaches the
 * caller's replacement — which runs as ONE transaction that both writes the new
 * rows and stamps the new known-good revision. Every other outcome (build
 * produced nothing, build threw, a target refused, the replacement threw) leaves
 * the prior projection exactly as it was.
 *
 * A THROWING REPLACEMENT PROPAGATES. The transaction is what makes a failed
 * replacement harmless, so there is nothing for a catch here to protect — and
 * absorbing the throw would take a signal the caller acts on with it.
 *
 * WHAT THE CLAIM BUYS. The candidate marker is written in its OWN transaction
 * BEFORE the build, so it is durable across the whole window in which a
 * replacement is in flight. A process that dies anywhere after the claim leaves
 * the marker set and the known-good stamp untouched — which is a readable
 * statement that the standing projection is still the good one and a replacement
 * was interrupted, rather than an indistinguishable half-state. The replacement
 * itself is transactional, so the interruption cannot also have written half a
 * projection.
 *
 * VALIDITY IS NOT DEFINED HERE. This module holds no required-field list. Each
 * target view supplies its OWN canonical validator (ISS-7708); the substrate only
 * sequences them and reports which one refused. A second list here would be the
 * SSOT drift the gate exists to prevent.
 *
 * The store is OPTIONAL. A caller with no durable marker column still gets the
 * validation gate and the atomic replacement — it just cannot report an
 * interrupted claim afterwards. That is what keeps the substrate usable from an
 * older wiring and from a test double that predates it.
 */

import type { ProjectionTarget } from "./derived-projection-revision.js";

/** How a promotion attempt ended. */
export const DerivedProjectionPromotionOutcome = {
  /** The candidate validated and the replacement committed. */
  Promoted: "promoted",
  /** A target view refused the candidate. Prior projection untouched. */
  CandidateRejected: "candidate_rejected",
  /** The build produced nothing or threw. Prior projection untouched. */
  CandidateBuildFailed: "candidate_build_failed",
} as const;
export type DerivedProjectionPromotionOutcome =
  (typeof DerivedProjectionPromotionOutcome)[keyof typeof DerivedProjectionPromotionOutcome];

/** A target view's verdict on one candidate. */
export type DerivedProjectionValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

/**
 * One target view's canonical validator, adapted for the gate.
 *
 * `validate` must delegate to the validator that view already uses to decide
 * whether a record is renderable. It must not restate that view's requirements.
 */
export type DerivedProjectionValidator<TCandidate> = {
  readonly target: ProjectionTarget;
  readonly validate: (candidate: TCandidate) => DerivedProjectionValidation;
};

/**
 * The durable known-good / candidate marker, as the substrate needs it.
 *
 * `claimCandidate` and `releaseCandidate` each commit on their own; the
 * known-good stamp is NOT here because it must land in the same transaction as
 * the replacement it describes, which only the caller's `promote` can open.
 */
export type DerivedProjectionRevisionStore = {
  claimCandidate(recordKey: string, revision: string): Promise<void>;
  releaseCandidate(recordKey: string): Promise<void>;
};

export type DerivedProjectionPromotionRequest<TCandidate, TResult> = {
  /** Primary key of the record whose projection is being replaced. */
  readonly recordKey: string;
  /**
   * The source revision this candidate is derived at, already formatted. `null`
   * when it could not be computed — the gate still runs, nothing is stamped.
   */
  readonly revision: string | null;
  readonly store?: DerivedProjectionRevisionStore;
  /**
   * Build the candidate. Called AFTER the claim so an interruption during the
   * build is covered by it. Returning `null` (or throwing) is a failed build,
   * not a reason to retire anything.
   */
  readonly buildCandidate: () => TCandidate | null | Promise<TCandidate | null>;
  /** Non-empty: a promotion with no gate at all is not a gated promotion. */
  readonly validators: readonly DerivedProjectionValidator<TCandidate>[];
  /**
   * Replace the projection and stamp `revision` as the new known-good, in ONE
   * transaction. Receives the revision so the stamp cannot land in a later,
   * separately-committed statement.
   */
  readonly promote: (
    candidate: TCandidate,
    revision: string | null
  ) => Promise<TResult>;
  readonly log?: (message: string) => void;
};

export type DerivedProjectionPromotionResult<TResult> = {
  readonly outcome: DerivedProjectionPromotionOutcome;
  /** Present only on {@link DerivedProjectionPromotionOutcome.Promoted}. */
  readonly promoted?: TResult;
  /** The target that refused, on a rejection. */
  readonly rejectedBy?: ProjectionTarget;
  readonly reason?: string;
  readonly error?: unknown;
};

/**
 * Run one gated, atomic projection replacement.
 *
 * Idempotent by construction: every durable write it makes is an unconditional
 * assignment of a value derived from `revision` and the candidate, so replaying
 * the same request converges on the same stored state rather than accumulating.
 */
export async function promoteDerivedProjection<TCandidate, TResult>(
  request: DerivedProjectionPromotionRequest<TCandidate, TResult>
): Promise<DerivedProjectionPromotionResult<TResult>> {
  const { recordKey, revision, store, validators, log } = request;
  if (validators.length === 0) {
    throw new Error(
      `promoteDerivedProjection requires at least one target validator (record ${recordKey})`
    );
  }
  await claimQuietly(store, recordKey, revision, log);
  let candidate: TCandidate | null;
  try {
    candidate = await request.buildCandidate();
  } catch (error) {
    await releaseQuietly(store, recordKey, log);
    return {
      outcome: DerivedProjectionPromotionOutcome.CandidateBuildFailed,
      error,
    };
  }
  if (candidate === null || candidate === undefined) {
    await releaseQuietly(store, recordKey, log);
    return { outcome: DerivedProjectionPromotionOutcome.CandidateBuildFailed };
  }
  const refusal = firstRefusal(validators, candidate);
  if (refusal) {
    await releaseQuietly(store, recordKey, log);
    return {
      outcome: DerivedProjectionPromotionOutcome.CandidateRejected,
      rejectedBy: refusal.target,
      reason: refusal.reason,
    };
  }
  // NOT wrapped in a catch, deliberately. What protects the prior projection
  // from a failed replacement is the replacement's own transaction, not a catch
  // here — and swallowing the throw would strip a signal the caller acts on: a
  // `DbHostExitError` raised in here is what makes post-boot maintenance re-drive
  // the abandoned rebuild (ISS-5808), and a substrate that absorbed it would
  // silently retire that recovery. The claim marker is left standing on the way
  // out, as the record that a replacement was attempted and did not land.
  const promoted = await request.promote(candidate, revision);
  return {
    outcome: DerivedProjectionPromotionOutcome.Promoted,
    promoted,
  };
}

/** The first target that refuses `candidate`, or `null` when all accept. */
function firstRefusal<TCandidate>(
  validators: readonly DerivedProjectionValidator<TCandidate>[],
  candidate: TCandidate
): { target: ProjectionTarget; reason: string } | null {
  for (const validator of validators) {
    const verdict = validator.validate(candidate);
    if (!verdict.valid) {
      return { target: validator.target, reason: verdict.reason };
    }
  }
  return null;
}

/**
 * Claim, tolerating a store that cannot. A marker the substrate failed to write
 * costs a diagnostic, never the replacement: the gate and the transactional
 * promote are what protect the prior projection, and both still run.
 */
async function claimQuietly(
  store: DerivedProjectionRevisionStore | undefined,
  recordKey: string,
  revision: string | null,
  log: ((message: string) => void) | undefined
): Promise<void> {
  if (!(store && revision)) {
    return;
  }
  try {
    await store.claimCandidate(recordKey, revision);
  } catch (error) {
    log?.(
      `derived-projection claim failed for ${recordKey}: ${describeError(error)}`
    );
  }
}

/** Release, tolerating a store that cannot — see {@link claimQuietly}. */
async function releaseQuietly(
  store: DerivedProjectionRevisionStore | undefined,
  recordKey: string,
  log: ((message: string) => void) | undefined
): Promise<void> {
  if (!store) {
    return;
  }
  try {
    await store.releaseCandidate(recordKey);
  } catch (error) {
    log?.(
      `derived-projection release failed for ${recordKey}: ${describeError(error)}`
    );
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
