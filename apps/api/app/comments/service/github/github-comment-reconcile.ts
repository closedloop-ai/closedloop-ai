import { CommentSyncProvider } from "@repo/api/src/types/comment-thread-dto";
import { Prisma, withDb } from "@repo/database";
import {
  type GitHubProviderResult,
  GitHubProviderResultStatus,
} from "@repo/github";
import {
  type GitHubCompleteList,
  listAllPullRequestIssueComments,
  listAllPullRequestReviewComments,
  listAllPullRequestReviews,
} from "@repo/github/pull-request-comment-lists";
import { getGitHubSyncClient } from "@/lib/github/github-sync-client-pool";
import {
  backfillFetchProvenance,
  fetchCredentialTypeFromKind,
  type GitHubFetchProvenance,
} from "@/lib/github-fetch-provenance";
import { applyExternal } from "./apply-external";
import {
  ApplyExternalOutcome,
  type GitHubExternalEvent,
} from "./apply-external-events";
import {
  AcquisitionFailureCode,
  type AcquisitionProof,
  failedAcquisitionProof,
  type LaneRetractions,
  laneForThreadKind,
  laneOutcomes,
  type ReconcileListFailures,
  type ReconcileListKey,
  recordAcquisitionProof,
} from "./github-comment-acquisition-proof";
import {
  chunkReconcileEvents,
  type ReconcileList,
  type ReconcileLists,
  reconcileCleanupEvents,
  reconcileUpsertEvents,
} from "./github-comment-reconcile-events";
import { withGitHubCommentWriteRetry } from "./github-comment-write-retry";

export const GitHubCommentReconcileStatus = {
  /** Every list was complete: `commentsReconciledAt` moved on. */
  Reconciled: "reconciled",
  /** Every list was read, at least one hit its page ceiling. */
  Partial: "partial",
  /**
   * This run could not claim the pull request: another run holds the lease, or
   * no pull request with a repository to read has the id.
   */
  Claimed: "claimed",
  /**
   * No credential, or a provider list failed. The lists that were read are
   * applied, without a cleanup for any kind whose list failed, and the pull
   * request is not marked reconciled.
   */
  ProviderError: "provider_error",
} as const;
export type GitHubCommentReconcileStatus =
  (typeof GitHubCommentReconcileStatus)[keyof typeof GitHubCommentReconcileStatus];

export const GitHubCommentReconcileReason = {
  /** Decision 4: a list stopped at its page ceiling, so its cleanup was skipped. */
  ListCeiling: "list_ceiling",
  /** A list's earlier pages changed mid-read, so its cleanup was skipped. */
  ListShifted: "list_shifted",
} as const;

export type GitHubCommentReconcileResult = {
  status: GitHubCommentReconcileStatus;
  /** Set on `provider_error`: the provider or credential failure. */
  errorCode?: string;
  reasons: string[];
  appliedEvents: number;
  /** Realtime signals the run emitted: one per changed thread per chunk. */
  signals: number;
};

/** Lists already read by the caller, e.g. the post-connect backfill. */
export type PrefetchedReconcileLists = {
  issueComments: GitHubProviderResult<
    GitHubCompleteList<ReconcileLists["issueComments"]["items"][number]>
  >;
  reviewComments: GitHubProviderResult<
    GitHubCompleteList<ReconcileLists["reviewComments"]["items"][number]>
  >;
  reviews: GitHubProviderResult<
    GitHubCompleteList<ReconcileLists["reviews"]["items"][number]>
  >;
  listedAt: ReconcileLists["listedAt"];
  fetchProvenance: GitHubFetchProvenance;
};

/** A run that stopped holding the lease is free to be claimed again after this. */
const CLAIM_LEASE_MINUTES = 10;

/**
 * Whether the reconcile lease in `claimedAtColumn` is free to claim: never
 * taken, released, or older than the lease. The claim and the cron's due-PR
 * scan both read it, so they agree on which pull requests are claimable.
 */
