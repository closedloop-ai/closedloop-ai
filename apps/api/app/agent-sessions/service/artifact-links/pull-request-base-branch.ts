/**
 * @file pull-request-base-branch.ts
 * @description ISS-8175 — what a desktop-synced `pull_request` ref may say about
 * a base branch, and how that reaches `BranchDetail`.
 *
 * Its own module rather than more of `pull-request-details.ts`: that file is
 * ~880 lines against the 1,000 ceiling and owns the PullRequestDetail
 * identity/ownership matrix; this is a distinct responsibility (which evidence
 * may originate a base, and the precedence write it feeds).
 */
import { BranchBaseBranchSource } from "@repo/api/src/types/artifact";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  type SyncedPullRequestArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import {
  parseBranchBaseBranchSource,
  resolveBaseProvenance,
} from "@/app/branches/branch-state-transitions";
import type { AgentSessionUpsertTx } from "../records";

/**
 * The base ref a `pull_request` ref may originate, or `undefined`.
 *
 * The sync payload is entirely CLIENT-supplied — `relation` and `method` are
 * fields on it, not server facts — so without this gate any ref could carry a
 * `baseRef` and buy `DesktopPullRequestBase`, the one rank deliberately withheld
 * from clients by `isClientAssertableBaseBranchSource`. Only the shape the
 * desktop extractor emits for a PR it OPENED (`artifact-ref-extractor.ts`:
 * `relation: "created"`, `method: "pr_create_output"`) originates one; every
 * other shape degrades to absent, which is the same honest unknown a desktop
 * that predates the field produces.
 *
 * A shape check, not authentication: a payload can still claim the create shape.
 * What it buys is that the rank is reachable only through the evidence the
 * feature is defined on, so a `referenced` mention cannot re-point a branch.
 */
export function createdPullRequestBaseRef(
  ref: SyncedPullRequestArtifactRef
): string | undefined {
  if (
    ref.relation !== ArtifactRefRelation.Created ||
    ref.method !== ArtifactRefMethod.PrCreateOutput
  ) {
    return undefined;
  }
  return ref.baseRef;
}

/**
 * Stamp the branch's own base from the PR the desktop opened, through the SAME
 * precedence decider (`resolveBaseProvenance`) the webhook and MCP writers use,
 * so a weaker source can never overwrite a stronger stored one.
 *
 * Gated on the PR being the branch's CURRENT one, read in the same query as the
 * stored provenance: a superseded PR's base must never re-point the branch.
 * That gate lives here rather than at each call site because the not-owned
 * gap-fill paths (a webhook-owned row, an out-of-order desktop ref) reach it
 * without the `promoteBranchCurrentPullRequest` result the owned path has.
 */
export async function applyDesktopPullRequestBaseBranch(
  tx: AgentSessionUpsertTx,
  input: {
    organizationId: string;
    branchArtifactId: string;
    pullRequestDetailId: string;
    baseRef: string;
  }
): Promise<void> {
  const { organizationId, branchArtifactId, pullRequestDetailId, baseRef } =
    input;
  const existing = await tx.branchDetail.findFirst({
    where: { artifactId: branchArtifactId, organizationId },
    select: {
      baseBranch: true,
      baseBranchSource: true,
      currentPullRequestDetailId: true,
    },
  });
  if (existing?.currentPullRequestDetailId !== pullRequestDetailId) {
    return;
  }
  const resolved = resolveBaseProvenance(
    {
      baseBranch: baseRef,
      baseBranchSource: BranchBaseBranchSource.DesktopPullRequestBase,
    },
    {
      baseBranch: existing.baseBranch,
      baseBranchSource: parseBranchBaseBranchSource(existing.baseBranchSource),
    }
  );
  if (
    resolved.baseBranchSource !== BranchBaseBranchSource.DesktopPullRequestBase
  ) {
    return;
  }
  // The decider lets an equal-ranked input win, so an unchanged base would
  // otherwise re-write itself on every tick — and the same PR's base rides every
  // session that references it, not just the one that opened it.
  if (
    existing.baseBranch === resolved.baseBranch &&
    existing.baseBranchSource === resolved.baseBranchSource
  ) {
    return;
  }
  // Compare-and-swap on EVERY value the decision above was read from — the same
  // pattern `promoteBranchCurrentPullRequest` uses one file over. This sync runs
  // at READ COMMITTED, so between that `findFirst` and this write another
  // producer can promote a newer PR onto the branch (stamping this decision's
  // base onto a PR it was never about) or land a stronger base (silently
  // downgrading it). Pinning the three read values makes the write land only on
  // the row the decision was made against. A zero count means the row moved
  // under us: the other writer's value is the current one and stands, so this is
  // a no-op, not an error.
  await tx.branchDetail.updateMany({
    where: {
      artifactId: branchArtifactId,
      organizationId,
      currentPullRequestDetailId: pullRequestDetailId,
      baseBranch: existing.baseBranch,
      baseBranchSource: existing.baseBranchSource,
    },
    data: {
      baseBranch: resolved.baseBranch,
      baseBranchSource: resolved.baseBranchSource,
    },
  });
}

/**
 * Fill an ABSENT `PullRequestDetail.baseRefName` and nothing else, for the paths
 * that must not otherwise write the row: an out-of-order desktop ref whose
 * observation predates the stored one.
 *
 * The ISS-8175 base recovery re-derives a base from a session's own `gh` output
 * and keeps that PR's ORIGINAL create timestamp, so on a machine whose PR
 * another device already synced later, the monotonic guard would skip the write
 * and the recovered base would stay unknown forever. Filling only a
 * null column leaves every lifecycle fact and the freshness stamps at the
 * fresher observation's values — a gap-fill, not a regression.
 *
 * `baseRefName: null` in the `where` makes it fill-only in the database rather
 * than in a read-then-write, so a concurrent producer's value is never clobbered
 * and the returned flag reports what this call actually filled.
 */
export async function fillMissingPullRequestBaseRef(
  tx: AgentSessionUpsertTx,
  input: {
    organizationId: string;
    pullRequestDetailId: string;
    baseRef: string;
  }
): Promise<boolean> {
  const filled = await tx.pullRequestDetail.updateMany({
    where: {
      id: input.pullRequestDetailId,
      organizationId: input.organizationId,
      baseRefName: null,
    },
    data: { baseRefName: input.baseRef },
  });
  return filled.count === 1;
}
