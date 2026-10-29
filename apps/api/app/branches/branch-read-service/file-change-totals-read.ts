import type { PrismaClient } from "@repo/database";
import { chunksOf } from "@/lib/chunks-of";

/**
 * One branch's file-cache diff totals, folded by the database.
 *
 * ISS-10298: the list, detail, and analytics reads all wanted three numbers out
 * of `branch_file_changes` and were each loading up to 500 ROWS PER BRANCH to
 * compute them — an aggregate paying a row projection (`apps/api/AGENTS.md` →
 * Query Shape and Route Gates). On the `pageMode=server` list that is the whole
 * eligible corpus before 25 rows are kept: measured locally at 781 branches × 40
 * cached files, the relation load was 104.4ms of a 230.0ms page and this fold is
 * 14.6ms.
 *
 * `additions`/`deletions` PRESERVE COMPLETENESS exactly as the in-memory fold
 * this replaced did: a `null` per-file count means that file's LOC never
 * enriched, so the branch total is not a trustworthy enriched size and the whole
 * dimension reads `null` rather than a sum over the files that did enrich.
 * Coercing the missing count to 0 would synthesize an enriched-looking total
 * that `isLocEnriched` accepts, letting a partial cache masquerade as a real
 * size.
 *
 * `fileCount` is the RAW row count, not a LOC dimension: it stays `0` for a
 * branch with no cached files (where both sums read `null`), so it stays
 * comparable against the stored `fileCacheFileCount` — an empty-but-fresh cache
 * must compare equal to a stored count of zero. (The publication-LOC reader that
 * made that comparison, `hasCompleteCloudLocCache`, went with ISS-10009 part 2.)
 *
 * `headSha` is WHICH head these rows describe, and it is what makes reading them
 * from a SECOND statement safe. The relation load this replaced came out of the
 * same `findFirst`/`findMany` as `fileCacheHeadSha`, so the two were mutually
 * consistent by construction; two statements are not, and the detail read
 * (`getBranchDetail`) runs under a plain `withDb` rather than the list's
 * RepeatableRead snapshot. A `refreshBranchFileChangeCache` committing between
 * them would otherwise hand `currentFileTotals` the NEW head's rows while the
 * row still says the cache is current for the OLD one, and the branch would
 * report a size it does not have — the exact lie that gate exists to prevent.
 * `null` means the rows did not agree on one head (a refresh mid-flight), which
 * reads as unknown rather than as a total summed across two different diffs.
 */
export type BranchFileChangeTotals = {
  additions: number | null;
  deletions: number | null;
  fileCount: number;
  headSha: string | null;
};

type BranchFileChangeTotalsClient = Pick<PrismaClient, "branchFileChange">;

/**
 * Bind-parameter bound for the id predicate (`apps/api/AGENTS.md` → Bound every
 * predicate). Matches `BRANCH_ROW_HYDRATION_BATCH_SIZE` so the totals read is
 * chunked in step with the hydration whose ids it is keyed off.
 */
export const BRANCH_FILE_CHANGE_TOTALS_ID_CHUNK_SIZE = 2000;

/**
 * A branch with no usable file-change cache: unavailable LOC, not a zero total.
 *
 * Frozen because it is assigned BY REFERENCE into every such row of a request —
 * on a 781-branch page that is one object identity shared hundreds of ways, and
 * an in-place write through any of them would rewrite the constant for the rest
 * of the process.
 */
export const EMPTY_BRANCH_FILE_CHANGE_TOTALS: BranchFileChangeTotals =
  Object.freeze({
    additions: null,
    deletions: null,
    fileCount: 0,
    headSha: null,
  });

/**
 * Fold every cached file-change row for the given branches into per-branch
 * totals, in ONE grouped statement per id chunk, with the chunks concurrent.
 *
 * Deliberately UNBOUNDED in rows scanned, where the relation loads it replaced
 * took a fixed slice: `refreshBranchFileChangeCache` deletes a branch's rows
 * before writing one compare's worth, and `branchFileChangePersistenceCap`
 * refuses a provider limit above that slice, so a branch cannot hold more rows
 * than those `take`s admitted — the population is the same one, folded in the
 * database instead of in JavaScript.
 *
 * Org-scoped through the branch's artifact, matching the scope the hydration
 * this accompanies applies, so an id that is not the caller's simply yields no
 * group and reads as unavailable LOC.
 */
export async function getBranchFileChangeTotals(
  db: BranchFileChangeTotalsClient,
  organizationId: string,
  branchIds: readonly string[]
): Promise<Map<string, BranchFileChangeTotals>> {
  if (branchIds.length === 0) {
    return new Map();
  }
  const chunks = await Promise.all(
    chunksOf(branchIds, BRANCH_FILE_CHANGE_TOTALS_ID_CHUNK_SIZE).map((ids) =>
      db.branchFileChange.groupBy({
        by: ["branchArtifactId", "headSha"],
        where: {
          branchArtifactId: { in: ids },
          branch: { artifact: { organizationId } },
        },
        _sum: { additions: true, deletions: true },
        _count: { _all: true, additions: true, deletions: true },
      })
    )
  );
  return foldGroups(chunks.flat());
}

type BranchFileChangeGroup = {
  branchArtifactId: string;
  headSha: string;
  _sum: { additions: number | null; deletions: number | null };
  _count: { _all: number; additions: number; deletions: number };
};

/**
 * One entry per branch. A branch that came back with rows for MORE THAN ONE head
 * is mid-refresh, so which head its cache describes is not knowable from here —
 * it takes the unknown exit rather than a total summed across two diffs.
 */
function foldGroups(
  groups: readonly BranchFileChangeGroup[]
): Map<string, BranchFileChangeTotals> {
  const totals = new Map<string, BranchFileChangeTotals>();
  for (const group of groups) {
    totals.set(
      group.branchArtifactId,
      totals.has(group.branchArtifactId)
        ? EMPTY_BRANCH_FILE_CHANGE_TOTALS
        : totalsFromGroup(group)
    );
  }
  return totals;
}

function totalsFromGroup(group: BranchFileChangeGroup): BranchFileChangeTotals {
  return {
    additions: sumWhenComplete(
      group._sum.additions,
      group._count.additions,
      group._count._all
    ),
    deletions: sumWhenComplete(
      group._sum.deletions,
      group._count.deletions,
      group._count._all
    ),
    fileCount: group._count._all,
    headSha: group.headSha,
  };
}

/**
 * The database's `SUM` skips `NULL`s, so the sum alone cannot tell a complete
 * cache from a partial one. Comparing the non-null count against the row count
 * is what reproduces the all-or-nothing fold: any un-enriched file makes the
 * whole dimension unavailable.
 */
function sumWhenComplete(
  sum: number | null,
  nonNullCount: number,
  rowCount: number
): number | null {
  if (rowCount === 0 || nonNullCount !== rowCount) {
    return null;
  }
  return sum ?? 0;
}
