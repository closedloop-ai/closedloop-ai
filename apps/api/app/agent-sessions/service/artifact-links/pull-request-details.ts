import { BranchPushSource } from "@repo/api/src/types/artifact";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import type {
  SyncedArtifactRef,
  SyncedPullRequestArtifactRef,
  SyncedSessionPrRef,
} from "@repo/api/src/types/session-artifact-link";
import { isValidPullRequestNumber } from "@repo/api/src/types/session-artifact-link";
import type { Prisma } from "@repo/database";
import {
  bumpBranchActivity,
  stampBranchFirstPush,
} from "@/app/branches/branch-push-state";
import { promoteBranchCurrentPullRequest } from "@/app/branches/pull-request-current-promotion";
import { isProviderAuthoritativePullRequest } from "@/app/branches/pull-request-provider-authority";
import { chunksOf } from "@/lib/chunks-of";
import {
  type DesktopPullRequestDetailData,
  desktopFreshnessStamps,
} from "@/lib/desktop-pull-request-facts";
import {
  desktopSyncFetchProvenance,
  gitHubFetchProvenanceData,
} from "@/lib/github-fetch-provenance";
import type { AgentSessionUpsertTx } from "../records";
import { bindParameterChunkSize } from "../write-chunking";
import {
  type BranchMaterializationResult,
  BranchMaterializationStatus,
  ensureBranchArtifactRow,
} from "./branch-links";
import {
  enqueueBranchMaterializationRetriesTx,
  isRetryableBranchMaterializationCause,
} from "./branch-materialization-retry";
import {
  type BranchRefAggregate,
  branchRefAggregateKey,
  mergeBranchRefAggregates,
} from "./branch-ref-aggregate";
import type { UnresolvedPrRef } from "./pr-links";
import {
  applyDesktopPullRequestBaseBranch,
  fillMissingPullRequestBaseRef,
} from "./pull-request-base-branch";
import {
  branchAggregateFromPrRef,
  pullRequestRefCarriesHeadBranchName,
} from "./pull-request-branch-association";
import { pullRequestRefDetailData } from "./pull-request-detail-data";
import {
  type ExistingDesktopPrRow,
  findDesktopPrRow,
} from "./pull-request-detail-reads";
import {
  PullRequestLaneDeferral,
  type SessionPullRequestLaneDeferralMap,
} from "./pull-request-lane-deferral";
import { acquireSessionPullRequestProviderLocks } from "./session-pull-request-provider-locks";
import {
  collectProviderVerifiablePullRequestRefs,
  resolveRepoIdsByFullName,
  type SessionBranchRepositoryAuthority,
  type SessionBranchRepositoryAuthorityMap,
  storeUnresolvedRefs,
} from "./shared";

/**
 * Collapse a session's PR refs to one per `(normalized repo, number)`, keeping
 * the latest observation's facts and carrying a `branchName` from any ref that
 * has one (identity is stable across a session's refs; a later `gh` observation
 * just refreshes the facts).
 */
function aggregatePullRequestArtifactRefs(
  refs: SyncedPullRequestArtifactRef[]
): SyncedPullRequestArtifactRef[] {
  const byKey = new Map<string, SyncedPullRequestArtifactRef>();
  for (const ref of refs) {
    const key = sessionPullRequestDetailKey(
      ref.repositoryFullName,
      ref.prNumber
    );
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, ref);
      continue;
    }
    const existingAt = existing.observedAt
      ? Date.parse(existing.observedAt)
      : 0;
    const incomingAt = ref.observedAt ? Date.parse(ref.observedAt) : 0;
    const winner = incomingAt >= existingAt ? ref : existing;
    const branchName =
      winner.branchName ?? existing.branchName ?? ref.branchName;
    byKey.set(key, branchName ? { ...winner, branchName } : winner);
  }
  return [...byKey.values()];
}

/**
 * PRD-510 FR2 / PLN-1099 Phase 2: advance the branch lifecycle from a
 * desktop-observed PR through the SAME decider/writers the webhook uses. Called
 * only when the desktop PR is the branch's current PR (non-App repos, or App
 * repos the webhook has not yet delivered) — so webhook-wins is preserved.
 */
