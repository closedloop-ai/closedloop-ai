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
import {
  BranchMaterializationStatus,
  ensureBranchArtifactRow,
} from "./branch-links";
import type { UnresolvedPrRef } from "./pr-links";
import {
  collectPullRequestRefs,
  type SessionBranchRepositoryAuthorityMap,
  storeUnresolvedRefs,
} from "./shared";

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
  branchArtifactId: string;
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
 * Resolve the PullRequestDetail row for a desktop-observed PR against the
 * DB-enforced producer-independent identity — the exact `(repositoryId, number)`
 * unique key when the repo is resolved, else the `(organizationId,
 * repositoryFullName, number)` identity (which also finds an already-adopted row
 * this sync could not resolve a repositoryId for). It is deliberately NOT keyed
 * on `branchArtifactId`: a PR row is unique per repo + number across ALL branch
 * artifacts, so a `branchArtifactId`-scoped lookup misses a row materialized
 * under a different branch artifact and the artifact-first create then collides
 * on the real unique index (FEA-3917).
 *
 * Returns the resolved row (id + the branch artifact it is nested under, which
 * is NOT always `input.branchArtifactId` — see cross-branch below) and whether
 * the DESKTOP owns it (i.e. may advance the
 * branch lifecycle). Webhook-wins: a GitHub-App-owned row is gap-filled only
 * (desktopOwnsRow=false); otherwise the desktop facts + provenance are applied
 * and, when absent, a row is created (artifact-first).
 *
 * Cross-branch ownership (FEA-3917 OQ1, desktop-scoped): the desktop leaves the
 * row attached to its existing `branchArtifactId` — it never re-points the row
 * to the branch artifact currently being synced (unlike the App writer, which
 * has authoritative head-branch data). A resolved row nested under a DIFFERENT
 * branch artifact is reconciled by dedup only (found, not mutated) and returns
 * desktopOwnsRow=false — the desktop neither collides on create nor freshens that
 * row's facts/read-repair clock from the wrong branch's context. `desktopOwnsRow`
 * is true only when the resolved row is already nested under
 * `input.branchArtifactId`.
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
): Promise<SessionPullRequestDetailRef & { desktopOwnsRow: boolean }> {
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

  // Reconcile on the DB-enforced producer-independent identity, NOT on
  // branchArtifactId (FEA-3917): the row is unique per repo + number across all
  // branch artifacts, so a branchArtifactId-scoped lookup misses a row under a
  // different branch and the create below collides on the real unique index.
  const existing = await resolveExistingDesktopPrRow(tx, {
    organizationId,
    repositoryId,
    repositoryFullName,
    number: ref.prNumber,
  });

  // Leave-attached (FEA-3917 OQ1, desktop-scoped): a row that belongs to a
  // DIFFERENT branch artifact is reconciled by DEDUP ONLY — the identity lookup
  // found it, so we neither collide on create nor mutate it. This check runs
  // BEFORE the webhook gap-fill and every other mutation below, so a cross-branch
  // sync can never change the row it only means to dedupe (App-owned rows would
  // otherwise be gap-filled here). Freshening a cross-branch row's facts/read-
  // repair clock while withholding its branch-lifecycle advance (desktopOwnsRow=
  // false makes upsertDesktopPullRequestDetail return before advanceBranch-
  // LifecycleFromPullRequest) would leave that branch's PR row terminal-but-
  // unadvanced (e.g. prState=MERGED, Artifact.status still OPEN) and permanently
  // silence pr-read-repair for it. The owning branch's own syncs — or the
  // webhook — own that row's facts and lifecycle.
  if (existing && existing.branchArtifactId !== branchArtifactId) {
    return {
      prDetailId: existing.id,
      branchArtifactId: existing.branchArtifactId,
      desktopOwnsRow: false,
    };
  }

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
    return {
      prDetailId: existing.id,
      branchArtifactId: existing.branchArtifactId,
      desktopOwnsRow: false,
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
      return {
        prDetailId: existing.id,
        branchArtifactId: existing.branchArtifactId,
        desktopOwnsRow: false,
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
    // The row is nested under the branch we're syncing (cross-branch rows returned
    // above), so the desktop may point this branch at it and advance its lifecycle.
    return {
      prDetailId: existing.id,
      branchArtifactId: existing.branchArtifactId,
      desktopOwnsRow: true,
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
  };
}

/**
 * Resolve the existing PullRequestDetail row for a desktop-observed PR on the
 * DB-enforced producer-independent identity (FEA-3917). Two-step:
 *   1. Exact `(repositoryId, number)` when the repo is resolved — the unique,
 *      index-served App key; deterministically THIS repo's row, never a stale
 *      pre-transfer install that merely shares the full name.
 *   2. Fall back to `(organizationId, repositoryFullName, number)`. When the repo
 *      is resolved, step 1 already matched its App row, so this is scoped to
 *      `repositoryId: null` — a not-yet-adopted repo-less row for this repo,
 *      served by the partial repo-less unique index rather than an org-wide scan,
 *      and never a different repo's row after a transfer. Only when the repo is
 *      UNresolved (repositoryId null — e.g. a suspended install) do we broaden to
 *      include adopted rows so a stale incoming null cannot spawn a repo-less
 *      duplicate; nulls-last then prefers an adopted row over a repo-less one.
 */
async function resolveExistingDesktopPrRow(
  tx: AgentSessionUpsertTx,
  input: {
    organizationId: string;
    repositoryId: string | null;
    repositoryFullName: string;
    number: number;
  }
): Promise<ExistingDesktopPrRow | null> {
  const { organizationId, repositoryId, repositoryFullName, number } = input;
  const select = {
    id: true,
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
  } as const;

  if (repositoryId) {
    const byRepoId = await tx.pullRequestDetail.findFirst({
      where: { organizationId, repositoryId, number },
      select,
    });
    if (byRepoId) {
      return byRepoId;
    }
  }
  return tx.pullRequestDetail.findFirst({
    where: {
      organizationId,
      repositoryFullName,
      number,
      ...(repositoryId ? { repositoryId: null } : {}),
    },
    orderBy: { repositoryId: { sort: "asc", nulls: "last" } },
    select,
  });
}

/**
 * Insert a new desktop-observed PullRequestDetail conflict-safe, then read back
 * the winning row (FEA-3917). Two compute targets can both miss the lookup and
 * race this insert; a bare `create` would P2002 for the loser and — because a
 * failed statement aborts the enclosing interactive tx (see branch-links.ts) —
 * roll the WHOLE sync batch back. `createMany({ skipDuplicates })` emits
 * ON CONFLICT DO NOTHING (covering both the `(repositoryId, number)` unique and
 * the repo-less partial index), so the loser no-ops instead of aborting; we then
 * read the winner by the same identity the insert used. Satisfies the repo
 * atomic-upsert rule (apps/api/AGENTS.md) and converges without a batch rollback.
 */
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
  await tx.pullRequestDetail.createMany({
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
        lastVerifiedAt: observedAt,
        lastRefreshAttemptAt: observedAt,
      },
    ],
    skipDuplicates: true,
  });
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

