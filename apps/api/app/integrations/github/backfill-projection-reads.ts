import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import type { GitHubReadModelPullRequest } from "@repo/api/src/types/github-read-model";
import type { TransactionClient } from "@repo/database";
import { repoLessProjectionRowWhere } from "@/app/branches/github-projection-writer";
import type {
  LifecycleBranch,
  LifecyclePullRequest,
} from "./backfill-lifecycle-projection-diff";
import type { pullRequestProjectionWouldChange } from "./backfill-projection-diff-counter";
import { collectHeadBranches } from "./backfill-projection-helpers";
import {
  type TrackedRepositorySelector,
  trackedRepositorySelector,
} from "./tracked-repository-selector";

/**
 * The branch and pull-request rows the backfill projection reads before it
 * compares or writes, for BOTH halves of `backfill-projection-writer.ts`.
 *
 * One owner is the point (ISS-9116): the dry run and the write answer the
 * operator's "what will change" and then make it happen, so a branch predicate
 * that drifts between the two turns a preview into a promise the approval
 * cannot keep. The dry run's own `pullRequestDetail.findMany` deliberately did
 * NOT move here — it carries this lane's allowlisted exemption from the
 * `pull-request-population-declaration` gate, which is pinned to that file.
 */

export type BackfillProjectionReadScope = {
  organizationId: string;
  repository: {
    /** `GitHubInstallationRepository.id`, or null on the repo-less lane. */
    id: string | null;
    /** Provider casing; every predicate built from it normalizes first. */
    fullName: string;
  };
};

/**
 * Which rows this repository owns, in the one form both identities are allowed
 * to be written as. An App-lane repo keys on the installation-repo surrogate; a
 * repo-less one on the normalized full name. Hand-writing `{ repositoryId }`
 * here would return zero rows for an installation-free org, which reads as
 * "nothing to project" rather than as a wrong predicate.
 */
export function backfillRepositorySelector(
  repository: BackfillProjectionReadScope["repository"]
): TrackedRepositorySelector {
  return trackedRepositorySelector({
    repositoryId: repository.id,
    repositoryFullName: repository.fullName,
  });
}

export type BackfillBranch = NonNullable<
  Awaited<ReturnType<typeof findBackfillBranch>>
>;

/**
 * The order both branch reads resolve an ambiguous name in.
 *
 * `artifactId` is `BranchDetail`'s primary key, so it totally orders any set of
 * candidate rows. Load-bearing rather than cosmetic: see
 * `loadBackfillBranchesByName` for the duplicate this exists to make
 * deterministic.
 */
const BACKFILL_BRANCH_CANONICAL_ORDER = { artifactId: "asc" } as const;

/**
 * The branch columns backfill actually consumes, for BOTH shapes.
 *
 * One constant rather than two literals is the whole point: the singular and
 * batched reads are meant to be equivalent, and a select that drifted between
 * them would hand one caller a column the other lacks through the same
 * `BackfillBranch` type — the divergence class the ordering contract above
 * already exists to prevent, one layer down. `BranchDetail` carries ~50
 * columns; every one omitted here is one no backfill transaction pays for.
 *
 * The `satisfies` bound puts the failure HERE. Every column below is also read
 * by direct property access somewhere downstream, and no `as` cast launders
 * these rows, so dropping one already fails the build — but at whichever call
 * site happens to touch it, which is not where the mistake was made.
 */
const backfillBranchSelect = {
  artifactId: true,
  branchName: true,
  baseBranch: true,
  baseBranchSource: true,
  checksStatus: true,
  currentPullRequestDetailId: true,
  headSha: true,
  lastActivityAt: true,
} as const satisfies SelectCovering<LifecycleBranch>;

/** One branch projection row by provider head-branch name. */
export function findBackfillBranch(
  db: TransactionClient,
  scope: BackfillProjectionReadScope,
  branchName: string
) {
  return db.branchDetail.findFirst({
    where: { ...backfillBranchScopeWhere(scope), branchName },
    orderBy: BACKFILL_BRANCH_CANONICAL_ORDER,
    select: backfillBranchSelect,
  });
}

/**
 * The same branch rows `findBackfillBranch` resolves one at a time, for a whole
 * payload, keyed by the name the caller looks them up under.
 *
 * On the repo-less lane `(organizationId, repositoryFullName, branchName)` is
 * unique, so a name maps to at most one row. The App lane keys on
 * `repositoryId`, which NO unique constraint pairs with `branchName` — a repo
 * rename can leave two rows a `{ repositoryId, branchName }` predicate both
 * matches. Both shapes therefore order by `artifactId` and take the FIRST row,
 * so an ambiguous name resolves to one row for the whole sweep (cr-6598): the
 * batch seeds `resolve`, and `findBackfillBranch` re-serves the same name after
 * `markWritten`, so a disagreement between them would let one backfill attach
 * the second PR to a different historical branch than the first — and flip
 * `currentPullRequestDetailId` on the wrong row. Unordered, `findMany` kept the
 * LAST row and `findFirst` picked whatever the planner returned.
 */
