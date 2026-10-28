import { ArtifactType } from "@repo/api/src/types/artifact";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import { GitHubPRState, Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS } from "./constants";
import {
  coverageGapRepositoryScopeSql,
  sessionLinkEvidenceSql,
} from "./session-linked-targets";

/**
 * ISS-12292 (Perrin's ruling, 2026-10-09): OPEN rows on a USER-TOKEN-tier repo
 * that carry no session link, for the targeted tier's by-number read.
 *
 * The targeted tier reads only `selectSessionLinkedPullRequestTargets`
 * (PRD-683 Ruling 1), so once the tier-2 history sweep retired nothing re-read
 * an OPEN row outside `sessionLinkEvidenceSql`: prod held 10 on rtk-ai/rtk,
 * closed on GitHub between 2026-09-06 and 10-05. This arm only refreshes rows
 * that exist; it creates none and promotes none. The complement is
 * `IS NOT TRUE`, not `NOT`: the evidence predicate can be NULL when
 * `fetch_mechanism` is NULL, and `NOT` of NULL is NULL, which would drop that
 * row from both arms.
 *
 * Scoped like the write (`readReconcileTargetRows`), or a row the write cannot
 * reach is re-selected every sweep. The caller's token was drawn by
 * `getGitHubSyncClient` for this same `organizationId`, so a row is only read
 * with its own org's credential.
 *
 * Batch (`limit`): the caller passes the room the session-linked targets
 * leave in one point-read request (`GITHUB_PULL_REQUEST_BY_NUMBER_BATCH_SIZE`),
 * so this arm never adds a request. Prod, read-only, 2026-10-09 03:33Z: 17
 * such rows, one org, 8 repos, at most 10 on one repo (rtk-ai/rtk, whose only
 * rows are these, so its room is the full 25); none on a branch created after
 * the week of 2026-07-20 (0/day for ~75 days); each of the 188 user_token repos
 * is swept every <= 4.55 h. One sweep reads a repo's whole backlog. A repo
 * whose session-linked batch is full on every sweep leaves no room, and its
 * unlinked rows wait. The debounce is the 24 h every by-number arm uses.
 */
export async function selectUnlinkedOpenPullRequestTargets(input: {
  organizationId: string;
  repositoryId: string | null;
  repositoryFullName: string;
  now: Date;
  limit: number;
}): Promise<{ pullRequestDetailId: string; number: number }[]> {
  const repositoryFullName = normalizeRepoFullName(input.repositoryFullName);
  const staleBefore = new Date(
    input.now.getTime() - RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS
  );
  const rows = await withDb((db) =>
    db.$queryRaw<{ id: string; number: number }[]>(Prisma.sql`
      SELECT prd.id, prd.number
      FROM pull_request_detail prd
      INNER JOIN artifacts branch
        ON branch.id = prd.branch_artifact_id
        AND branch.organization_id = ${input.organizationId}::uuid
        AND branch.type = ${ArtifactType.Branch}::"ArtifactType"
      WHERE prd.organization_id = ${input.organizationId}::uuid
        AND ${coverageGapRepositoryScopeSql(input.repositoryId, repositoryFullName)}
        AND prd.pr_state = ${GitHubPRState.OPEN}::"GitHubPRState"
        AND (
          prd.last_refresh_attempt_at IS NULL
          OR prd.last_refresh_attempt_at < ${staleBefore}
        )
        AND (${sessionLinkEvidenceSql(input.organizationId, repositoryFullName)}) IS NOT TRUE
      ORDER BY prd.last_refresh_attempt_at ASC NULLS FIRST, prd.id ASC
      LIMIT ${input.limit}
    `)
  );
  if (rows.length > 0) {
    // ISS-12292 AC3: the post-deploy evidence that the arm reached its rows.
    log.info("[reconcile-pull-requests] unlinked open pull requests selected", {
      organizationId: input.organizationId,
      repositoryFullName: input.repositoryFullName,
      pullRequestNumbers: rows.map((row) => row.number),
    });
  }
  return rows.map((row) => ({
    pullRequestDetailId: row.id,
    number: row.number,
  }));
}
