import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { unverifiedOpenPullRequestWhere } from "@/lib/pull-request-invariant-audit-population";
import {
  RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS,
  RECONCILE_UNVERIFIED_PULL_REQUEST_BATCH,
} from "./constants";

/**
 * ISS-12272: OPEN rows that no GitHub read has ever landed on
 * (`unverifiedOpenPullRequestWhere`), for the INSTALLED tier's by-number
 * refresh.
 *
 * A desktop session that names an already-closed PR syncs a median 7.4 days
 * after the close (ISS-12164), and the row it inserts reads OPEN from the
 * column default. Before this arm, nothing on the installed tier re-read such
 * a row:
 *   - the window read stops at the watermark, and a long-closed PR's
 *     `updatedAt` is already behind it;
 *   - self-heal needs `merged_at` or `closed_at`;
 *   - the coverage-gap arm needs `NOT is_current`;
 *   - the desktop-stub arm runs only on the user-token tier.
 *
 * A successful read sets `github_updated_at`, so a row leaves this arm after
 * one read. A number the provider returns nothing for is stamped by the caller
 * and waits out the ordinary attempt debounce before it is tried again.
 */
export async function selectUnverifiedPullRequestTargets(input: {
  organizationId: string;
  repositoryId: string | null;
  repositoryFullName: string;
  now: Date;
}): Promise<number[]> {
  const staleBefore = new Date(
    input.now.getTime() - RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS
  );
  // The write's own scope (`readReconcileTargetRows`): a row selected here
  // that the write cannot reach would be re-selected on every sweep.
  const repoScope = input.repositoryId
    ? { repositoryId: input.repositoryId }
    : {
        repositoryId: null,
        repositoryFullName: normalizeRepoFullName(input.repositoryFullName),
      };
  const rows = await withDb((db) =>
    db.pullRequestDetail.findMany({
      where: {
        organizationId: input.organizationId,
        ...repoScope,
        // ANDed whole rather than spread, as `selectSelfHealTargets` keeps its
        // debounce: a key the shared predicate gains (an `OR` of its own) would
        // otherwise be overwritten here and widen the population it declares.
        AND: [
          unverifiedOpenPullRequestWhere(),
          {
            OR: [
              { lastRefreshAttemptAt: null },
              { lastRefreshAttemptAt: { lt: staleBefore } },
            ],
          },
        ],
      },
      select: { number: true },
      orderBy: [
        { lastRefreshAttemptAt: { sort: "asc", nulls: "first" } },
        { id: "asc" },
      ],
      take: RECONCILE_UNVERIFIED_PULL_REQUEST_BATCH,
    })
  );
  const pullRequestNumbers = rows.map((row) => row.number);
  if (pullRequestNumbers.length > 0) {
    // ISS-12272: Perrin's AC2 ruling takes the evidence for the backlog drain
    // from this pass's logs.
    log.info("[reconcile-pull-requests] unverified pull requests selected", {
      organizationId: input.organizationId,
      repositoryFullName: input.repositoryFullName,
      pullRequestNumbers,
    });
  }
  return pullRequestNumbers;
}
