/**
 * @file write-core-import-phases-links.ts
 * @description Record groups 6-7.75: linkage materialized from parsed refs — artifact links,
 * pull requests, segment work-item refs, and component invocations. Ordering
 * between these groups is load-bearing; see each phase.
 */
import { extractWorkItemOccurrences } from "../collectors/parsing/work-item-occurrences.js";
import { persistArtifactLinks } from "./artifact-link-persistence.js";
import { materializeAgentComponentInvocations } from "./component-invocations.js";
import type { Prisma } from "./generated/client.js";
import type { ImportSessionContext } from "./import-session-context.js";
import {
  COMMIT_SHA_CORRELATION_METHOD,
  NORMALIZED_PR_LINK_METHOD,
} from "./pr-link-maintenance.js";
import { stampSegmentWorkItemRefs } from "./segment-work-item-stamp.js";
import { persistNormalizedPullRequests } from "./write-core-pull-requests.js";

/**
 * Record group 6: artifact links. Delete-then-reinsert the session↔artifact
 * join rows for consistency with the backfill path.
 *
 * FEA-4379: the delete PRESERVES `commit_sha_correlation` links. That method is
 * minted ONLY by the removed post-boot correlation pass — the parser/import path
 * never re-derives it — so an unconditional delete would drop an already-minted
 * session→PR link on every live re-import with nothing to restore it.
 *
 * ISS-8905: the delete ALSO preserves `normalized_pr`. That slice belongs to the
 * pull-requests phase, which tears it down and rebuilds it inside its OWN
 * transaction (`importPhasePullRequests`). Deleting it here instead put the
 * change in one tolerant transaction group and the fingerprint comparison plus
 * watermark bump that describe it in a LATER one: a failed pull-requests group
 * left the rows durably gone with no bump, and when the deletion was itself the
 * correct final state the next pass inherited an already-emptied slice, observed
 * no change, and the cloud kept the retired link forever.
 *
 * ISS-4651: the other maintenance/import methods do NOT all come back the same
 * way, and this comment used to lump them together as re-created "by the parser
 * refs or the PR phase that runs after this one". The parser refs mint none of
 * them. What actually holds, per method:
 *   - `branch_pr_association` — re-created by `propagateBranchPrLinks`, which
 *     runs INSIDE `persistArtifactLinks` below (earlier in this phase, same
 *     transaction), not by anything that runs after it. The re-mint is
 *     CONDITIONAL and deliberately narrower than "whatever was there before":
 *     it needs the session to still hold FEA-4377 authoring evidence for a
 *     branch and a `pull_requests` row mapping that branch to the PR. So the
 *     delete is not merely harmless here — a session that lost its authoring evidence SHOULD lose
 *     the association, and re-deriving through the gate is what enforces it.
 *
 *   - `pull_requests_fold` — has NO producer anywhere in the tree; its only
 *     minter was the FEA-1899 Postgres migration, deleted in the pglite→SQLite
 *     squash to `0001_init`. Nothing writes it, so nothing needs to rebuild it.
 */
export async function importPhaseArtifactLinks(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<{ capturedArtifactLinks: number }> {
  const { session, now, linkedArtifactRefs, log } = ctx;
  await tx.$executeRawUnsafe(
    "DELETE FROM session_artifact_links WHERE session_id = $1 AND method NOT IN ($2, $3)",
    session.sessionId,
    COMMIT_SHA_CORRELATION_METHOD,
    NORMALIZED_PR_LINK_METHOD
  );
  // The live import re-runs on every real import, so the seen-guard's
  // unresolved-bare-repo deferral (FEA-2875) is a backfill-only concern; here we
  // only need the captured count.
  const { captured: capturedArtifactLinks } = await persistArtifactLinks(
    tx,
    session.sessionId,
    linkedArtifactRefs,
    now,
    log
  );
  return { capturedArtifactLinks };
}

/**
 * Record group 7: pull requests. MUST still run after the artifact-links phase:
 * `persistNormalizedPullRequests` mints its conservative `referenced` link only
 * `WHERE NOT EXISTS` a link for the same (session, artifact), so the extractor —
 * which owns the created-vs-referenced distinction — has to have written first.
 *
 * ISS-8905: this phase now DELETEs its own `normalized_pr` slice, in the same
 * transaction as the rebuild, instead of relying on the artifact-links phase to
 * clear it. Delete and restore are therefore all-or-nothing, so the change and
 * the fingerprint/watermark bump that describes it can never end up in different
 * transactions — the failure that let a retired PR link survive in the cloud
 * indefinitely (and that ISS-8758's compensating bump could only paper over).
 *
 * The teardown is UNCONDITIONAL and lives here rather than inside
 * `persistNormalizedPullRequests`, which returns early when the session carries
 * no PRs: retirement — the session that HAD a PR link and no longer derives one
 * — is exactly the case that must still clear the slice.
 *
 * The DELETE runs AFTER `persistArtifactLinks` (previous phase) rather than
 * before it, so a stale `normalized_pr` row is briefly visible while the
 * extractor writes. That is safe in both directions: an extractor ref for the
 * same (session, artifact, relation) upserts over it (`LINK_UPSERT_CONFLICT` sets
 * `method = EXCLUDED.method`, so the row leaves this slice rather than colliding),
 * and any stale row the extractor did not claim is gone before the
 * `WHERE NOT EXISTS` mint below reads the table — which is the same state that
 * predicate saw when the artifact-links phase did the deleting.
 */
export async function importPhasePullRequests(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<{ capturedPullRequests: number }> {
  const { session, harness, now, createdPrHeadBranches, pullRequestPreserved } =
    ctx;
  await tx.$executeRawUnsafe(
    "DELETE FROM session_artifact_links WHERE session_id = $1 AND method = $2",
    session.sessionId,
    NORMALIZED_PR_LINK_METHOD
  );
  const capturedPullRequests = await persistNormalizedPullRequests(
    tx,
    session,
    harness,
    now,
    createdPrHeadBranches,
    pullRequestPreserved
  );
  return { capturedPullRequests };
}

/**
 * Record group 7.5: optional work-item linkage (FEA-2272). Runs AFTER both the
 * artifact-links and pull-requests phases so every candidate link exists, and
 * before the derived rollups. A tolerant group in the isolated path: a failure
 * leaves the segments intact and only the optional column unset.
 */
export async function importPhaseSegmentWorkItemRefs(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<void> {
  await stampSegmentWorkItemRefs(
    tx,
    ctx.session.sessionId,
    extractWorkItemOccurrences(ctx.session)
  );
}

/**
 * Record group 7.75: replace the durable per-runtime-invocation source of
 * truth. Events and parser-owned agent rows already exist, while every derived
 * aggregate still follows this phase.
 */
export async function importPhaseComponentInvocations(
  tx: Prisma.TransactionClient,
  ctx: ImportSessionContext
): Promise<{ invocationSetChanged: boolean }> {
  return await materializeAgentComponentInvocations(
    tx,
    ctx.session,
    ctx.mainId,
    ctx.now,
    ctx.harness,
    ctx.log,
    ctx.parsePolicy
  );
}