async function advanceBranchLifecycleFromPullRequest(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  branchArtifactId: string,
  ref: SyncedPullRequestArtifactRef,
  pullRequestDetailId: string,
  baseRef: string | undefined
): Promise<void> {
  // A synced PR means its head branch reached the remote — push evidence
  // (set-once, earliest-wins). observedAt is the earliest PR signal we hold; the
  // branch lane's push-method ref usually stamps an equal-or-earlier value, so
  // this never regresses firstPushedAt.
  if (ref.observedAt) {
    await stampBranchFirstPush(
      tx,
      branchArtifactId,
      new Date(ref.observedAt),
      BranchPushSource.Session
    );
  }
  if (ref.state) {
    // With only a PR state supplied, decideBranchStatus returns that state
    // verbatim — so set it directly (branch-service owns the delete/merge
    // derivations the desktop lane has no inputs for). Keeps the branch Artifact
    // status advancing OPEN → MERGED/CLOSED exactly as the webhook path does.
    //
    // Two guards keep this blind write from regressing state:
    //   1. Out-of-order desktop observations never reach here — the `observedAt`
    //      monotonic check in `writeDesktopPullRequestDetailRow` returns
    //      `desktopOwnsRow=false` for a stale ref, short-circuiting this call.
    //   2. The `status: { not: MERGED }` predicate below: MERGED is terminal
    //      (a PR cannot un-merge), so we never downgrade it. This also closes the
    //      narrow same-tx race where a webhook advances the branch to MERGED
    //      after our PR-row read but before this write — the update no-ops
    //      instead of downgrading MERGED → OPEN.
    // Any new caller MUST preserve guard (1) before writing status here.
    await tx.artifact.updateMany({
      where: {
        id: branchArtifactId,
        organizationId,
        status: { not: GitHubPRState.Merged },
      },
      data: { status: ref.state },
    });
  }
  if (baseRef) {
    await applyDesktopPullRequestBaseBranch(tx, {
      organizationId,
      branchArtifactId,
      pullRequestDetailId,
      baseRef,
    });
  }
  const activityAt = ref.mergedAt ?? ref.closedAt ?? ref.observedAt ?? null;
  await bumpBranchActivity(
    tx,
    branchArtifactId,
    activityAt ? new Date(activityAt) : null
  );
}

function buildWebhookPrGapFill(
  existing: ExistingDesktopPrRow,
  facts: DesktopPullRequestDetailData,
  repositoryFullName: string
): Prisma.PullRequestDetailUncheckedUpdateInput {
  const gap: Prisma.PullRequestDetailUncheckedUpdateInput = {};
  if (existing.title == null && facts.title !== undefined) {
    gap.title = facts.title;
  }
  if (existing.htmlUrl == null && facts.htmlUrl !== undefined) {
    gap.htmlUrl = facts.htmlUrl;
  }
  if (existing.additions == null && facts.additions !== undefined) {
    gap.additions = facts.additions;
  }
  if (existing.deletions == null && facts.deletions !== undefined) {
    gap.deletions = facts.deletions;
  }
  if (existing.changedFiles == null && facts.changedFiles !== undefined) {
    gap.changedFiles = facts.changedFiles;
  }
  if (existing.baseRefName == null && facts.baseRefName !== undefined) {
    gap.baseRefName = facts.baseRefName;
  }
  if (existing.repositoryFullName == null) {
    gap.repositoryFullName = repositoryFullName;
  }
  return gap;
}

async function writeDesktopPullRequestDetailRow(
  tx: AgentSessionUpsertTx,
  input: {
    organizationId: string;
    branchArtifactId: string;
    repositoryId: string | null;
    repositoryFullName: string;
    ref: SyncedPullRequestArtifactRef;
    existing: ExistingDesktopPrRow | null;
    facts: DesktopPullRequestDetailData;
    provenance: ReturnType<typeof gitHubFetchProvenanceData>;
  }
): Promise<
  SessionPullRequestDetailRef & {
    desktopOwnsRow: boolean;
    baseGapFilled: boolean;
  }
