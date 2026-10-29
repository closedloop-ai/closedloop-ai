import type { Priority } from "@repo/api/src/types/common";
import {
  ArtifactRefRelation,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import type { SqliteArtifactLinkRow } from "./db-row-types.js";

/**
 * Per-link wire fields `sync-source.ts`'s artifact-ref fold derives from one
 * stored link row. Split out of that grandfathered, shrink-only module by
 * ISS-10332 when the branch ref gained its priority field.
 */

/**
 * Map a stored PR-link `relation` to the wire `SessionPrRelationType` carried on
 * `prRefs` (FEA-3585). `created`→CREATED (authored), `reviewed`→REVIEWED (the
 * session ran a `gh pr` review command on this PR), everything else→REFERENCED
 * (a passive mention). Keeping REFERENCED as the default preserves the prior
 * behaviour for every non-review relation.
 */
export function toSessionPrRelationType(
  relation: string | null
): SessionPrRelationType {
  if (relation === ArtifactRefRelation.Created) {
    return SessionPrRelationType.Created;
  }
  if (relation === ArtifactRefRelation.Reviewed) {
    return SessionPrRelationType.Reviewed;
  }
  return SessionPrRelationType.Referenced;
}

/**
 * Per-link event time (FEA-2729): the tool-use timestamp FEA-2531 Phase B
 * stamps on the link, falling back to the artifact's scan-time observations.
 */
export function resolveLinkObservedAt(
  link: SqliteArtifactLinkRow
): string | undefined {
  return (
    link.link_observed_at ??
    link.artifact_observed_at ??
    link.artifact_last_seen_at ??
    undefined
  );
}

/**
 * ISS-10332: the branch ref's `priority`, present only when one is set. The
 * cloud reads an absent field as "no claim" and seeds its branch only while it
 * holds none, so "no priority" is never sent.
 */
export function branchRefPriorityField(priority: Priority | null): {
  priority?: Priority;
} {
  return priority ? { priority } : {};
}