/**
 * Upsert one desktop-observed PR into PullRequestDetail, nested under the
 * already-resolved branch artifact, then (when the desktop owns the row) point
 * the branch at it and advance the branch lifecycle. Webhook-wins throughout.
 * Returns the resolved row so sibling lanes can attribute to it without
 * re-querying (see `persistSessionPullRequestDetails`).
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
): Promise<SessionPullRequestDetailRef> {
  const provenance = gitHubFetchProvenanceData(
    desktopSyncFetchProvenance(
      input.ref.observedAt ? new Date(input.ref.observedAt) : undefined
    )
  );
  const facts = pullRequestRefDetailData(input.ref);
  const { prDetailId, branchArtifactId, desktopOwnsRow } =
    await writeDesktopPullRequestDetailRow(tx, {
      ...input,
      facts,
      provenance,
    });
  const resolved = { prDetailId, branchArtifactId };
  if (!desktopOwnsRow) {
    return resolved;
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
  return resolved;
}

/**
 * Sync a session's `pull_request` artifact refs into PullRequestDetail rows.
 * The PR's head branch must first pass canonical server-owned non-default
 * eligibility. Missing head names and non-materialized heads are retained as
 * unresolved evidence for a later sync; neither condition aborts the batch.
 * The session↔PR association stays derived via the branch link (the legacy
 * `prRefs` lane still writes it for old desktops), so this lane writes no link.
 *
 * Returns every PR row this lane resolved, keyed by
 * `sessionPullRequestDetailKey`, so later lanes in the same transaction can
 * attribute to those rows instead of re-deriving them from the database
 * (ISS-6450).
 */
export async function persistSessionPullRequestDetails(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  projectId: string | null,
  sessionArtifactId: string,
  artifactRefs: SyncedArtifactRef[] | undefined,
  repositoryAuthorityByFullName: SessionBranchRepositoryAuthorityMap
): Promise<SessionPullRequestDetailMap> {
  const resolved: SessionPullRequestDetailMap = new Map();
  if (artifactRefs === undefined) {
    return resolved;
  }
  const prRefs = collectPullRequestRefs(artifactRefs);
  if (prRefs.length === 0) {
    return resolved;
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
    const repositoryAuthority =
      repositoryAuthorityByFullName.get(normalizedFullName);
    const materialization = await ensureBranchArtifactRow(tx, {
      organizationId,
      projectId,
      repositoryAuthority,
      repositoryFullName: normalizedFullName,
      branchName: ref.branchName,
    });
    if (
      materialization.status === BranchMaterializationStatus.NotMaterialized
    ) {
      unresolved.push({
        repositoryFullName: ref.repositoryFullName,
        prNumber: ref.prNumber,
        cause: materialization.cause,
      });
      continue;
    }
    const prDetail = await upsertDesktopPullRequestDetail(tx, {
      organizationId,
      branchArtifactId: materialization.artifactId,
      repositoryId: repositoryAuthority?.repositoryId ?? null,
      repositoryFullName: normalizedFullName,
      ref,
    });
    resolved.set(
      sessionPullRequestDetailKey(normalizedFullName, ref.prNumber),
      prDetail
    );
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
  return resolved;
}

/** A PullRequestDetail row this session's PR lane already resolved. */
export type SessionPullRequestDetailRef = {
  prDetailId: string;
  /**
   * The branch artifact the ROW is nested under — not necessarily the branch
   * artifact the PR ref was synced against (cross-branch rows stay attached).
   */
  branchArtifactId: string;
};

export type SessionPullRequestDetailMap = Map<
  string,
  SessionPullRequestDetailRef
>;

/** Identity key for {@link SessionPullRequestDetailMap}; normalizes the repo. */
export function sessionPullRequestDetailKey(
  repositoryFullName: string,
  prNumber: number
): string {
  return `${normalizeRepoFullName(repositoryFullName)}#${prNumber}`;
}