> {
  const {
    organizationId,
    branchArtifactId,
    repositoryId,
    repositoryFullName,
    ref,
    facts,
    provenance,
  } = input;

  // The freshness stamps (`lastVerifiedAt`, `lastRefreshAttemptAt`) must reflect
  // when the fact was TRUE (the desktop's observation time), not server-receipt
  // time. Otherwise a days-late sync would stamp the row as freshly attempted,
  // so the reconciler's attempt debounce (`last_refresh_attempt_at <
  // staleBefore`) keeps it out of the next pass.
  const observedAt = ref.observedAt ? new Date(ref.observedAt) : new Date();

  const existing = input.existing;

  // Leave-attached (FEA-3917 OQ1, desktop-scoped): a row that belongs to a
  // DIFFERENT branch artifact is reconciled by DEDUP ONLY — the identity lookup
  // found it, so we neither collide on create nor mutate it. This check runs
  // BEFORE the webhook gap-fill and every other mutation below, so a cross-branch
  // sync can never change the row it only means to dedupe (App-owned rows would
  // otherwise be gap-filled here). Freshening a cross-branch row's facts or
  // freshness stamps while withholding its branch-lifecycle advance
  // (desktopOwnsRow=false makes upsertDesktopPullRequestDetail return before
  // advanceBranchLifecycleFromPullRequest) would leave that branch's PR row
  // terminal-but-unadvanced (e.g. prState=MERGED, Artifact.status still OPEN).
  // The owning branch's own syncs, or the webhook, own that row's facts and
  // lifecycle.
  if (existing && existing.branchArtifactId !== branchArtifactId) {
    return {
      prDetailId: existing.id,
      branchArtifactId: existing.branchArtifactId,
      desktopOwnsRow: false,
      baseGapFilled: false,
    };
  }

  // Webhook-wins. ISS-8522 moved the "is this row App/webhook-owned" judgment
  // into one row-level predicate so this gate and the derivation cannot drift.
  if (existing && isProviderAuthoritativePullRequest(existing)) {
    const gap = await persistWebhookPrGapFill(
      tx,
      organizationId,
      existing,
      facts,
      repositoryFullName
    );
    return {
      prDetailId: existing.id,
      branchArtifactId: existing.branchArtifactId,
      desktopOwnsRow: false,
      baseGapFilled: gap.baseRefName !== undefined,
    };
  }

  if (existing) {
    // Monotonic guard: an out-of-order desktop sync (two compute targets, a
    // delayed retry) whose observation predates the stored one must not regress
    // PR facts or the branch lifecycle it feeds. Skip the overwrite AND the
    // downstream advance (desktopOwnsRow=false), mirroring the earliest-wins /
    // GREATEST guards the branch push-state writers already use.
    if (
      existing.fetchObservedAt &&
      observedAt.getTime() < existing.fetchObservedAt.getTime()
    ) {
      // ISS-8175: the ONE fact a stale ref may still contribute. The base
      // recovery keeps the PR's original create timestamp, so a PR another
      // device already synced later would otherwise never learn the base its
      // opening session just recovered. No lifecycle
      // fact and no freshness stamp is refreshed from the older observation.
      // Fill-only lives entirely in that helper's `baseRefName: null` predicate
      // — not also in a read of `existing.baseRefName` here, which would be a
      // second copy of the rule that no test can tell apart from the first.
      const baseGapFilled =
        facts.baseRefName === undefined
          ? false
          : await fillMissingPullRequestBaseRef(tx, {
              organizationId,
              pullRequestDetailId: existing.id,
              baseRef: facts.baseRefName,
            });
      return {
        prDetailId: existing.id,
        branchArtifactId: existing.branchArtifactId,
        desktopOwnsRow: false,
        baseGapFilled,
      };
    }
    // Same-branch desktop-authored (or not-yet-webhook): apply the known facts
    // (absent facts are omitted so a partial sync can't clobber a fuller prior
    // one), backfill repositoryId if newly resolved, refresh provenance. In the
    // narrow race where a peer producer created the App row for `(repositoryId,
    // number)` between our lookup and this write, filling repositoryId here can
    // still P2002 (an in-place UPDATE has no skip-duplicates form like the
    // conflict-safe insert below) — we let it propagate (batch rollback + a
    // self-healing re-sync), never a catch-and-recover inside the aborted tx.
    const updated = await tx.pullRequestDetail.updateMany({
      where: { id: existing.id, organizationId },
      data: {
        ...facts,
        repositoryFullName: existing.repositoryFullName ?? repositoryFullName,
        ...(repositoryId && existing.repositoryId == null
          ? { repositoryId }
          : {}),
        ...provenance,
        // ISS-8462: durable origin, unlike the provenance above, which a later
        // reconcile overwrites. Set on the update too, not only the insert: the
        // desktop reaches here for any row it owns, including one created
        // before this column existed. Only ever set true.
        desktopOriginated: true,
        ...desktopFreshnessStamps(facts, observedAt),
      },
    });
    if (updated.count !== 1) {
      throw new Error("desktop PR owner changed");
    }
    // The row is nested under the branch we're syncing (cross-branch rows returned
    // above), so the desktop may point this branch at it and advance its lifecycle.
    return {
      prDetailId: existing.id,
      branchArtifactId: existing.branchArtifactId,
      desktopOwnsRow: true,
      baseGapFilled: false,
    };
  }

  // Artifact-first insert, reached only when no row exists on the enforced
  // identity above. Conflict-safe so a concurrent same-PR sync cannot roll the
  // whole batch back (see insertDesktopPrDetailConflictSafe).
  const created = await insertDesktopPrDetailConflictSafe(tx, {
    branchArtifactId,
    organizationId,
    repositoryId,
    repositoryFullName,
    number: ref.prNumber,
    facts,
    provenance,
    observedAt,
  });
  // A same-PR concurrent sync resolves the SAME D2 branch artifact, so the winner
  // is normally under this branch; gate ownership on that just as the paths above.
  return {
    prDetailId: created.id,
    branchArtifactId: created.branchArtifactId,
    desktopOwnsRow: created.branchArtifactId === branchArtifactId,
    baseGapFilled: false,
  };
}

