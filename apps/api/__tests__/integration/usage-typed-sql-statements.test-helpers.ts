/**
 * Shared fixtures for the `usage-typed-sql-statements*.integration.test.ts`
 * suites — split out (AGENTS.md's 1,000-line file ceiling) so both files build
 * the same session/branch/project shapes from one source rather than two.
 */
import { randomUUID } from "node:crypto";
import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { GitHubPRState } from "@repo/api/src/types/github";
import { withDb } from "@repo/database";
import type { UsageSqlFacetCount } from "@/app/agent-sessions/service/usage-sql-reader";

/** An unbounded window, so a case that is not about the window states so. */
export function wholeOrg(organizationId: string) {
  return { organizationId, start: null, end: null };
}

/**
 * The dimension columns `createTestSessionDetail` does not take. It hard-codes
 * `harness` and leaves `repository_full_name` and `model` null, which is the
 * right default for its many callers but would leave three of the four
 * non-project arms indistinguishable here.
 */
export async function stampSession(
  sessionArtifactId: string,
  columns: {
    harness?: string;
    repositoryFullName?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    errorCount?: number;
  }
): Promise<void> {
  await withDb((db) =>
    db.sessionDetail.update({
      where: { artifactId: sessionArtifactId },
      data: columns,
      // The row is discarded, so narrow `RETURNING *` to the primary key.
      select: { artifactId: true },
    })
  );
}

/**
 * Attach a session to a project the way the product does: a RELATES_TO link
 * whose TARGET is a DOCUMENT carrying a project. The session artifact's own
 * `project_id` is deliberately NOT used — session artifacts are unparented, so
 * keying the facet on it would leave the branch permanently empty.
 */
export async function linkSessionToProject(params: {
  organizationId: string;
  sessionArtifactId: string;
  projectId: string;
  label: string;
}): Promise<void> {
  await withDb(async (db) => {
    const doc = await db.artifact.create({
      data: {
        organizationId: params.organizationId,
        type: ArtifactType.Document,
        name: `doc-${params.label}-${randomUUID().slice(0, 8)}`,
        status: "ACTIVE",
        projectId: params.projectId,
      },
      select: { id: true },
    });
    await db.artifactLink.create({
      data: {
        organizationId: params.organizationId,
        sourceId: params.sessionArtifactId,
        targetId: doc.id,
        linkType: LinkType.RelatesTo,
      },
      select: { id: true },
    });
  });
}

/** Monotonic PR numbers, so no two fixture PRs collide on the partial index. */
let prNumberSeq = 0;
function nextPrNumber(): number {
  prNumberSeq += 1;
  return prNumberSeq;
}

const MERGED_AT = new Date("2026-06-10T00:00:00Z");
const LAST_VERIFIED_AT = new Date("2026-06-11T00:00:00Z");

/**
 * One row per conjunct of the numerator's merged-PR predicate (ISS-9904).
 *
 * Each non-`merged` shape fails exactly ONE conjunct and satisfies the others,
 * which is what makes the conjuncts separately mutation-visible. Without that
 * they mask one another: an open PR carries no merge timestamp either, so
 * deleting `pr_state` OR `merged_at` would leave the case passing.
 */
export const PR_SHAPES = {
  merged: {
    prState: GitHubPRState.Merged,
    mergedAt: true,
    lastVerified: true,
  },
  open: { prState: GitHubPRState.Open, mergedAt: false, lastVerified: true },
  /** Merge timestamp WITHOUT the merged state — isolates `pr_state`. */
  "closed-with-merged-at": {
    prState: GitHubPRState.Closed,
    mergedAt: true,
    lastVerified: true,
  },
  /** Merged state WITHOUT the timestamp — isolates `merged_at IS NOT NULL`. */
  "merged-no-timestamp": {
    prState: GitHubPRState.Merged,
    mergedAt: false,
    lastVerified: true,
  },
  /** Merged but never re-verified — isolates `last_verified_at IS NOT NULL`. */
  "merged-unverified": {
    prState: GitHubPRState.Merged,
    mergedAt: true,
    lastVerified: false,
  },
} as const;

