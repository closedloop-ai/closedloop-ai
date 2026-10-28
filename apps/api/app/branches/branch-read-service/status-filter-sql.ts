import { BranchStatus } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import { Prisma } from "@repo/database";
import { selectedObservedAssociatedPullRequestExists } from "../branch-associated-pull-request-sql";

export type BranchFilterStatus =
  | typeof BranchStatus.Open
  | typeof BranchStatus.Merged
  | typeof BranchStatus.Closed
  | typeof BranchStatus.Draft;

/**
 * Maps a displayed Branch status to the candidate predicate used by list rows
 * and totals. Existing status semantics remain intact; specifically, the
 * Merged local-status fallback applies only when no associated PR is selected.
 *
 * Every arm below reads the OBSERVED selection, never the bare one: ISS-8422
 * lets an unwitnessed PR be selected so the branch keeps its link, and the
 * projection derives that branch as having no connected PR. Reading the bare
 * selection here would file such a row under a status its own card contradicts.
 */
export function branchCandidateStatusClause(
  status: BranchFilterStatus
): Prisma.Sql {
  switch (status) {
    case BranchStatus.Draft:
      return selectedObservedAssociatedPullRequestExists([
        Prisma.sql`pr.is_draft = TRUE`,
      ]);
    case BranchStatus.Merged:
      return Prisma.sql`(
        ${selectedObservedAssociatedPullRequestExists([
          Prisma.sql`pr.is_draft = FALSE`,
          Prisma.sql`(
            pr.pr_state = ${GitHubPRState.Merged}::"GitHubPRState"
            OR pr.merged_at IS NOT NULL
          )`,
        ])}
        OR (
          a.status = ${GitHubPRState.Merged}
          AND NOT ${selectedObservedAssociatedPullRequestExists()}
        )
      )`;
    case BranchStatus.Closed:
      return Prisma.sql`(
        ${selectedObservedAssociatedPullRequestExists([
          Prisma.sql`pr.is_draft = FALSE`,
          Prisma.sql`pr.pr_state = ${GitHubPRState.Closed}::"GitHubPRState"`,
          Prisma.sql`pr.merged_at IS NULL`,
        ])}
        OR (
          a.status = ${GitHubPRState.Closed}
          AND (
            NOT ${selectedObservedAssociatedPullRequestExists()}
            OR ${selectedObservedAssociatedPullRequestExists([
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
          ${selectedObservedAssociatedPullRequestExists([
            Prisma.sql`pr.is_draft = FALSE`,
            Prisma.sql`pr.pr_state NOT IN (
              ${GitHubPRState.Merged}::"GitHubPRState",
              ${GitHubPRState.Closed}::"GitHubPRState"
            )`,
            Prisma.sql`pr.merged_at IS NULL`,
          ])}
          OR (
            a.status <> ${GitHubPRState.Merged}
            AND NOT ${selectedObservedAssociatedPullRequestExists()}
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