export function reconcileLeaseIsFreeSql(claimedAtColumn: Prisma.Sql) {
  return Prisma.sql`(
    ${claimedAtColumn} IS NULL
    OR ${claimedAtColumn} < now() - make_interval(mins => ${CLAIM_LEASE_MINUTES})
  )`;
}

type ClaimedPullRequest = {
  id: string;
  organizationId: string;
  branchArtifactId: string;
  repositoryFullName: string;
  number: number;
  /** The lease this run took, which its release must still match. */
  claimedAt: Date;
};

/**
 * PLN-2122 Step 5: reconcile one pull request's GitHub comments against
 * complete provider lists, through `applyExternal`. Runs only under a claimed
 * lease, whose claim stamps the attempt and which it always releases unless a
 * later run has taken it over; deletes what a complete list no longer holds,
 * and marks the pull request reconciled only when every list was read and
 * complete. ISS-11767: the release records each lane's outcome as proof, and a
 * run that throws records every lane `FAILED`.
 */
export async function reconcilePullRequestComments(input: {
  pullRequestDetailId: string;
  prefetched?: PrefetchedReconcileLists;
  /**
   * Claim only a pull request with no attempt within the freshness floor. A
   * first view checks the floor before it claims, so two views can both read
   * a pull request due; holding the claim to the floor lets only the first
   * reach GitHub. The cron's due scan applies the floor itself.
   */
  requireAttemptDue?: boolean;
}): Promise<GitHubCommentReconcileResult> {
  const claimed = await claimPullRequest(
    input.pullRequestDetailId,
    input.requireAttemptDue ?? false
  );
  if (!claimed) {
    return emptyResult(GitHubCommentReconcileStatus.Claimed);
  }
  let complete = false;
  let proof: AcquisitionProof | null = null;
  let read: ReadLists | null = null;
  try {
    read = await readLists(claimed, input);
    if (!read.ok) {
      proof = failedAcquisitionProof(
        read.errorCode,
        read.failures,
        read.listedAt
      );
      return {
        ...emptyResult(GitHubCommentReconcileStatus.ProviderError),
        errorCode: read.errorCode,
      };
    }
    const { retracted, ...applied } = await applyLists(
      claimed,
      read.lists,
      read.fetchProvenance
    );
    proof = laneOutcomes(read.lists, read.failures, retracted);
    const reasons = incompleteReasons(read.lists);
    if (read.errorCode) {
      return {
        status: GitHubCommentReconcileStatus.ProviderError,
        errorCode: read.errorCode,
        reasons,
        ...applied,
      };
    }
    complete = reasons.length === 0;
    return {
      status: complete
        ? GitHubCommentReconcileStatus.Reconciled
        : GitHubCommentReconcileStatus.Partial,
      reasons,
      ...applied,
    };
  } catch (error) {
    // A partly applied lane must not claim completeness.
    proof = read?.ok
      ? failedAcquisitionProof(
          AcquisitionFailureCode.ApplyFailed,
          read.failures,
          read.lists.listedAt
        )
      : failedAcquisitionProof(AcquisitionFailureCode.ReadFailed);
    throw error;
  } finally {
    await releasePullRequest(claimed, complete, proof);
  }
}

async function claimPullRequest(
  pullRequestDetailId: string,
  requireAttemptDue: boolean
): Promise<ClaimedPullRequest | null> {
  const attemptDue = requireAttemptDue
    ? Prisma.sql`AND ${olderThanReconcileFreshnessFloorSql(Prisma.raw('"comments_reconcile_attempted_at"'))}`
    : Prisma.empty;
  const rows = await withDb((db) =>
    db.$queryRaw<ClaimedPullRequest[]>(Prisma.sql`
      UPDATE "pull_request_detail"
      SET "comments_reconcile_claimed_at" = now(),
        "comments_reconcile_attempted_at" = now()
      WHERE "id" = ${pullRequestDetailId}::uuid
        AND "repository_full_name" IS NOT NULL
        AND ${reconcileLeaseIsFreeSql(Prisma.raw('"comments_reconcile_claimed_at"'))}
        ${attemptDue}
      RETURNING
        "id",
        "organization_id" AS "organizationId",
        "branch_artifact_id" AS "branchArtifactId",
        "repository_full_name" AS "repositoryFullName",
        "number",
        "comments_reconcile_claimed_at" AS "claimedAt"
    `)
  );
  return rows[0] ?? null;
}

