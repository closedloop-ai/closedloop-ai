// ISS-8427: the session→branch link projection in its PLURAL form — every
// branch the session touched, for `AgentSessionDetail.branches`.

import type { SessionBranch } from "@repo/api/src/types/agent-session";
import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  deriveBranchParticipationFromMetadata,
  parseSessionPrLinkMetadata,
} from "@repo/api/src/types/session-artifact-link";
import { declaresSessionBranchLinkKind } from "@repo/api/src/types/session-pr-link-metadata";
import { normalizeNullableString } from "./coercion";
import type { AgentSessionListRecord } from "./records";
import {
  resolveAuthoredPrLinkIdentity,
  type SourceLinkRecord,
} from "./session-pr-status";

/**
 * Whether this link states that the session TOUCHED the branch it targets: a
 * `session_branch` link (which carries a `branchParticipation`) or an AUTHORED
 * PR link. A PR the session merely referenced or reviewed authored no branch.
 *
 * Exported and consumed by `deriveTouchedBranchLink` in `projections.ts` as
 * well, so the scalar and plural derivations cannot drift on what "touched"
 * means — the contract on `AgentSessionDetail.branches` depends on the two
 * agreeing, and nothing else pins them together.
 */
export function statesBranchTouch(link: SourceLinkRecord): boolean {
  return (
    link.branchParticipation != null ||
    resolveAuthoredPrLinkIdentity(link) !== null
  );
}

/**
 * The pre-column case {@link statesBranchTouch} cannot see.
 * `branch_participation` was added by migration 20260723021001 with NO backfill,
 * so every session→branch link written before it — and never re-synced — carries
 * a NULL column while its METADATA still states the participation. Such a link
 * is not an authored-PR link either, so it fails both of the scalar's lanes and
 * would be dropped from a field whose contract says EVERY branch.
 *
 * Deliberately narrowed to links that DECLARE a session→branch kind. The
 * metadata rule maps a `Reviewed` relation to a participation, so applying it to
 * every PR link as well would admit the merely-reviewed PR that both derivations
 * exclude on purpose — widening the set past the legacy rows this exists to
 * recover.
 *
 * The declaration is read through {@link declaresSessionBranchLinkKind}, which
 * checks BOTH markers. A link that carried both roles — the branch link that was
 * also the session's PR link — persists as `linkKind: session_pr` with
 * `session_branch` in `linkKinds`, so the top-level scalar alone would reject a
 * link that plainly says it is a branch link, and the pre-column composite rows
 * would stay missing from a field whose contract says EVERY branch. The
 * narrowing is unchanged by that: a merely-reviewed PR link declares no branch
 * kind in either marker, so it is still refused here.
 */
function statesLegacyBranchTouch(link: SourceLinkRecord): boolean {
  const metadata = parseSessionPrLinkMetadata(link.metadata);
  if (!declaresSessionBranchLinkKind(metadata)) {
    return false;
  }
  return deriveBranchParticipationFromMetadata(metadata) !== undefined;
}

/**
 * Every BRANCH the session genuinely TOUCHED, in the `createdAt asc` order of
 * the `sourceLinks` scan.
 *
 * The population is the one the single-valued derivations choose FROM, widened
 * only by {@link statesLegacyBranchTouch}: the scalar keeps the last eligible
 * link and drops the rest, which is how a session that pushed five branches
 * served one.
 *
 * Deduplicated by branch artifact id, keeping the earliest link, because a
 * branch reached by both a `session_branch` link and the PR opened from it is
 * one destination and must not render twice.
 *
 * A link whose target resolves no branch NAME is dropped rather than served
 * with an empty label — the same reason `deriveLinkedPrHeadBranch` normalizes
 * before accepting a name.
 */
export function deriveTouchedBranches(
  record: AgentSessionListRecord
): SessionBranch[] {
  const byArtifactId = new Map<string, SessionBranch>();
  for (const link of record.artifact.sourceLinks ?? []) {
    const target = link.target;
    if (!target?.branch || target.type !== ArtifactType.Branch) {
      continue;
    }
    if (!(statesBranchTouch(link) || statesLegacyBranchTouch(link))) {
      continue;
    }
    const name = normalizeNullableString(target.name);
    if (!name || byArtifactId.has(target.id)) {
      continue;
    }
    byArtifactId.set(target.id, { name, branchArtifactId: target.id });
  }
  return [...byArtifactId.values()];
}