/** Returns the gap actually applied, so the caller can see what it filled. */
async function persistWebhookPrGapFill(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  existing: ExistingDesktopPrRow,
  facts: DesktopPullRequestDetailData,
  repositoryFullName: string
): Promise<Prisma.PullRequestDetailUncheckedUpdateInput> {
  const gap = buildWebhookPrGapFill(existing, facts, repositoryFullName);
  if (Object.keys(gap).length === 0) {
    return gap;
  }
  const gapFilled = await tx.pullRequestDetail.updateMany({
    where: { id: existing.id, organizationId },
    data: gap,
  });
  if (gapFilled.count !== 1) {
    throw new Error("desktop PR gap-fill owner changed");
  }
  return gap;
}

/** Return our inserted row, or resolve a concurrent winner without aborting the transaction. */
async function insertDesktopPrDetailConflictSafe(
  tx: AgentSessionUpsertTx,
  input: {
    branchArtifactId: string;
    organizationId: string;
    repositoryId: string | null;
    repositoryFullName: string;
    number: number;
    facts: DesktopPullRequestDetailData;
    provenance: ReturnType<typeof gitHubFetchProvenanceData>;
    observedAt: Date;
  }
): Promise<{ id: string; branchArtifactId: string }> {
  const {
    branchArtifactId,
    organizationId,
    repositoryId,
    repositoryFullName,
    number,
    facts,
    provenance,
    observedAt,
  } = input;
  const inserted = await tx.pullRequestDetail.createManyAndReturn({
    data: [
      {
        branchArtifactId,
        organizationId,
        repositoryId,
        repositoryFullName,
        githubId: null,
        number,
        ...facts,
        ...provenance,
        desktopOriginated: true,
        ...desktopFreshnessStamps(facts, observedAt),
      },
    ],
    skipDuplicates: true,
    select: { id: true, branchArtifactId: true },
  });
  if (inserted[0]) {
    return inserted[0];
  }
  const created = await tx.pullRequestDetail.findFirst({
    where: repositoryId
      ? { organizationId, repositoryId, number }
      : { organizationId, repositoryFullName, number, repositoryId: null },
    select: { id: true, branchArtifactId: true },
  });
  if (!created) {
    // Unreachable: the insert either created this row or a conflicting row on the
    // same unique key already exists. Fail loud rather than fabricate an id.
    throw new Error(
      `pullRequestDetail insert vanished for org=${organizationId} repo=${repositoryFullName} number=${number}`
    );
  }
  return created;
}

