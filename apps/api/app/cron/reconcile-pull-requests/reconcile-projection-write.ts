import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import { GitHubCredentialKind } from "@repo/api/src/types/github";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
  type GitHubReadModelPullRequest,
  GitHubSyncResultReason,
} from "@repo/api/src/types/github-read-model";
import { withDb } from "@repo/database";
import {
  type BranchPullRequestProjectionInput,
  buildPullRequestDetailUpdate,
} from "@/app/branches/github-projection-writer";
import { persistPullRequestProviderFailure } from "@/app/branches/pull-request-authority-producer";
import {
  persistPullRequestHeadRepositoryAuthority,
  pullRequestHeadRepositoryObservation,
} from "@/app/branches/pull-request-head-authority";

type ReconcileContext = {
  organizationId: string;
  repositoryId: string | null;
  repositoryFullName: string;
  credentialKind: GitHubCredentialKind;
  credentialOwnerId: string | null;
  now: Date;
};

/**
 * PLN-1535 M2: refresh one fetched PR onto its EXISTING projection row — a
 * DETAIL-ONLY update. The reconciler is a data-freshness lane for the merged-LOC
 * metric: it updates the PullRequestDetail row's own fields (state, LOC,
 * lifecycle timestamps, watermark, head oid, provenance) and MUST NOT touch
 * branch-owned state. It never re-points `BranchDetail.currentPullRequestDetailId`,
 * rewrites `BranchDetail.headSha`, invalidates cached status checks, or flips
 * `isCurrent`. Those belong to the webhook / desktop-sync lanes; a cron refresh
 * driving them would let an UPDATED_AT-DESC batch clobber the branch's current
 * PR pointer, rewind the branch head from a stale merged `headRefOid`, and drop
 * the branch's checks on every tick. Returns true only when the write actually
 * mutated a row; false when nothing changed — the PR maps to no tracked row, or
 * the monotonic guard skipped it because a newer webhook already advanced the
 * watermark — so the sweep's write count reflects genuine mutations, not no-ops.
 *
 * The write is monotonic: it no-ops when a newer webhook already advanced
 * `githubUpdatedAt` past this pre-fetch snapshot, so a slow tick can never
 * regress fresher live state (TOCTOU).
 *
 * Identity: App-repo rows key on the (repositoryId, number) unique; repo-less
 * desktop rows (tier-2, no installation) resolve the current row on
 * (organizationId, normalized full name, number) WHERE repository_id IS NULL.
 * The reconciler draws by repo, so it knows which.
 */
export async function writeReconciledPullRequest(
  pullRequest: GitHubReadModelPullRequest,
  context: ReconcileContext
): Promise<boolean> {
  const detailId = await findReconcileTargetDetailId(
    pullRequest.number,
    context
  );
  if (!detailId) {
    return false;
  }
  const data = buildPullRequestDetailUpdate(
    buildReconcileProjectionInput(pullRequest, context),
    { setCurrent: false }
  );
  const fetchedUpdatedAt = pullRequest.updatedAt
    ? new Date(pullRequest.updatedAt)
    : null;
  const result = await withDb((db) =>
    db.pullRequestDetail.updateMany({
      where: {
        id: detailId,
        // Monotonic watermark guard (TOCTOU): skip when a newer webhook already
        // advanced githubUpdatedAt past this pre-fetch snapshot. An absent stored
        // watermark still writes.
        ...(fetchedUpdatedAt
          ? {
              OR: [
                { githubUpdatedAt: null },
                { githubUpdatedAt: { lte: fetchedUpdatedAt } },
              ],
            }
          : {}),
      },
      data,
    })
  );
  if (result.count > 0) {
    // Intentionally self-healing rather than one long transaction: the next
    // bounded reconcile repairs authority if this second write is interrupted,
    // while keeping provider projection work outside Prisma's 5s tx budget.
    await withDb((db) =>
      persistPullRequestHeadRepositoryAuthority(
        db,
        {
          organizationId: context.organizationId,
          pullRequestDetailId: detailId,
        },
        pullRequestHeadRepositoryObservation(pullRequest),
        { name: pullRequest.headBranch, oid: pullRequest.headSha }
      )
    );
  }
  // Report genuine mutations only: the guard matches 0 rows when a newer webhook
  // already advanced the watermark, and the sweep's write count must not inflate
  // on those no-op ticks.
  return result.count > 0;
}

/** Persist one GraphQL acquisition failure onto its exact bounded PR targets. */
export function writeReconciledPullRequestFailures(input: {
  organizationId: string;
  repositoryId: string | null;
  repositoryFullName: string;
  pullRequestNumbers: number[];
  result: Parameters<typeof persistPullRequestProviderFailure>[2];
  provenance: Parameters<typeof persistPullRequestProviderFailure>[3];
}): Promise<number> {
  if (input.pullRequestNumbers.length === 0) {
    return Promise.resolve(0);
  }
  return withDb.tx(async (tx) => {
    const rows = await tx.pullRequestDetail.findMany({
      where: {
        organizationId: input.organizationId,
        number: { in: input.pullRequestNumbers },
        ...(input.repositoryId
          ? { repositoryId: input.repositoryId }
          : {
              repositoryId: null,
              repositoryFullName: normalizeRepoFullName(
                input.repositoryFullName
              ),
            }),
      },
      select: { id: true },
    });
    let written = 0;
    for (const row of rows) {
      if (
        await persistPullRequestProviderFailure(
          tx,
          {
            organizationId: input.organizationId,
            pullRequestDetailId: row.id,
          },
          input.result,
          input.provenance
        )
      ) {
        written += 1;
      }
    }
    return written;
  });
}