/**
 * A BRANCH artifact carrying a MERGED pull request.
 *
 * The merged PR is not optional decoration. Since ISS-9904 the coverage
 * numerator requires the linked branch to carry one, because the cohort is
 * meant to be the sessions whose PRs produced the lines this card divides —
 * not every session that happens to hold a delivery link. A branch without one
 * contributes nothing to `numeratorSessionCount`, so a fixture that omitted it
 * would turn every numerator assertion in this file into a silent zero.
 *
 * The PR's fields mirror `sessionMergedPrLoc.sql`'s admission predicate
 * (MERGED, `merged_at`, `last_verified_at`), which is what the numerator's
 * EXISTS now checks.
 */
export async function createTestBranchArtifact(
  organizationId: string,
  label: string,
  /**
   * What pull request the branch carries. `merged` is the default because every
   * other case in this file needs a numerator-eligible branch; the remaining
   * shapes — the four non-merged entries in {@link PR_SHAPES} plus `none` —
   * exist so the ISS-9904 case can seed the branches that must NOT count.
   */
  pullRequest: keyof typeof PR_SHAPES | "none" = "merged"
): Promise<string> {
  return await withDb(async (db) => {
    const branch = await db.artifact.create({
      data: {
        organizationId,
        // PullRequestDetail is nested state on BranchDetail, so there is no PR
        // artifact type — a session->PR link targets a BRANCH.
        type: ArtifactType.Branch,
        name: `branch-${label}-${randomUUID().slice(0, 8)}`,
        status: "ACTIVE",
      },
      select: { id: true },
    });
    if (pullRequest !== "none") {
      // `closed-with-merged-at` carries a merge timestamp WITHOUT the merged
      // state — the shape that isolates the `pr_state` half of the predicate
      // from the `merged_at IS NOT NULL` half. Realistic rather than contrived:
      // GitHub reports a merged PR as closed, so a row whose normalised state
      // lags its timestamp looks exactly like this.
      // ONE SHAPE PER CONJUNCT of the numerator's merged-PR predicate, so each
      // can be mutated away and caught on its own. Without them the conjuncts
      // mask one another: an open PR with no merge timestamp is excluded twice
      // over, so deleting either check leaves the case passing.
      const shape = PR_SHAPES[pullRequest];
      await db.pullRequestDetail.create({
        data: {
          organizationId,
          branchArtifactId: branch.id,
          // A FRESH NUMBER PER CALL, because `pull_request_detail` carries
          // UNIQUE (organization_id, repository_full_name, number)
          // WHERE repository_id IS NULL — and these fixtures never set a
          // repository_id, so every one of them lands inside that partial
          // index. With a hardcoded `1` the row was unique only because the
          // labels happened to differ, which made label uniqueness a silent
          // precondition of the helper: reuse one in the same org and you got a
          // constraint error instead of the second branch you asked for
          // (marisolashgrove on #6969).
          number: nextPrNumber(),
          repositoryFullName: `acme/${label}`,
          prState: shape.prState,
          mergedAt: shape.mergedAt ? MERGED_AT : null,
          additions: 40,
          deletions: 2,
          isCurrent: true,
          lastVerifiedAt: shape.lastVerified ? LAST_VERIFIED_AT : null,
        },
        select: { id: true },
      });
    }
    return branch.id;
  });
}

/**
 * Every row an arm produced, by dimension. Named for the common assertion (the
 * four non-project arms must collapse to ONE row) but it returns the whole set —
 * the project arm legitimately returns several, which the fan-out case relies on.
 */
export function arm(
  rows: readonly UsageSqlFacetCount[],
  dimension: UsageSqlFacetCount["dimension"]
): UsageSqlFacetCount[] {
  return rows.filter((row) => row.dimension === dimension);
}
