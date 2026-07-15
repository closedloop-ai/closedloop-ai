import { BranchPushSource } from "@repo/api/src/types/artifact";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import type {
  SyncedArtifactRef,
  SyncedPullRequestArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import type { Prisma } from "@repo/database";
import {
  bumpBranchActivity,
  stampBranchFirstPush,
} from "@/app/branches/branch-push-state";
import {
  desktopSyncFetchProvenance,
  gitHubFetchProvenanceData,
  isGitHubAppFetchMechanism,
} from "@/lib/github-fetch-provenance";
import type { AgentSessionUpsertTx } from "../records";
import { ensureBranchArtifactRow } from "./branch-links";
import type { UnresolvedPrRef } from "./pr-links";
import { collectPullRequestRefs, storeUnresolvedRefs } from "./shared";

/** The desktop-known PullRequestDetail columns carried by a `pull_request` ref. */
type DesktopPullRequestDetailData = {
  prState?: GitHubPRState;
  isDraft?: boolean;
  title?: string;
  htmlUrl?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  mergedAt?: Date;
  closedAt?: Date;
};

/** Map a `pull_request` ref's optional facts onto PullRequestDetail columns. */
function pullRequestRefDetailData(
  ref: SyncedPullRequestArtifactRef
): DesktopPullRequestDetailData {
  const data: DesktopPullRequestDetailData = {};
  if (ref.state !== undefined) {
    data.prState = ref.state;
  }
  if (ref.isDraft !== undefined) {
    data.isDraft = ref.isDraft;
  }
  if (ref.title !== undefined) {
    data.title = ref.title;
  }
  // Derive the PR URL server-side from the trusted repo + number rather than
  // trusting a client-supplied value — matches the sibling `prUrl` anti-forgery
  // pattern and prevents a compromised producer planting an arbitrary href.
  data.htmlUrl = `https://github.com/${normalizeRepoFullName(ref.repositoryFullName)}/pull/${ref.prNumber}`;
  if (ref.additions !== undefined) {
    data.additions = ref.additions;
  }
  if (ref.deletions !== undefined) {
    data.deletions = ref.deletions;
  }
  if (ref.changedFiles !== undefined) {
    data.changedFiles = ref.changedFiles;
  }
  if (ref.mergedAt !== undefined) {
    data.mergedAt = new Date(ref.mergedAt);
  }
  if (ref.closedAt !== undefined) {
    data.closedAt = new Date(ref.closedAt);
  }
  return data;
}

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
    const key = `${normalizeRepoFullName(ref.repositoryFullName)}#${ref.prNumber}`;
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
 * Point the branch at `prDetailId` as its current PR — UNLESS its existing
 * current PR was authored by a GitHub-App producer (webhook-wins: the desktop
 * never displaces a webhook-owned current pointer). Returns true when the
 * desktop PR is now current, so the caller may advance the branch lifecycle
 * from desktop-observed state.
 */
async function maybeSetBranchCurrentPullRequest(
  tx: AgentSessionUpsertTx,
  branchArtifactId: string,
  prDetailId: string
): Promise<boolean> {
  const branch = await tx.branchDetail.findUnique({
    where: { artifactId: branchArtifactId },
    select: { currentPullRequestDetailId: true },
  });
  const currentId = branch?.currentPullRequestDetailId ?? null;
  if (currentId && currentId !== prDetailId) {
    const current = await tx.pullRequestDetail.findUnique({
      where: { id: currentId },
      select: { fetchMechanism: true },
    });
    if (current && isGitHubAppFetchMechanism(current.fetchMechanism)) {
      return false;
    }
  }
  await tx.pullRequestDetail.updateMany({
    where: { branchArtifactId, isCurrent: true, id: { not: prDetailId } },
    data: { isCurrent: false },
  });
  await tx.pullRequestDetail.update({
    where: { id: prDetailId },
    data: { isCurrent: true },
  });
  await tx.branchDetail.update({
    where: { artifactId: branchArtifactId },
    data: { currentPullRequestDetailId: prDetailId },
  });
  return true;
}

/**
 * PRD-510 FR2 / PLN-1099 Phase 2: advance the branch lifecycle from a
 * desktop-observed PR through the SAME decider/writers the webhook uses. Called
 * only when the desktop PR is the branch's current PR (non-App repos, or App
 * repos the webhook has not yet delivered) — so webhook-wins is preserved.
 */
async function advanceBranchLifecycleFromPullRequest(
  tx: AgentSessionUpsertTx,
  branchArtifactId: string,
  ref: SyncedPullRequestArtifactRef
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
      where: { id: branchArtifactId, status: { not: GitHubPRState.Merged } },
      data: { status: ref.state },
    });
  }
  const activityAt = ref.mergedAt ?? ref.closedAt ?? ref.observedAt ?? null;
  await bumpBranchActivity(
    tx,
    branchArtifactId,
    activityAt ? new Date(activityAt) : null
  );
}