export async function loadBackfillBranchesByName(
  db: TransactionClient,
  scope: BackfillProjectionReadScope,
  pullRequests: readonly GitHubReadModelPullRequest[]
): Promise<Map<string, BackfillBranch>> {
  const branchNames = collectHeadBranches(pullRequests);
  if (branchNames.length === 0) {
    return new Map();
  }
  // No `include: { currentPullRequestDetail: true }`: every consumer reads the
  // scalar `currentPullRequestDetailId` that is already on this row, and the
  // join dragged a PR row — `body` is `@db.Text` — behind each of up to 500
  // branches inside the transaction this change exists to shorten.
  const branches = await db.branchDetail.findMany({
    where: {
      ...backfillBranchScopeWhere(scope),
      branchName: { in: branchNames },
    },
    orderBy: BACKFILL_BRANCH_CANONICAL_ORDER,
    select: backfillBranchSelect,
  });
  const branchesByName = new Map<string, BackfillBranch>();
  for (const branch of branches) {
    // FIRST wins, not last: ordered ascending, the first row for a name is the
    // one `findBackfillBranch`'s `findFirst` returns under the same order.
    if (!branchesByName.has(branch.branchName)) {
      branchesByName.set(branch.branchName, branch);
    }
  }
  return branchesByName;
}

export type ExistingPullRequestTarget = { number: number; githubId: string };

/**
 * The PR columns backfill actually consumes, for BOTH arms below AND for the
 * dry run's own batched read in `backfill-projection-writer.ts`.
 *
 * Both arms return through ONE signature, so a caller cannot tell which
 * produced its row: a column selected on the App arm and missed on the
 * repo-less one would be present or `undefined` depending on whether the org
 * has an installation, which no consumer checks. Exported rather than copied so
 * the dry run compares the same columns the write path compares — a preview
 * built from a different row shape is the "promise the approval cannot keep"
 * this module's docstrings already guard against elsewhere.
 *
 * `body` (`@db.Text`) and the ~40 `headRepository*`/`fetch*`/provenance columns
 * are deliberately absent: nothing on either path reads them, and the write
 * path holds a provider advisory lock across a whole 500-item payload.
 */
export const backfillPullRequestSelect = {
  id: true,
  number: true,
  branchArtifactId: true,
  githubId: true,
  title: true,
  htmlUrl: true,
  prState: true,
  isDraft: true,
  reviewDecision: true,
  additions: true,
  deletions: true,
  changedFiles: true,
  githubCreatedAt: true,
  closedAt: true,
  mergedAt: true,
  mergeCommitSha: true,
} as const satisfies SelectCovering<LifecyclePullRequest> &
  SelectCovering<Parameters<typeof pullRequestProjectionWouldChange>[0]>;

export type ExistingPullRequestDetail = NonNullable<
  Awaited<ReturnType<typeof findExistingPullRequestDetail>>
>;

/**
 * The identity row for one incoming PR, on the WRITE path.
 *
 * The App lane keeps its `(repositoryId, number)` unique lookup untouched. The
 * repo-less lane has no such unique that Prisma can express — its partial index
 * is raw-migration-only — so it borrows the shared writer's OWN predicate
 * rather than approximating it. That sharing is the point (#6038 review): this
 * lookup decides whether the PR is skipped, and the shared writer then
 * re-resolves independently, so any drift between the two makes the skip a lie
 * — a row found here and missed there reaches a create path that refuses a null
 * `repositoryId` and throws, taking the whole repository's sweep with it.
 */
export function findExistingPullRequestDetail(
  db: TransactionClient,
  scope: BackfillProjectionReadScope,
  target: ExistingPullRequestTarget
) {
  const repositoryId = scope.repository.id;
  if (repositoryId) {
    return db.pullRequestDetail.findUnique({
      where: { repositoryId_number: { repositoryId, number: target.number } },
      select: backfillPullRequestSelect,
    });
  }
  return db.pullRequestDetail.findFirst({
    where: repoLessProjectionRowWhere({
      organizationId: scope.organizationId,
      repositoryFullName: normalizeRepoFullName(scope.repository.fullName),
      number: target.number,
      githubId: target.githubId,
    }),
    orderBy: { id: "asc" },
    select: backfillPullRequestSelect,
  });
}