/**
 * Releases the lease only while it is still the one this run took: a run that
 * outlived it leaves a later run's lease, and its reconciled stamp, alone.
 * The reconciled stamp takes the database clock, as the claim's attempt stamp
 * does: the marker compares the two, and an app-server clock behind the
 * database's would read a complete run as a failed attempt. The run's lane
 * proof commits with the release, and only when the release matched.
 */
async function releasePullRequest(
  pullRequest: ClaimedPullRequest,
  reconciled: boolean,
  proof: AcquisitionProof | null
): Promise<void> {
  await withDb.tx(async (tx) => {
    const released = await tx.$executeRaw(Prisma.sql`
      UPDATE "pull_request_detail"
      SET "comments_reconcile_claimed_at" = NULL,
        "comments_reconciled_at" = CASE
          WHEN ${reconciled} THEN now()
          ELSE "comments_reconciled_at"
        END
      WHERE "id" = ${pullRequest.id}::uuid
        AND "comments_reconcile_claimed_at" = ${pullRequest.claimedAt}
    `);
    if (released > 0 && proof) {
      await recordAcquisitionProof(tx, pullRequest, proof);
    }
  });
}

type ReadLists =
  | {
      ok: true;
      lists: ReconcileLists;
      fetchProvenance: GitHubFetchProvenance;
      /** Set when a list failed: the first failure's code. */
      errorCode?: string;
      failures: ReconcileListFailures;
    }
  | {
      ok: false;
      errorCode: string;
      failures?: ReconcileListFailures;
      /** Set when the lists were read and every one failed. */
      listedAt?: Date;
    };

/**
 * Every list is read before anything is applied. A list the provider failed
 * is applied as an incomplete, empty one: it writes nothing and its kind gets
 * no cleanup, while the lists that were read are still applied. Nothing is
 * marked FAILED.
 */
async function readLists(
  pullRequest: ClaimedPullRequest,
  input: { prefetched?: PrefetchedReconcileLists }
): Promise<ReadLists> {
  const fetched = input.prefetched ?? (await fetchLists(pullRequest));
  if ("errorCode" in fetched) {
    return { ok: false, errorCode: fetched.errorCode };
  }
  const failures: ReconcileListFailures = {};
  const lists: ReconcileLists = {
    issueComments: readList(fetched.issueComments, "issueComments", failures),
    reviewComments: readList(
      fetched.reviewComments,
      "reviewComments",
      failures
    ),
    reviews: readList(fetched.reviews, "reviews", failures),
    listedAt: fetched.listedAt,
  };
  const codes = Object.values(failures);
  const [errorCode] = codes;
  if (errorCode && codes.length === 3) {
    return { ok: false, errorCode, failures, listedAt: fetched.listedAt };
  }
  return {
    ok: true,
    lists,
    fetchProvenance: fetched.fetchProvenance,
    ...(errorCode ? { errorCode } : {}),
    failures,
  };
}

function readList<T>(
  result: GitHubProviderResult<GitHubCompleteList<T>>,
  key: ReconcileListKey,
  failures: ReconcileListFailures
): ReconcileList<T> {
  if (result.status === GitHubProviderResultStatus.Success) {
    return result.value;
  }
  failures[key] = result.status;
  return { items: [], complete: false, failed: true };
}

