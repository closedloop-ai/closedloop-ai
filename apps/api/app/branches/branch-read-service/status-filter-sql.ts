import { BranchStatus } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import { Prisma } from "@repo/database";
import { selectedAssociatedPullRequestExists } from "../branch-associated-pull-request-sql";

export type BranchFilterStatus =
  | typeof BranchStatus.Open
  | typeof BranchStatus.Merged
  | typeof BranchStatus.Closed
  | typeof BranchStatus.Draft;

/**
 * Maps a displayed Branch status to the candidate predicate used by list rows
 * and totals. Existing status semantics remain intact; specifically, the
 * Merged local-status fallback applies only when no associated PR is selected.
 */
export function branchCandidateStatusClause(
  status: BranchFilterStatus
): Prisma.Sql {
  switch (status) {
    case BranchStatus.Draft:
      return selectedAssociatedPullRequestExists([
        Prisma.sql`pr.is_draft = TRUE`,
      ]);
    case BranchStatus.Merged:
      return Prisma.sql`(
        ${selectedAssociatedPullRequestExists([
          Prisma.sql`pr.is_draft = FALSE`,
          Prisma.sql`(
            pr.pr_state = ${GitHubPRState.Merged}::"GitHubPRState"
            OR pr.merged_at IS NOT NULL
          )`,
        ])}
        OR (
          a.status = ${GitHubPRState.Merged}
          AND NOT ${selectedAssociatedPullRequestExists()}
        )
      )`;
    case BranchStatus.Closed:
      return Prisma.sql`(
        ${selectedAssociatedPullRequestExists([
          Prisma.sql`pr.is_draft = FALSE`,
          Prisma.sql`pr.pr_state = ${GitHubPRState.Closed}::"GitHubPRState"`,
          Prisma.sql`pr.merged_at IS NULL`,
        ])}
        OR (
          a.status = ${GitHubPRState.Closed}
          AND (
            NOT ${selectedAssociatedPullRequestExists()}
            OR ${selectedAssociatedPullRequestExists([
              Prisma.sql`pr.is_draft = FALSE`,
              Prisma.sql`pr.pr_state <> ${GitHubPRState.Merged}::"GitHubPRState"`,
              Prisma.sql`pr.merged_at IS NULL`,
            ])}
          )
        )
      )`;
    case BranchStatus.Open:
      return Prisma.sql`(
        a.status <> ${GitHubPRState.Closed}
        AND (
          ${selectedAssociatedPullRequestExists([
            Prisma.sql`pr.is_draft = FALSE`,
            Prisma.sql`pr.pr_state NOT IN (
              ${GitHubPRState.Merged}::"GitHubPRState",
              ${GitHubPRState.Closed}::"GitHubPRState"
            )`,
            Prisma.sql`pr.merged_at IS NULL`,
          ])}
          OR (
            a.status <> ${GitHubPRState.Merged}
            AND NOT ${selectedAssociatedPullRequestExists()}
          )
        )
      )`;
    default:
      return unsupportedBranchStatusClause(status);
  }
}

function unsupportedBranchStatusClause(_status: never): Prisma.Sql {
  return Prisma.sql`FALSE`;
}