async function upsertDesktopPullRequestDetail(
  tx: AgentSessionUpsertTx,
  input: {
    organizationId: string;
    branchArtifactId: string;
    repositoryId: string | null;
    repositoryFullName: string;
    ref: SyncedPullRequestArtifactRef;
    shouldUpdateBranchAssociation: boolean;
    existing: ExistingDesktopPrRow | null;
  }
): Promise<SessionPullRequestDetailRef> {
  const provenance = gitHubFetchProvenanceData(
    desktopSyncFetchProvenance(
      input.ref.observedAt ? new Date(input.ref.observedAt) : undefined
    )
  );
  const facts = pullRequestRefDetailData(input.ref);
  const { prDetailId, branchArtifactId, desktopOwnsRow, baseGapFilled } =
    await writeDesktopPullRequestDetailRow(tx, {
      ...input,
      facts,
      provenance,
    });
  const resolved = { prDetailId, branchArtifactId };
  if (!input.shouldUpdateBranchAssociation) {
    return resolved;
  }
  if (!desktopOwnsRow) {
    // ISS-8175: lifecycle ownership stays where it was — a webhook-owned row, or
    // one a fresher desktop observation already wrote, gets no status, activity
    // or push write from here. But a base this call just gap-filled is a NEW
    // fact about a column that had none, and the branch's own base has to hear
    // it or the value lands on the PR row and nowhere else. The decider is the
    // same one the owned path uses and refuses anything a stronger source
    // already owns, so this cannot outrank the webhook.
    if (baseGapFilled && facts.baseRefName) {
      await applyDesktopPullRequestBaseBranch(tx, {
        organizationId: input.organizationId,
        branchArtifactId: input.branchArtifactId,
        pullRequestDetailId: prDetailId,
        baseRef: facts.baseRefName,
      });
    }
    return resolved;
  }
  const becameCurrent = await promoteBranchCurrentPullRequest(tx, {
    organizationId: input.organizationId,
    branchArtifactId: input.branchArtifactId,
    pullRequestDetailId: prDetailId,
  });
  if (becameCurrent) {
    await advanceBranchLifecycleFromPullRequest(
      tx,
      input.organizationId,
      input.branchArtifactId,
      input.ref,
      prDetailId,
      facts.baseRefName
    );
  }
  return resolved;
}

export async function persistSessionPullRequestDetails(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  projectId: string | null,
  sessionArtifactId: string,
  artifactRefs: SyncedArtifactRef[] | undefined,
  repositoryAuthorityByFullName: SessionBranchRepositoryAuthorityMap,
  options: {
    shouldUpdatePullRequestLinks: boolean;
    providerLocksHeld?: boolean;
  }
): Promise<SessionPullRequestLaneResult> {
  const resolved: SessionPullRequestDetailMap = new Map();
  const deferrals: SessionPullRequestLaneDeferralMap = new Map();
  if (artifactRefs === undefined) {
    return { details: resolved, deferrals };
  }
  const prRefs = collectProviderVerifiablePullRequestRefs(artifactRefs).filter(
    (ref) => isValidPullRequestNumber(ref.prNumber)
  );
  if (prRefs.length === 0) {
    return { details: resolved, deferrals };
  }
  if (!options.providerLocksHeld) {
    await acquireSessionPullRequestProviderLocks(tx, {
      organizationId,
      artifactRefs,
    });
  }
  const refs = aggregatePullRequestArtifactRefs(prRefs);
  const existingRows = await loadDesktopPrRows(
    tx,
    organizationId,
    refs,
    repositoryAuthorityByFullName
  );

  const unresolved: UnresolvedPrRef[] = [];
  const retryableByBranch = new Map<string, BranchRefAggregate>();
  for (const ref of refs) {
    const outcome = await persistOneSessionPullRequestDetailRef(tx, {
      organizationId,
      projectId,
      ref,
      existingRows,
      repositoryAuthorityByFullName,
      shouldUpdatePullRequestLinks: options.shouldUpdatePullRequestLinks,
    });
    if (outcome.deferral) {
      deferrals.set(outcome.identityKey, outcome.deferral);
    }
    if (options.shouldUpdatePullRequestLinks && outcome.unresolved) {
      unresolved.push(outcome.unresolved);
    }
    if (options.shouldUpdatePullRequestLinks && outcome.retryableAggregate) {
      foldRetryableAggregate(retryableByBranch, outcome.retryableAggregate);
    }
    if (outcome.resolved) {
      resolved.set(outcome.identityKey, outcome.resolved);
    }
  }

  if (retryableByBranch.size > 0) {
    await enqueueBranchMaterializationRetriesTx(tx, {
      organizationId,
      sourceArtifactId: sessionArtifactId,
      aggregates: [...retryableByBranch.values()],
    });
  }

  if (unresolved.length > 0) {
    // Record deferrals under a distinct key so the legacy session_pr lane's
    // `_unresolvedPrRefs` preserve logic is not perturbed.
    await storeUnresolvedRefs<UnresolvedPrRef>(
      tx,
      sessionArtifactId,
      "_unresolvedPrDetailRefs",
      (value): value is UnresolvedPrRef =>
        value != null &&
        typeof value === "object" &&
        typeof (value as Record<string, unknown>).repositoryFullName ===
          "string" &&
        typeof (value as Record<string, unknown>).prNumber === "number" &&
        ((value as Record<string, unknown>).cause === undefined ||
          typeof (value as Record<string, unknown>).cause === "string"),
      (r) => `${r.repositoryFullName}#${r.prNumber}`,
      unresolved
    );
  }
  return { details: resolved, deferrals };
}