async function fetchLists(
  pullRequest: ClaimedPullRequest
): Promise<PrefetchedReconcileLists | { errorCode: string }> {
  const [owner, repo] = pullRequest.repositoryFullName.split("/");
  if (!(owner && repo)) {
    return { errorCode: "repository_unparseable" };
  }
  const drawn = await getGitHubSyncClient({
    organizationId: pullRequest.organizationId,
    target: { owner, repo },
  });
  if (!drawn.ok) {
    return { errorCode: drawn.error.reason };
  }
  const { octokit } = drawn.value;
  const pullNumber = pullRequest.number;
  const listedAt = new Date();
  const [issueComments, reviewComments, reviews] = await Promise.all([
    listAllPullRequestIssueComments(octokit, owner, repo, pullNumber),
    listAllPullRequestReviewComments(octokit, owner, repo, pullNumber),
    listAllPullRequestReviews(octokit, owner, repo, pullNumber),
  ]);
  return {
    issueComments,
    reviewComments,
    reviews,
    listedAt,
    // The stamp the PR-projection reconciler gives its sweep writes.
    fetchProvenance: backfillFetchProvenance({
      credentialType: fetchCredentialTypeFromKind(drawn.value.kind),
      credentialOwnerId: drawn.value.credentialOwnerId,
    }),
  };
}

async function applyLists(
  pullRequest: ClaimedPullRequest,
  lists: ReconcileLists,
  fetchProvenance: GitHubFetchProvenance
): Promise<
  Pick<GitHubCommentReconcileResult, "appliedEvents" | "signals"> & {
    retracted: LaneRetractions;
  }
> {
  const totals = { appliedEvents: 0, signals: 0 };
  const retracted: LaneRetractions = {};
  const apply = async (events: GitHubExternalEvent[]) => {
    const result = await withGitHubCommentWriteRetry(() =>
      applyExternal({
        provider: CommentSyncProvider.Github,
        organizationId: pullRequest.organizationId,
        branchArtifactId: pullRequest.branchArtifactId,
        pullRequestDetailId: pullRequest.id,
        fetchProvenance,
        events,
      })
    );
    totals.appliedEvents += result.outcomes.filter(
      (outcome) => outcome === ApplyExternalOutcome.Applied
    ).length;
    totals.signals += result.changedThreadIds.length;
    return result;
  };
  for (const events of chunkReconcileEvents(reconcileUpsertEvents(lists))) {
    await apply(events);
  }
  // Each call deletes at most `maxComments`, and every deletion is permanent
  // for the scan, so the loop ends once a call finds nothing left.
  for (const cleanup of reconcileCleanupEvents(lists)) {
    let result: Awaited<ReturnType<typeof apply>>;
    let count = 0;
    do {
      result = await apply([cleanup]);
      count += result.retractedComments ?? 0;
    } while (result.outcomes[0] === ApplyExternalOutcome.Applied);
    retracted[laneForThreadKind(cleanup.threadKind)] = count;
  }
  return { ...totals, retracted };
}

function emptyResult(
  status: GitHubCommentReconcileStatus
): GitHubCommentReconcileResult {
  return { status, reasons: [], appliedEvents: 0, signals: 0 };
}

function incompleteReasons(lists: ReconcileLists): string[] {
  const incomplete = [
    lists.issueComments,
    lists.reviewComments,
    lists.reviews,
  ].filter((list) => !(list.complete || list.failed));
  const reasons = new Set<string>();
  for (const list of incomplete) {
    reasons.add(
      list.shifted
        ? GitHubCommentReconcileReason.ListShifted
        : GitHubCommentReconcileReason.ListCeiling
    );
  }
  return [...reasons];
}

/**
 * Operator ruling (Kerensa, 2026-10-02, PR #8321 review): a pull request is due
 * only once it was never reconciled or last reconciled longer ago than this.
 * The cron's due scan and the first-view reconcile both hold a PR the same
 * span after its last attempt.
 */
export const RECONCILE_PR_COMMENTS_FRESHNESS_FLOOR_MINUTES = 60;

/** Whether the stamp in `stampColumn` is unset or older than the freshness floor. */
export function olderThanReconcileFreshnessFloorSql(
  stampColumn: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`(
    ${stampColumn} IS NULL
    OR ${stampColumn} < now() - make_interval(mins => ${RECONCILE_PR_COMMENTS_FRESHNESS_FLOOR_MINUTES})
  )`;
}
