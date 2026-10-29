import type { Prisma } from "@repo/database";
import { VERIFIED_BRANCH_PUSH_SOURCES } from "./cloud-branch-eligibility";

/**
 * ISS-8148 (PRD-683 Ruling 2 + D7): the Prisma-shape push-evidence predicate
 * for peripheral Branch surfaces — the agent-component detail attribution
 * reads — that query through the Prisma client rather than the raw candidate
 * SQL. (The insights branch-population donuts read the Branches list's own
 * candidate population since ISS-11915.) A branch has push evidence
 * when a verified push stamped it, or when a PR row is keyed to THIS branch
 * (a PR implies its head was pushed — the same standard the session ingest
 * gate applies on the write side, `hasBranchPushEvidence`).
 *
 * The PR arm scans `pull_request_detail` rows by `branchArtifactId`, exactly
 * like the canonical SQL's EXISTS. The current-PR POINTER is deliberately NOT
 * trusted: the schema does not constrain `currentPullRequestDetailId` to the
 * owning branch, so a corrupt pointer could admit a local-only branch (see
 * the ownership doctrine in `apps/api/lib/resolve-pr-context.ts`).
 *
 * Deliberately WEAKER than `verifiedBranchPublicationSql` (no provider-bound
 * head verification): every row the two predicates disagree on still carries
 * push evidence, which is the axis D7 excludes on. List and metric surfaces
 * keep the canonical strict SQL predicates in `cloud-branch-eligibility.ts`.
 *
 * Exclude-not-delete (PRD-683 D7): a row failing this keeps its row and its
 * session links and reappears the moment push evidence lands.
 */
export function branchPushEvidenceWhere(): Prisma.BranchDetailWhereInput {
  return {
    OR: [
      {
        firstPushedAt: { not: null },
        pushSource: { in: [...VERIFIED_BRANCH_PUSH_SOURCES] },
      },
      { artifact: { pullRequestDetails: { some: {} } } },
    ],
  };
}
