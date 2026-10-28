import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import type { GitHubCredentialKind } from "@repo/api/src/types/github";
import {
  GitHubFetchMechanism,
  GitHubFetchTrigger,
  type GitHubReadModelPullRequest,
  GitHubSyncResultReason,
} from "@repo/api/src/types/github-read-model";
import { type Prisma, withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { emitBranchDetailChanged } from "@/app/branches/branch-detail-signal";
import { seedBranchOwners } from "@/app/branches/branch-owner-seed/branch-owner-seed";
import {
  type BranchPullRequestProjectionInput,
  buildPullRequestDetailUpdate,
} from "@/app/branches/github-projection-writer";
import { ensurePullRequestAuthorIdentity } from "@/app/branches/pull-request-author-identity";
import { persistPullRequestProviderFailure } from "@/app/branches/pull-request-authority-producer";
import {
  needsGitHubHeadRefile,
  type PullRequestFiling,
  pullRequestGitHubHead,
} from "@/app/branches/pull-request-github-head-filing";
import { refilePullRequestUnderGitHubHead } from "@/app/branches/pull-request-github-head-refile";
import {
  persistPullRequestHeadRepositoryAuthority,
  pullRequestHeadRepositoryObservation,
} from "@/app/branches/pull-request-head-authority";
import { fetchCredentialTypeFromKind } from "@/lib/github-fetch-provenance";

type ReconcileContext = {
  organizationId: string;
  repositoryId: string | null;
  repositoryFullName: string;
  credentialKind: GitHubCredentialKind;
  credentialOwnerId: string | null;
  fetchTrigger?: GitHubFetchTrigger;
  now: Date;
  /**
   * ISS-8919: identities this batch already resolved, so a caller writing many
   * PRs pays one read instead of one per row. Absent from the map means "no
   * tracked row", and that PR is skipped — so a caller MUST build this with
   * `resolveReconcileTargets` over every number it intends to write.
   * A partial map silently skips the numbers missing from it.
   */
  detailTargets?: ReadonlyMap<number, ReconcileTarget>;
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
 * the branch's checks on every tick. The one exception is ISS-12344: a PR filed
 * under a Branch other than the head this read reports is moved to that head's
 * Branch through the ISS-6980 relink, which clears the old Branch's pointer when
 * it named this PR. Returns true only when the write actually
 * mutated a row; false when nothing changed — the PR maps to no tracked row, or
 * the monotonic guard skipped it because a newer webhook already advanced the
 * watermark — so the sweep's write count reflects genuine mutations, not no-ops.
 *
 * The write is monotonic: it no-ops when a newer webhook already advanced
 * `githubUpdatedAt` past this pre-fetch snapshot, so a slow tick can never
 * regress fresher live state (TOCTOU).
 *
 * Identity is `readReconcileTargetRows`', which owns both tier predicates and
 * documents them. A page-writing caller resolves the whole page once and passes
 * `context.detailTargets`; a single-PR caller omits it and this resolves its one
 * number through the same read. So the row this writes is chosen by one
 * predicate no matter which lane called, and a number missing from a supplied
 * map is skipped exactly as an unresolvable one is.
 */
export async function writeReconciledPullRequest(
  pullRequest: GitHubReadModelPullRequest,
  context: ReconcileContext
): Promise<boolean> {
  const detailTargets =
    context.detailTargets ??
    (await resolveReconcileTargets([pullRequest.number], context));
  const previous = detailTargets.get(pullRequest.number);
  if (!previous) {
    return false;
  }
  const detailId = previous.id;
  const data = reconciledPullRequestDetailData(pullRequest, context);
  const fetchedUpdatedAt = pullRequest.updatedAt
    ? new Date(pullRequest.updatedAt)
    : null;
  const awaitsRefile = needsGitHubHeadRefile(
    {
      repositoryFullName: context.repositoryFullName,
      branch: previous.filedBranch,
    },
    pullRequestGitHubHead(pullRequest)
  );
  const result = await withDb.tx(async (db) => {
    const updated = await db.pullRequestDetail.updateManyAndReturn({
      where: {
        id: detailId,
        organizationId: context.organizationId,
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
      // RETURNING observes the owner of the row this guarded update locked,
      // even if a relink changed ownership after the batched target read.
      select: { branchArtifactId: true },
    });
    const written = updated[0];
    if (written) {
      await ensurePullRequestAuthorIdentity(db, {
        organizationId: context.organizationId,
        githubId: pullRequest.githubId,
        authorProviderUserId: pullRequest.authorProviderUserId,
        authorLogin: pullRequest.author,
        authorActorType: pullRequest.authorActorType,
      });
      // ISS-12463: the update above may be the PR's first author login. The
      // seed's first stamp is final, so it skips a PR the refile below moves
      // (which seeds its head Branch) and a PR relinked since the filing read.
      if (
        written.branchArtifactId &&
        written.branchArtifactId === previous.branchArtifactId &&
        !awaitsRefile
      ) {
        await seedBranchOwners(db, context.organizationId, [
          written.branchArtifactId,
        ]);
      }
      // A verification timestamp alone is not a provider change. Repeated
      // reconciles of the same revision must not turn signals into polling.
      if (
        written.branchArtifactId &&
        (written.branchArtifactId !== previous.branchArtifactId ||
          !fetchedUpdatedAt ||
          previous.githubUpdatedAt?.getTime() !== fetchedUpdatedAt.getTime())
      ) {
        await emitBranchDetailChanged(
          db,
          context.organizationId,
          written.branchArtifactId
        );
      }
    }
    return { count: updated.length };
  });
  if (result.count > 0) {
    // Keep this second write outside Prisma's 5s transaction budget and scope
    // its failure to this row. Throwing here used to abandon every PR behind it
    // and skip the repo's cursor/watermark commit, re-fetching the whole page on
    // the next tick. The primary projection remains a genuine mutation even
    // when this independently persisted authority evidence could not be saved.
    try {
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
    } catch (error) {
      log.error("reconcile_pull_request_head_authority_write_failed", {
        organizationId: context.organizationId,
        repositoryFullName: context.repositoryFullName,
        pullRequestDetailId: detailId,
        pullRequestNumber: pullRequest.number,
        error: parseError(error),
      });
    }
    if (awaitsRefile) {
      await refilePullRequestUnderGitHubHead(
        context.organizationId,
        detailId,
        pullRequest
      );
    }
  }
  // Report genuine mutations only: the guard matches 0 rows when a newer webhook
  // already advanced the watermark, and the sweep's write count must not inflate
  // on those no-op ticks.
  return result.count > 0;
}

/**
 * Persist one GraphQL acquisition failure onto its exact bounded PR targets.
 *
 * The READ stays one batched `findMany`, but each row's write takes its OWN
 * short boundary instead of sharing one transaction. The per-row persister is a
 * compare-and-swap — a read plus a guarded update, retried on contention — so a
 * full self-heal batch under one `withDb.tx` serializes dozens of round-trips
 * against Prisma's default 5s budget, and a P2028 there rolls back EVERY row
 * rather than the one that was slow: the sweep reports no progress, the same
 * rows refill next tick, and the backlog stalls instead of degrading. Same
 * self-healing trade-off `writeReconciledPullRequest` above already makes for
 * its second write.
 *
 * A failed row is isolated, not fatal: it is logged and the remaining rows still
 * get their observation, so one contended row costs only itself instead of
 * abandoning the rest of the batch (which the reconcile caller re-selects in the
 * same order next tick, starving the tail). Every write is idempotent — an exact
 * observation replay is a no-op, and the persister re-checks the row it read, so
 * a row deleted between read and write is skipped rather than resurrected — so
 * the next bounded reconcile repairs whatever a partial run missed. The returned
 * count therefore reports rows actually written, not rows attempted.
 *
 * The batch bound is the CALLER's, not this writer's, and each caller sets its
 * own: the sweep's self-heal arms pass at most `RECONCILE_SELF_HEAL_BATCH`, its
 * targeted arm `RECONCILE_SESSION_LINKED_TARGET_BATCH` (a separate constant that
 * merely happens to match today) plus ISS-12292's unlinked-open rows, together
 * at most `GITHUB_PULL_REQUEST_BY_NUMBER_BATCH_SIZE`, the backfill lane one per
 * tracked branch, and the tier-2 branch refresh exactly one. Short per-row boundaries
 * hold no connection or transaction across the loop, so a long caller list
 * costs wall-clock rather than a shared 5s budget every row can blow — but
 * capping that list stays the caller's concern, since silently truncating here
 * would drop observations with no signal.
 */
export async function writeReconciledPullRequestFailures(input: {
  organizationId: string;
  repositoryId: string | null;
  repositoryFullName: string;
  pullRequestNumbers: number[];
  result: Parameters<typeof persistPullRequestProviderFailure>[2];
  provenance: Parameters<typeof persistPullRequestProviderFailure>[3];
}): Promise<number> {
  if (input.pullRequestNumbers.length === 0) {
    return 0;
  }
  const rows = await readReconcileTargetRows(input.pullRequestNumbers, input);
  let written = 0;
  for (const row of rows) {
    if (await writeOnePullRequestFailure(row.id, input.organizationId, input)) {
      written += 1;
    }
  }
  return written;
}

/**
 * One row's own write boundary. Contention that exhausts the persister's
 * compare-and-swap throws; swallowing it here keeps that row's cost local — the
 * observation is self-healing, so losing one is strictly cheaper than dropping
 * every row behind it.
 */
async function writeOnePullRequestFailure(
  pullRequestDetailId: string,
  organizationId: string,
  input: {
    repositoryFullName: string;
    result: Parameters<typeof persistPullRequestProviderFailure>[2];
    provenance: Parameters<typeof persistPullRequestProviderFailure>[3];
  }
): Promise<boolean> {
  try {
    return await withDb((db) =>
      persistPullRequestProviderFailure(
        db,
        { organizationId, pullRequestDetailId },
        input.result,
        input.provenance
      )
    );
  } catch (error) {
    log.warn("reconcile_pull_request_provider_failure_write_failed", {
      organizationId,
      repositoryFullName: input.repositoryFullName,
      pullRequestDetailId,
      error: parseError(error),
    });
    return false;
  }
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
    repositoryFullName: normalizeRepoFullName(context.repositoryFullName),
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
    // PLN-1535 M3: keep measured authors fresh; missing author reads preserve.
    authorLogin: measuredAuthorLogin(pullRequest),
    authorProviderUserId: pullRequest.authorProviderUserId,
    authorActorType: pullRequest.authorActorType,
    verifiedAt: context.now,
    headRepositoryObservation:
      pullRequestHeadRepositoryObservation(pullRequest),
    closedAt: pullRequest.closedAt ? new Date(pullRequest.closedAt) : null,
    mergedAt: pullRequest.mergedAt ? new Date(pullRequest.mergedAt) : null,
    mergeCommitSha: pullRequest.mergeCommitSha ?? null,
    fetchProvenance: {
      credentialType: fetchCredentialTypeFromKind(context.credentialKind),
      credentialOwnerId: context.credentialOwnerId,
      mechanism: GitHubFetchMechanism.Graphql,
      trigger: context.fetchTrigger ?? GitHubFetchTrigger.Backfill,
      observedAt: context.now,
      resultReason: GitHubSyncResultReason.Success,
    },
  };
}

/**
 * The exact detail payload this lane hands Prisma, as ONE named composition.
 *
 * `setCurrent: false` is the reconciler's contract rather than a caller's
 * choice — it is a data-freshness lane and must never promote a row to its
 * branch's current PR. Composed at the call site, a second caller could build
 * the same input without it and a parity arm could measure a payload no lane
 * actually writes.
 *
 * Both reconcile tiers land here — the repo sweep and the PRD-683
 * session-linked targeted sync — so neither can drift from the other on the PR
 * columns a reader sees.
 */
export function reconciledPullRequestDetailData(
  pullRequest: GitHubReadModelPullRequest,
  context: ReconcileContext
): Prisma.PullRequestDetailUncheckedUpdateInput {
  return buildPullRequestDetailUpdate(
    buildReconcileProjectionInput(pullRequest, context),
    { setCurrent: false }
  );
}

/**
 * ISS-8919: resolve PR numbers to their projection rows in ONE read.
 *
 * This lane used to resolve identity one PR at a time, so a tick writing N rows
 * opened N pool checkouts and issued N single-row SELECTs before writing
 * anything. Both reconcile loops write a whole fetched page, and a draining repo
 * fills it to `RECONCILE_MAX_ITEMS` (200), so the per-row read cost up to 200
 * checkouts and 200 SELECTs per repo per tick before a single row was written.
 * (ISS-7891 did NOT change that ceiling: it cut the page SIZE 100 -> 25 and
 * raised the page COUNT 3 -> 8 to keep the same 200 items, trading round trips
 * for GitHub's ~10s GraphQL budget. The read below is worth batching on the
 * standing 200, not on any increase.)
 *
 * This is now the lane's ONLY identity predicate. The refresh lane, the failure
 * lane, and the single-PR fallback all compose it, so "the rows these PR numbers
 * name" cannot drift between them; they differ only in what they do with the
 * rows, which is why this returns rows and `resolveReconcileTargets`
 * below narrows them to one per number.
 *
 * Two identity modes. App-repo rows key on the (repositoryId, number) unique,
 * which is exact — one row per number. Repo-less tier-2 rows resolve on
 * (normalized full name, number) WHERE repository_id IS NULL; the partial unique
 * already guarantees at most one, and `id ASC` keeps the tie-break deterministic
 * for any row predating it. Neither mode filters `isCurrent`: a superseded row
 * (flipped by desktop-sync or the shared projection writer when a newer PR
 * became the branch's current) still holds merged lifecycle/LOC the metric
 * needs, and this reconciler is the ONLY refresh path for tier-2 rows.
 *
 * BOTH modes filter `organizationId`. The retired tier-1 `findUnique` did not,
 * because it reached its row by a globally-unique key; a read that can return
 * many rows is the wrong place to relax org scoping, and the failure lane
 * already scoped both tiers this way. `PullRequestDetail.organizationId` is a
 * denormalized copy, so the one set this excludes is a row whose stored org
 * disagrees with its repository's — which this lane must skip, not refresh.
 *
 * Repository-history genesis is retired: a number with no row here is skipped,
 * never created. So a caller must pass every number it intends to write, or a
 * missing row silently becomes a skipped PR.
 */
async function readReconcileTargetRows(
  numbers: readonly number[],
  context: Pick<
    ReconcileContext,
    "organizationId" | "repositoryId" | "repositoryFullName"
  >
): Promise<ReconcileTarget[]> {
  const distinct = [...new Set(numbers)];
  if (distinct.length === 0) {
    return [];
  }
  const scope = context.repositoryId
    ? { repositoryId: context.repositoryId }
    : {
        repositoryFullName: normalizeRepoFullName(context.repositoryFullName),
        repositoryId: null,
      };
  const rows = await withDb((db) =>
    db.pullRequestDetail.findMany({
      where: {
        organizationId: context.organizationId,
        ...scope,
        number: { in: distinct },
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        number: true,
        branchArtifact: {
          select: {
            branch: { select: { branchName: true, repositoryFullName: true } },
          },
        },
        branchArtifactId: true,
        githubUpdatedAt: true,
      },
    })
  );
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    filedBranch: row.branchArtifact.branch,
    branchArtifactId: row.branchArtifactId,
    githubUpdatedAt: row.githubUpdatedAt,
  }));
}