async function persistOneSessionPullRequestDetailRef(
  tx: AgentSessionUpsertTx,
  input: {
    organizationId: string;
    projectId: string | null;
    ref: SyncedPullRequestArtifactRef;
    existingRows: Awaited<ReturnType<typeof loadDesktopPrRows>>;
    repositoryAuthorityByFullName: SessionBranchRepositoryAuthorityMap;
    shouldUpdatePullRequestLinks: boolean;
  }
): Promise<PullRequestDetailRefSyncOutcome> {
  if (!pullRequestRefCarriesHeadBranchName(input.ref)) {
    return {
      identityKey: sessionPullRequestDetailKey(
        input.ref.repositoryFullName,
        input.ref.prNumber
      ),
      deferral: PullRequestLaneDeferral.AwaitingDesktopDelivery,
      ...(input.shouldUpdatePullRequestLinks
        ? {
            unresolved: {
              repositoryFullName: input.ref.repositoryFullName,
              prNumber: input.ref.prNumber,
            },
          }
        : {}),
    };
  }
  const normalizedFullName = normalizeRepoFullName(
    input.ref.repositoryFullName
  );
  const refWithBranchName = {
    ...input.ref,
    repositoryFullName: normalizedFullName,
    branchName: input.ref.branchName,
  };
  const branchAssociation = branchAggregateFromPrRef(
    refWithBranchName,
    normalizedFullName
  );
  const repositoryAuthority =
    input.repositoryAuthorityByFullName.get(normalizedFullName);
  const existingPrRow = findDesktopPrRow(input.existingRows.rows, {
    repositoryId: repositoryAuthority?.repositoryId ?? null,
    repositoryFullName: normalizedFullName,
    number: input.ref.prNumber,
  });
  const existingHead = existingPrRow
    ? input.existingRows.heads.get(existingPrRow.branchArtifactId)
    : undefined;
  const existingPrRowMatchesIncomingHead =
    existingHead !== undefined &&
    normalizeRepoFullName(existingHead.repositoryFullName) ===
      normalizedFullName &&
    existingHead.branchName === input.ref.branchName;
  const identityKey = sessionPullRequestDetailKey(
    normalizedFullName,
    input.ref.prNumber
  );
  if (existingPrRow && !existingPrRowMatchesIncomingHead) {
    return {
      identityKey,
      resolved: {
        prDetailId: existingPrRow.id,
        branchArtifactId: existingPrRow.branchArtifactId,
      },
    };
  }
  const materialization = await resolvePrHeadBranchMaterialization(tx, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    existingPrRow,
    repositoryAuthority,
    repositoryFullName: normalizedFullName,
    branchName: input.ref.branchName,
  });
  if (materialization.status === BranchMaterializationStatus.NotMaterialized) {
    return {
      identityKey,
      // A VERDICT, not a decline: only a ref carrying a head branch name
      // reaches here (the early return above), and that name is the whole
      // admission, so the lane ATTEMPTED and failed. The cause is real and the
      // target belongs to the existence read and this organization's fetch
      // authority — the caller's question, not the lane's.
      //
      // Deriving it from the gate instead is what ISS-9182 fixed. The gate
      // re-opens only for a watermark this delivery moves, or for link
      // evidence at a TIE that `resolveSessionPullRequestEvidence` reads from
      // `session.prRefs` alone — never from `artifactRefs`. An
      // `artifactRefs`-only delivery for an ENDED session, whose `updatedAt`
      // is frozen, ties every time, so a gate-derived deferral held every such
      // target forever with nothing scheduled to re-drive it.
      deferral: PullRequestLaneDeferral.AwaitingRepositoryRead,
      ...(input.shouldUpdatePullRequestLinks
        ? {
            unresolved: {
              repositoryFullName: input.ref.repositoryFullName,
              prNumber: input.ref.prNumber,
              cause: materialization.cause,
            },
            ...(isRetryableBranchMaterializationCause(materialization.cause)
              ? { retryableAggregate: branchAssociation }
              : {}),
          }
        : {}),
    };
  }
  const prDetail = await upsertDesktopPullRequestDetail(tx, {
    organizationId: input.organizationId,
    branchArtifactId: materialization.artifactId,
    repositoryId: repositoryAuthority?.repositoryId ?? null,
    repositoryFullName: normalizedFullName,
    ref: input.ref,
    existing: existingPrRow,
    shouldUpdateBranchAssociation: input.shouldUpdatePullRequestLinks,
  });
  return {
    identityKey,
    resolved:
      input.shouldUpdatePullRequestLinks &&
      prDetail.branchArtifactId === materialization.artifactId
        ? { ...prDetail, branchAssociation }
        : prDetail,
  };
}