/** The existing PullRequestDetail columns the desktop upsert inspects. */
type ExistingDesktopPrRow = {
  id: string;
  fetchMechanism: string | null;
  fetchObservedAt: Date | null;
  githubId: string | null;
  repositoryId: string | null;
  repositoryFullName: string | null;
  title: string | null;
  htmlUrl: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
};

/**
 * Webhook-wins gap-fill: for a row a GitHub-App producer owns, return ONLY the
 * enrichment columns that are currently null and for which the desktop has a
 * value. Never touches authoritative fields, provenance, or LIFECYCLE
 * (mergedAt/closedAt) — for an App-owned row a null lifecycle timestamp is the
 * authoritative "not merged/closed" signal, so the desktop must not fill it.
 * prState/isDraft are omitted too — they carry non-null DB defaults, so they
 * are never a gap.
 */
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
  if (existing.repositoryFullName == null) {
    gap.repositoryFullName = repositoryFullName;
  }
  return gap;
}

/**
 * Resolve the PullRequestDetail row for a desktop-observed PR under an already-
 * resolved branch, keyed on `(branchArtifactId, number)` — the producer-
 * independent identity. Returns the row id and whether the DESKTOP owns it
 * (i.e. may advance the branch lifecycle). Webhook-wins: a GitHub-App-owned row
 * is gap-filled only (desktopOwnsRow=false); otherwise the desktop facts +
 * provenance are applied and, when absent, a row is created (artifact-first).
 */
async function writeDesktopPullRequestDetailRow(
  tx: AgentSessionUpsertTx,
  input: {
    organizationId: string;
    branchArtifactId: string;
    repositoryId: string | null;
    repositoryFullName: string;
    ref: SyncedPullRequestArtifactRef;
    facts: DesktopPullRequestDetailData;
    provenance: ReturnType<typeof gitHubFetchProvenanceData>;
  }
): Promise<{ prDetailId: string; desktopOwnsRow: boolean }> {
  const {
    organizationId,
    branchArtifactId,
    repositoryId,
    repositoryFullName,
    ref,
    facts,
    provenance,
  } = input;

  // The read-repair clock must reflect when the fact was TRUE (the desktop's
  // observation time), not server-receipt time — otherwise a days-late sync
  // would reset the staleness window and starve pr-read-repair.
  const observedAt = ref.observedAt ? new Date(ref.observedAt) : new Date();

  const existing: ExistingDesktopPrRow | null =
    await tx.pullRequestDetail.findFirst({
      where: { organizationId, branchArtifactId, number: ref.prNumber },
      select: {
        id: true,
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
      },
    });

  // A row is App/webhook-owned if its provenance says so OR it carries a
  // githubId — only the webhook/App path ever sets githubId, so a legacy App
  // row with null provenance (pre-provenance backfill, or the dev seed) is still
  // protected from a desktop overwrite (webhook-wins).
  if (
    existing &&
    (isGitHubAppFetchMechanism(existing.fetchMechanism) ||
      existing.githubId != null)
  ) {
    const gap = buildWebhookPrGapFill(existing, facts, repositoryFullName);
    if (Object.keys(gap).length > 0) {
      await tx.pullRequestDetail.update({
        where: { id: existing.id },
        data: gap,
      });
    }
    return { prDetailId: existing.id, desktopOwnsRow: false };
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
      return { prDetailId: existing.id, desktopOwnsRow: false };
    }
    // Desktop-authored (or not-yet-webhook): apply the known facts (absent facts
    // are omitted so a partial sync can't clobber a fuller prior one), backfill
    // repositoryId/repositoryFullName if newly resolved, refresh provenance.
    await tx.pullRequestDetail.update({
      where: { id: existing.id },
      data: {
        ...facts,
        repositoryFullName: existing.repositoryFullName ?? repositoryFullName,
        ...(repositoryId && existing.repositoryId == null
          ? { repositoryId }
          : {}),
        ...provenance,
        lastVerifiedAt: observedAt,
        lastRefreshAttemptAt: observedAt,
      },
    });
    return { prDetailId: existing.id, desktopOwnsRow: true };
  }

  // Artifact-first CREATE. A concurrent producer can win the (repositoryId,
  // number) / partial-unique key between the findFirst and here; as in
  // ensureBranchArtifactRow we let P2002 propagate (batch rollback) rather than
  // recover inside the aborted tx — the desktop re-sync heals it.
  const created = await tx.pullRequestDetail.create({
    data: {
      branchArtifactId,
      organizationId,
      repositoryId,
      repositoryFullName,
      githubId: null,
      number: ref.prNumber,
      ...facts,
      ...provenance,
      lastVerifiedAt: observedAt,
      lastRefreshAttemptAt: observedAt,
    },
    select: { id: true },
  });
  return { prDetailId: created.id, desktopOwnsRow: true };
}