async function findReconcileTargetDetailId(
  number: number,
  context: Pick<
    ReconcileContext,
    "organizationId" | "repositoryId" | "repositoryFullName"
  >
): Promise<string | null> {
  if (context.repositoryId) {
    // Capture the narrowed value: TS widens the property back to `string | null`
    // inside the nested withDb callback. The (repositoryId, number) unique makes
    // this exact — one row per PR number.
    const repositoryId = context.repositoryId;
    const row = await withDb((db) =>
      db.pullRequestDetail.findUnique({
        where: { repositoryId_number: { repositoryId, number } },
        select: { id: true },
      })
    );
    return row?.id ?? null;
  }
  // Repo-less tier-2 identity: the partial-unique (org, normalized full name,
  // number) WHERE repository_id IS NULL guarantees at most ONE repo-less row per
  // identity, so findFirst with a stable order is already deterministic. Do NOT
  // filter isCurrent: a superseded row (isCurrent flipped false by desktop-sync
  // or the shared projection writer when a newer PR became the branch's current)
  // still holds merged lifecycle/LOC the metric needs, and this reconciler is the
  // ONLY refresh path for tier-2 rows (no webhooks reach them). The tier-1 lookup
  // above filters nothing either, so both tiers refresh the same rows.
  const row = await withDb((db) =>
    db.pullRequestDetail.findFirst({
      where: {
        organizationId: context.organizationId,
        repositoryFullName: normalizeRepoFullName(context.repositoryFullName),
        repositoryId: null,
        number,
      },
      orderBy: { id: "asc" },
      select: { id: true },
    })
  );
  return row?.id ?? null;
}

function buildReconcileProjectionInput(
  pullRequest: GitHubReadModelPullRequest,
  context: ReconcileContext
): BranchPullRequestProjectionInput {
  return {
    organizationId: context.organizationId,
    // Unused by the detail-only update (buildPullRequestDetailUpdate never
    // rewrites repositoryId), carried only to satisfy the shared input type.
    repositoryId: context.repositoryId,
    githubId: pullRequest.githubId,
    number: pullRequest.number,
    title: pullRequest.title,
    htmlUrl: pullRequest.htmlUrl,
    headBranch: pullRequest.headBranch,
    baseBranch: pullRequest.baseBranch,
    headSha: pullRequest.headSha,
    prState: pullRequest.state,
    isDraft: pullRequest.isDraft,
    // Omission-preserving LOC: the read-model gives number | null, but a null
    // must never wipe a good stored value, so coalesce null → undefined (omit).
    // A real number writes; a missing count preserves what an earlier richer
    // fetch/webhook stored. These are the merged-LOC metric's exact fields.
    additions: pullRequest.additions ?? undefined,
    deletions: pullRequest.deletions ?? undefined,
    changedFiles: pullRequest.changedFiles ?? undefined,
    // Lifecycle timestamps reflect the CURRENT provider state: an open PR
    // clears closedAt/mergedAt (stored null), a merged one sets them.
    githubCreatedAt: pullRequest.openedAt
      ? new Date(pullRequest.openedAt)
      : undefined,
    // PLN-1535 M1 watermark + head oid: advance them from the fetch. Undefined
    // (absent) preserves the stored value rather than nulling it.
    githubUpdatedAt: pullRequest.updatedAt
      ? new Date(pullRequest.updatedAt)
      : undefined,
    headRefOid: pullRequest.headSha ?? undefined,
    // PLN-1535 M3: keep the author fresh; omission-preserving (a fetch without an
    // author never nulls a stored value).
    authorLogin: pullRequest.author ?? undefined,
    headRepositoryObservation:
      pullRequestHeadRepositoryObservation(pullRequest),
    closedAt: pullRequest.closedAt ? new Date(pullRequest.closedAt) : null,
    mergedAt: pullRequest.mergedAt ? new Date(pullRequest.mergedAt) : null,
    mergeCommitSha: pullRequest.mergeCommitSha ?? null,
    fetchProvenance: {
      credentialType:
        context.credentialKind === GitHubCredentialKind.Installation
          ? GitHubFetchCredentialType.GitHubApp
          : GitHubFetchCredentialType.UserOAuth,
      credentialOwnerId: context.credentialOwnerId,
      mechanism: GitHubFetchMechanism.Graphql,
      // The reconciler is the server-side backfill/sync lane (no dedicated
      // trigger value); Backfill is the closest existing classification.
      trigger: GitHubFetchTrigger.Backfill,
      observedAt: context.now,
      resultReason: GitHubSyncResultReason.Success,
    },
  };
}
