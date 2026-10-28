import {
  Prisma,
  type PrismaClient,
  PullRequestCommentLaneStatus,
} from "@repo/database";
import { REQUIRED_PULL_REQUEST_COMMENT_LANES } from "@/app/comments/service/github/github-comment-acquisition-proof";

/**
 * The single definition of "PR-comment proof incomplete" for one Branch, shared
 * by the Branches-list SQL and the JS reader so list, detail and batch agree.
 *
 * True when the Branch has an associated pull request whose `COMPLETE` rows over
 * the required lanes number fewer than the required lanes. A lane never fetched
 * has no row and so counts as incomplete; a lane whose latest attempt failed,
 * hit a ceiling or shifted is not `COMPLETE` (latest attempt wins, no clock
 * expiry). A Branch with no pull requests is complete. Both the pull request and
 * every proof row are scoped to `organizationId`.
 *
 * `organizationId` and `branchId` are SQL operands supplied by the host: column
 * references in the list LATERAL, bound parameters in the JS reader.
 */
export function pullRequestCommentProofIncompleteSql(input: {
  organizationId: Prisma.Sql;
  branchId: Prisma.Sql;
}): Prisma.Sql {
  const requiredLanes = Prisma.join(
    REQUIRED_PULL_REQUEST_COMMENT_LANES.map(
      (lane) => Prisma.sql`${lane}::"PullRequestCommentLane"`
    )
  );
  return Prisma.sql`EXISTS (
    SELECT 1 FROM pull_request_detail proof_pr
    WHERE proof_pr.organization_id = ${input.organizationId}
      AND proof_pr.branch_artifact_id = ${input.branchId}
      AND (
        SELECT count(*) FROM pull_request_comment_acquisitions proof
        WHERE proof.pull_request_detail_id = proof_pr.id
          AND proof.organization_id = ${input.organizationId}
          AND proof.status = ${PullRequestCommentLaneStatus.COMPLETE}::"PullRequestCommentLaneStatus"
          AND proof.lane IN (${requiredLanes})
      ) < ${REQUIRED_PULL_REQUEST_COMMENT_LANES.length}
  )`;
}

/**
 * The Branch IDs, of those given, whose PR-comment proof is incomplete, in one
 * statement over the shared predicate. Runs on the caller's client, so it reads
 * inside the caller's transaction or snapshot.
 */
export async function readPullRequestCommentProof(
  db: Pick<PrismaClient, "$queryRaw">,
  organizationId: string,
  branchIds: readonly string[]
): Promise<Set<string>> {
  if (branchIds.length === 0) {
    return new Set();
  }
  const rows = await db.$queryRaw<{ branchId: string }[]>(Prisma.sql`
    SELECT scoped.branch_id AS "branchId"
    FROM unnest(${[...branchIds]}::uuid[]) AS scoped(branch_id)
    WHERE ${pullRequestCommentProofIncompleteSql({
      organizationId: Prisma.sql`${organizationId}::uuid`,
      branchId: Prisma.sql`scoped.branch_id`,
    })}
  `);
  return new Set(rows.map((row) => row.branchId));
}
