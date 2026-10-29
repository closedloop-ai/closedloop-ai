/**
 * @file session-projection-gate.ts
 * @description ISS-8741: what the session projection's promotion gate is made
 * of — the source revision a candidate is derived at, and the target views'
 * validators it must satisfy before the standing projection can be retired.
 *
 * THE VALIDATOR IS BORROWED, NOT WRITTEN. `normalizedSessionSchema` is already
 * the contract for a well-formed derived session record: it is `.strict()` over
 * every field `NormalizedSession` can carry, it has a compile-time
 * keys-covered guard so a new field cannot silently fall out of it, and a
 * session that fails it is already dropped at the parse-worker boundary. Reusing
 * it is the ISS-7708 ruling applied literally — the consuming view model's own
 * validator decides validity, and this file adds no required-field list of its
 * own.
 *
 * WHY GATE AGAIN AT PROMOTION when the worker path already validated. The
 * worker is one PRODUCER. `rebuildParseSource` falls back to an in-process
 * `collector.parse` whenever no historical-parse runner is up, and that path
 * never sees the schema at all — so validation at the worker is a property of
 * how the candidate happened to arrive, not of what is about to be committed.
 * The gate belongs at the promotion, where the standing projection is at stake.
 *
 * WHY THE REVISION IS FOUR COMPONENTS. `DATA_REVISION` is the derivation
 * revision, but it is not the only counter that decides what a session's
 * persisted projection looks like: `ACTIVITY_CLASSIFIER_VERSION` and
 * `EXTRACTOR_VERSION` gate two backfills that re-derive parts of it
 * independently, and `AGENT_SESSION_SYNC_SCHEMA_VERSION` is the record schema it
 * is shaped to. All four can move without the others, so all four are named.
 */

import { AGENT_SESSION_SYNC_SCHEMA_VERSION } from "../../agent-sync/agent-session-sync-contract.js";
import type {
  DerivedProjectionValidation,
  DerivedProjectionValidator,
} from "../../database/derived-projection-promotion.js";
import {
  type DerivedProjectionRevisionComponent,
  formatDerivedProjectionRevision,
  ProjectionTarget,
} from "../../database/derived-projection-revision.js";
import { effectiveParsePolicy } from "../../parse-policy/effective-parse-policy.js";
import type { ParsePolicy } from "../../parse-policy/parse-policy.js";
import { ACTIVITY_CLASSIFIER_VERSION } from "../parsing/activity-segment-classifier.js";
import { EXTRACTOR_VERSION } from "../parsing/artifact-ref-extractor-version.js";
import type { NormalizedSession } from "../types.js";
import { dataRevisionFor } from "./data-revision.js";
import { normalizedSessionSchema } from "./historical-parse-worker-session-schema.js";

/** How many Zod issues a rejection reason quotes before it is truncated. */
const MAX_QUOTED_VALIDATION_ISSUES = 3;

/**
 * The four independently-bumped counters that compose a session projection's
 * source revision, in the order they are declared (the formatter sorts, so this
 * order is for readers only).
 */
export function sessionProjectionRevisionComponents(
  parsePolicy: ParsePolicy = effectiveParsePolicy()
): DerivedProjectionRevisionComponent[] {
  return [
    { name: "data", version: dataRevisionFor(parsePolicy) },
    { name: "classifier", version: ACTIVITY_CLASSIFIER_VERSION },
    { name: "extractor", version: EXTRACTOR_VERSION },
    { name: "schema", version: AGENT_SESSION_SYNC_SCHEMA_VERSION },
  ];
}

/**
 * The formatted source revision a session projection built by THIS build is
 * derived at, or `null` if it could not be formatted — in which case the gate
 * still runs and nothing is stamped.
 */
export function currentSessionProjectionRevision(
  parsePolicy: ParsePolicy = effectiveParsePolicy()
): string | null {
  return formatDerivedProjectionRevision(
    sessionProjectionRevisionComponents(parsePolicy)
  );
}

/**
 * The target views a candidate session projection must satisfy.
 *
 * ONE entry today, deliberately. The Branches, owner, and aggregate projections
 * a rebuild can destroy are all re-derived from this same `NormalizedSession`
 * inside the same replacement transaction, and none of them owns a canonical
 * record validator of its own — the desktop read path models their
 * incompleteness as explicit `*Completeness` / `*Availability` states rather
 * than a pass/fail schema. Registering a hand-written schema for each here would
 * be the parallel required-field list ISS-7708 ruled out. The array is the seam:
 * a view that grows its own canonical validator adds one entry naming its
 * {@link ProjectionTarget}, and the gate reports which target refused.
 */
export const SESSION_PROJECTION_VALIDATORS: readonly DerivedProjectionValidator<NormalizedSession>[] =
  [
    {
      target: ProjectionTarget.Sessions,
      validate: validateNormalizedSessionCandidate,
    },
  ];

/**
 * Put a candidate to the canonical derived-session-record schema.
 *
 * Delegation only: the verdict is `normalizedSessionSchema`'s, and the reason
 * string is built from the issues it reports so a rejection names the field that
 * failed rather than an anonymous "invalid".
 */
function validateNormalizedSessionCandidate(
  candidate: NormalizedSession
): DerivedProjectionValidation {
  const parsed = normalizedSessionSchema.safeParse(candidate);
  if (parsed.success) {
    return { valid: true };
  }
  const issues = parsed.error.issues
    .slice(0, MAX_QUOTED_VALIDATION_ISSUES)
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
  const overflow = parsed.error.issues.length - MAX_QUOTED_VALIDATION_ISSUES;
  return {
    valid: false,
    reason: overflow > 0 ? `${issues} (+${overflow} more)` : issues,
  };
}