/**
 * Upsert one desktop-observed PR into PullRequestDetail, nested under the
 * already-resolved branch artifact, then (when the desktop owns the row) point
 * the branch at it and advance the branch lifecycle. Webhook-wins throughout.
 */
async function upsertDesktopPullRequestDetail(
  tx: AgentSessionUpsertTx,
  input: {
    organizationId: string;
    branchArtifactId: string;
    repositoryId: string | null;
    repositoryFullName: string;
    ref: SyncedPullRequestArtifactRef;
  }
): Promise<void> {
  const provenance = gitHubFetchProvenanceData(
    desktopSyncFetchProvenance(
      input.ref.observedAt ? new Date(input.ref.observedAt) : undefined
    )
  );
  const facts = pullRequestRefDetailData(input.ref);
  const { prDetailId, desktopOwnsRow } = await writeDesktopPullRequestDetailRow(
    tx,
    { ...input, facts, provenance }
  );
  if (!desktopOwnsRow) {
    return;
  }
  const becameCurrent = await maybeSetBranchCurrentPullRequest(
    tx,
    input.branchArtifactId,
    prDetailId
  );
  if (becameCurrent) {
    await advanceBranchLifecycleFromPullRequest(
      tx,
      input.branchArtifactId,
      input.ref
    );
  }
}

/**
 * Sync a session's `pull_request` artifact refs into PullRequestDetail rows
 * (FEA-2732). Artifact-first: resolves — or D2-creates — the PR's HEAD branch
 * artifact before writing the PR row (deferring, like the branch lane, when the
 * branch has no resolved project yet or the ref carries no head branch). The
 * session↔PR association stays derived via the branch link (the legacy `prRefs`
 * lane still writes it for old desktops), so this lane writes no link row.
 */
export async function persistSessionPullRequestDetails(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  projectId: string | null,
  sessionArtifactId: string,
  artifactRefs: SyncedArtifactRef[] | undefined,
  repoIdByFullName: Map<string, string>
): Promise<void> {
  if (artifactRefs === undefined) {
    return;
  }
  const prRefs = collectPullRequestRefs(artifactRefs);
  if (prRefs.length === 0) {
    return;
  }

  const unresolved: UnresolvedPrRef[] = [];
  for (const ref of aggregatePullRequestArtifactRefs(prRefs)) {
    if (!ref.branchName) {
      // No head branch → can't nest the PR under a branch → defer for a later
      // sync (the desktop re-sends the full ref set; late-target tolerance).
      unresolved.push({
        repositoryFullName: ref.repositoryFullName,
        prNumber: ref.prNumber,
      });
      continue;
    }
    const normalizedFullName = normalizeRepoFullName(ref.repositoryFullName);
    const branchArtifactId = await ensureBranchArtifactRow(tx, {
      organizationId,
      projectId,
      repositoryId: repoIdByFullName.get(normalizedFullName) ?? null,
      repositoryFullName: normalizedFullName,
      branchName: ref.branchName,
    });
    if (branchArtifactId === null) {
      unresolved.push({
        repositoryFullName: ref.repositoryFullName,
        prNumber: ref.prNumber,
      });
      continue;
    }
    await upsertDesktopPullRequestDetail(tx, {
      organizationId,
      branchArtifactId,
      repositoryId: repoIdByFullName.get(normalizedFullName) ?? null,
      repositoryFullName: normalizedFullName,
      ref,
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
        typeof (value as Record<string, unknown>).prNumber === "number",
      (r) => `${r.repositoryFullName}#${r.prNumber}`,
      unresolved
    );
  }
}