/**
 * The refresh lane's view of that read: at most one row per number.
 *
 * The refresh lane updates a number's ONE current projection row, so it needs a
 * number-keyed map and takes the lowest id on the tie. The failure lane
 * deliberately does NOT go
 * through this: it records an observation on every row it matched, and
 * collapsing duplicates there would silently drop observations the previous
 * behaviour wrote.
 */
export async function resolveReconcileTargets(
  numbers: readonly number[],
  context: Pick<
    ReconcileContext,
    "organizationId" | "repositoryId" | "repositoryFullName"
  >
): Promise<ReadonlyMap<number, ReconcileTarget>> {
  const rows = await readReconcileTargetRows(numbers, context);
  const byNumber = new Map<number, ReconcileTarget>();
  for (const row of rows) {
    if (!byNumber.has(row.number)) {
      byNumber.set(row.number, row);
    }
  }
  return byNumber;
}
function measuredAuthorLogin(
  pullRequest: Pick<
    GitHubReadModelPullRequest,
    "author" | "authorActorType" | "authorProviderUserId"
  >
): string | null | undefined {
  if (
    pullRequest.authorProviderUserId === null ||
    pullRequest.authorActorType === null
  ) {
    return pullRequest.author;
  }
  return pullRequest.author ?? undefined;
}

type ReconcileTarget = {
  filedBranch: PullRequestFiling["branch"];
  id: string;
  number: number;
  branchArtifactId: string | null;
  githubUpdatedAt: Date | null;
};