export type BackfillProjectionReads = {
  /**
   * The branch and PR rows for one incoming PR. The branch comes from the
   * payload-wide read while that read is still authoritative, and from the
   * per-branch read once this transaction has written to that branch.
   */
  resolve(pullRequest: GitHubReadModelPullRequest): Promise<{
    branch: BackfillBranch | null;
    existing: ExistingPullRequestDetail | null;
  }>;
  /** Retire the payload-wide rows this iteration is about to invalidate. */
  markWritten(written: {
    pullRequest: GitHubReadModelPullRequest;
    branch: BackfillBranch;
    existing: ExistingPullRequestDetail | null;
  }): void;
};

/**
 * The write path's branch reads, batched across the payload but invalidated per
 * branch.
 *
 * One read answers a whole payload, but only while it remains true: the write
 * loop updates the branch row (`branchName`, `baseBranch`, `headSha`,
 * `checksStatus`, `currentPullRequestDetailId`) and later iterations READ those
 * columns back. A payload carrying two PRs off one head branch — an open one
 * and a closed one, which backfill routinely fetches together — would otherwise
 * compare the second against a snapshot taken before the first was written and
 * report a different diff than the per-PR read does. So a branch this loop has
 * already written falls back to exactly the statement it issued before, and only
 * first occurrences are served from the batch. Invalidation is by branch
 * ARTIFACT id as well as by name, because the shared writer also mutates the
 * PR's CURRENT branch — relinking off it, and on the App lane adopting it into
 * this repository — and that row is reachable from no head-branch name. An
 * empty head branch takes the same fallback because the batched read cannot
 * represent it, and so does a MISS after any write, because an adoption can add
 * a row the up-front batched read was scoped to exclude.
 *
 * The PR identity read is NOT batched, and that is a gate decision rather than
 * an oversight: a set-shaped `pullRequestDetail` read in `apps/api` must
 * declare a sanctioned population (`pull-request-population-declaration`), and
 * resolving one incoming provider PR to its projection row belongs to none of
 * them. See ISS-9116.
 */
export async function openBackfillProjectionReads(
  tx: TransactionClient,
  scope: BackfillProjectionReadScope,
  pullRequests: readonly GitHubReadModelPullRequest[]
): Promise<BackfillProjectionReads> {
  const branchesByName = await loadBackfillBranchesByName(
    tx,
    scope,
    pullRequests
  );
  const writtenHeadBranches = new Set<string>();
  const writtenBranchArtifactIds = new Set<string>();

  return {
    async resolve(pullRequest) {
      const cached = branchesByName.get(pullRequest.headBranch);
      const reread =
        pullRequest.headBranch.length === 0 ||
        writtenHeadBranches.has(pullRequest.headBranch) ||
        (cached === undefined
          ? writtenBranchArtifactIds.size > 0
          : writtenBranchArtifactIds.has(cached.artifactId));
      const branch = reread
        ? await findBackfillBranch(tx, scope, pullRequest.headBranch)
        : (cached ?? null);
      // Short-circuited where the write loop's own skip was: a payload naming a
      // branch this org does not track never cost a PR lookup.
      if (!branch) {
        return { branch: null, existing: null };
      }
      return {
        branch,
        existing: await findExistingPullRequestDetail(tx, scope, {
          number: pullRequest.number,
          githubId: pullRequest.githubId,
        }),
      };
    },
    markWritten({ pullRequest, branch, existing }) {
      writtenHeadBranches.add(pullRequest.headBranch);
      writtenBranchArtifactIds.add(branch.artifactId);
      // The PR's CURRENT branch, which is a different row from the one this
      // iteration looked up whenever the incoming head branch moved. The shared
      // writer relinks off it and the App lane adopts it into this repository,
      // and neither mutation is reachable from a head-branch name — a later
      // payload entry landing on that row would otherwise be compared against a
      // snapshot taken before those writes.
      if (existing?.branchArtifactId) {
        writtenBranchArtifactIds.add(existing.branchArtifactId);
      }
    },
  };
}

function backfillBranchScopeWhere(scope: BackfillProjectionReadScope) {
  return {
    ...backfillRepositorySelector(scope.repository),
    artifact: { organizationId: scope.organizationId },
  };
}

/**
 * A `select` that must cover at least `TRequired`'s keys, and may cover more.
 *
 * The trailing index signature is what allows the "more": without it the
 * literal's extra columns read as excess properties and the constraint rejects
 * the very selects it exists to guard. What it buys is the other direction —
 * dropping a required key fails at this constant instead of somewhere
 * downstream, or nowhere at all where a structural sink would simply accept the
 * narrower row.
 */
type SelectCovering<TRequired> = Record<keyof TRequired, true> &
  Record<string, true>;