function resolvePrHeadBranchMaterialization(
  tx: AgentSessionUpsertTx,
  input: {
    organizationId: string;
    projectId: string | null;
    existingPrRow: ExistingDesktopPrRow | null;
    repositoryAuthority: SessionBranchRepositoryAuthority | undefined;
    repositoryFullName: string;
    branchName: string;
  }
): Promise<BranchMaterializationResult> {
  if (input.existingPrRow) {
    return Promise.resolve({
      status: BranchMaterializationStatus.Materialized,
      artifactId: input.existingPrRow.branchArtifactId,
    });
  }
  return ensureBranchArtifactRow(tx, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    repositoryAuthority: input.repositoryAuthority,
    repositoryFullName: input.repositoryFullName,
    branchName: input.branchName,
    // ISS-8148: this lane is reached only from a PR ref, and a pull request
    // cannot exist on a branch that never reached the remote. Push evidence
    // is implied, so this lane still materializes.
    //
    // ISS-9182: unconditional rather than derived from the PR-link freshness
    // gate. The caller admits only a ref carrying a head branch name, and that
    // ref IS the evidence — creating the head Branch replaces nothing, so it
    // needs no permission from a gate built to guard destructive replacement.
    createWhenAbsent: true,
  });
}

/** A PullRequestDetail row this session's PR lane already resolved. */
export type SessionPullRequestDetailRef = {
  prDetailId: string;
  /**
   * The branch artifact the ROW is nested under — not necessarily the branch
   * artifact the PR ref was synced against (cross-branch rows stay attached).
   */
  branchArtifactId: string;
  /**
   * Branch-link evidence emitted only when the PR row's Branch matches the
   * explicit head identity from this session payload.
   */
  branchAssociation?: BranchRefAggregate;
};

export type SessionPullRequestDetailMap = Map<
  string,
  SessionPullRequestDetailRef
>;

/**
 * One AGGREGATED ref's verdict. `resolved` and `deferral` are a union rather
 * than two independent optionals, and `identityKey` is required, because a
 * path that set one half and forgot the key — or returned neither half —
 * would contribute to neither map with nothing to hear it. A target the lane
 * drops silently is one the classifier settles on its existence read, which
 * answers `IntentionallyAbsent` and acknowledges a Session whose evidence the
 * desktop never resends. Here such a path fails `tsc` instead.
 */
type PullRequestDetailRefSyncOutcome = {
  identityKey: string;
  retryableAggregate?: BranchRefAggregate;
  unresolved?: UnresolvedPrRef;
} & (
  | { resolved: SessionPullRequestDetailRef; deferral?: never }
  | {
      /**
       * Set on every path that writes no row, INCLUDING a replay, where
       * `unresolved` stays absent because nothing is recorded for a later
       * tick. The two used to coincide, and a reader taking `unresolved` for
       * the lane's whole verdict would read a replay as a lane that claimed
       * nothing.
       */
      deferral: PullRequestLaneDeferral;
      resolved?: never;
    }
);

/** Identity key for {@link SessionPullRequestDetailMap}; normalizes the repo. */
export function sessionPullRequestDetailKey(
  repositoryFullName: string,
  prNumber: number
): string {
  return `${normalizeRepoFullName(repositoryFullName)}#${prNumber}`;
}

/**
 * Completes the materialization-owned identity map for legacy `prRefs`.
 * Incoming pull-request artifact refs win; missing identities may reuse an
 * already verified current or historical row, matched by exact repo+number.
 */
export async function resolveSessionPrDetailMap(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  refs: readonly SyncedSessionPrRef[] | undefined,
  materialized: SessionPullRequestDetailMap
): Promise<SessionPullRequestDetailMap> {
  const resolved = new Map(materialized);
  if (!refs || refs.length === 0) {
    return resolved;
  }
  const missingByIdentity = new Map<string, SyncedSessionPrRef>();
  for (const ref of refs) {
    const identity = sessionPullRequestDetailKey(
      ref.repositoryFullName,
      ref.prNumber
    );
    if (!resolved.has(identity)) {
      missingByIdentity.set(identity, ref);
    }
  }
  const missing = [...missingByIdentity.values()].filter((ref) =>
    isValidPullRequestNumber(ref.prNumber)
  );
  if (missing.length === 0) {
    return resolved;
  }
  const repositoryIds = await resolveRepoIdsByFullName(
    tx,
    organizationId,
    missing
  );
  const identities = missing.flatMap((ref) => {
    const repositoryId = repositoryIds.get(
      normalizeRepoFullName(ref.repositoryFullName)
    );
    return repositoryId ? [{ repositoryId, number: ref.prNumber }] : [];
  });
  if (identities.length === 0) {
    return resolved;
  }
  const details = await readDesktopPrRows(tx, organizationId, identities, true);
  const repositoryNameById = new Map(
    [...repositoryIds].map(([name, id]) => [id, name])
  );
  for (const detail of details) {
    if (!detail.repositoryId) {
      continue;
    }
    const repositoryFullName = repositoryNameById.get(detail.repositoryId);
    if (!repositoryFullName) {
      continue;
    }
    resolved.set(
      sessionPullRequestDetailKey(repositoryFullName, detail.number),
      {
        prDetailId: detail.id,
        branchArtifactId: detail.branchArtifactId,
      }
    );
  }
  return resolved;
}

async function readDesktopPrRows(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  identities: readonly Prisma.PullRequestDetailWhereInput[],
  verifiedOnly = false
): Promise<ExistingDesktopPrRow[]> {
  const rows: ExistingDesktopPrRow[] = [];
  // The legacy PR-map read in pull-request-details uses the same identity-set shape.
  for (const chunk of chunksOf(identities, bindParameterChunkSize(3, 1))) {
    rows.push(
      ...(await tx.pullRequestDetail.findMany({
        where: {
          organizationId,
          OR: chunk,
          ...(verifiedOnly ? { lastVerifiedAt: { not: null } } : {}),
        },
        orderBy: { repositoryId: { sort: "asc", nulls: "last" } },
        select: {
          id: true,
          number: true,
          branchArtifactId: true,
          fetchMechanism: true,
          fetchObservedAt: true,
          githubId: true,
          repositoryId: true,
          repositoryFullName: true,
          title: true,
          htmlUrl: true,
          additions: true,
          deletions: true,
          changedFiles: true,
          baseRefName: true,
        },
      }))
    );
  }
  return rows;
}

async function loadDesktopPrRows(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  refs: readonly SyncedPullRequestArtifactRef[],
  authorities: SessionBranchRepositoryAuthorityMap
) {
  const identities = refs
    .filter((ref) => ref.branchName)
    .flatMap<Prisma.PullRequestDetailWhereInput>((ref) => {
      const repositoryFullName = normalizeRepoFullName(ref.repositoryFullName);
      const repositoryId = authorities.get(repositoryFullName)?.repositoryId;
      return repositoryId
        ? [
            { repositoryId, number: ref.prNumber },
            { repositoryId: null, repositoryFullName, number: ref.prNumber },
          ]
        : [{ repositoryFullName, number: ref.prNumber }];
    });
  const rows = await readDesktopPrRows(tx, organizationId, identities);
  const heads = new Map<
    string,
    { repositoryFullName: string; branchName: string }
  >();
  for (const chunk of chunksOf(
    [...new Set(rows.map((row) => row.branchArtifactId))],
    bindParameterChunkSize(1, 1)
  )) {
    for (const row of await tx.branchDetail.findMany({
      where: { organizationId, artifactId: { in: chunk } },
      select: { artifactId: true, repositoryFullName: true, branchName: true },
    })) {
      heads.set(row.artifactId, row);
    }
  }
  return { rows, heads };
}

function foldRetryableAggregate(
  retryableByBranch: Map<string, BranchRefAggregate>,
  aggregate: BranchRefAggregate
): void {
  const retryKey = branchRefAggregateKey(aggregate);
  const existing = retryableByBranch.get(retryKey);
  retryableByBranch.set(
    retryKey,
    existing ? mergeBranchRefAggregates(existing, aggregate) : aggregate
  );
}

/**
 * The PR lane's whole output for one session: the detail rows it resolved, and
 * the targets it ran over and wrote no row for.
 *
 * Both halves are the lane's own answer rather than something a later reader
 * reconstructs from the same `artifactRefs`. `deferrals` exists because the
 * absence of a row is ambiguous — the lane declining for a delivery, or the
 * provider having no such PR — and only the lane knows which.
 */
export type SessionPullRequestLaneResult = {
  details: SessionPullRequestDetailMap;
  deferrals: SessionPullRequestLaneDeferralMap;
};
