import { ArtifactType, Prisma, withDb } from "@repo/database";
import { branchContributorExistsSql } from "@/app/branches/branch-contribution-sql";

/**
 * Hard bound on how many anchor artifacts one assignee-scoped tree read walks.
 *
 * The anchors are the seed set for BOTH graph walks, so an unbounded anchor
 * count is an unbounded server workload and an unbounded `IN` predicate
 * (wongk, PR #4461). The cap is deliberately far above a realistic personal
 * queue — a user with more than this many open anchors is already past the
 * point where a single flat tree is a usable surface — and crossing it is
 * reported through `TreeTruncation`, never silently absorbed.
 */
export const MAX_TREE_ANCHORS = 500;

/**
 * The two task streams My Tasks is built from, resolved server-side.
 *
 * `assigneeId` alone is NOT the scope this page had: the per-project fan-out it
 * replaces asked each project tree for `contributorUserId`, which brought back
 * branches the user has commit authorship on. Branches rarely carry an
 * assignee, so an assignee-only scope empties the Branches stream entirely and
 * tells a branch-only user their queue is clear (closedloop-ai-stage, PR
 * #4461). Both streams anchor the walk so neither disappears.
 */
export type TreeAnchors = {
  /** Anchor ids, capped at {@link MAX_TREE_ANCHORS}. */
  ids: string[];
  /**
   * A FLOOR on how many anchors matched. Equal to `ids.length` when the cap did
   * not bind; otherwise `MAX_TREE_ANCHORS + 1`, the overflow probe, which is
   * why it is named as a floor rather than a total.
   */
  matchedAtLeast: number;
};

/**
 * Resolve the anchor set for one assignee in one query.
 *
 * Ordering is `created_at DESC, id ASC` — deterministic, and when the cap binds
 * it keeps the most recent work rather than an arbitrary page. Org scoping is
 * in the predicate, not applied afterwards.
 */
export async function resolveTreeAnchors(
  assigneeId: string,
  organizationId: string
): Promise<TreeAnchors> {
  const rows = await withDb((db) =>
    db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT a.id
      FROM artifacts a
      WHERE a.organization_id = ${organizationId}::uuid
        AND (
          a.assignee_id = ${assigneeId}::uuid
          OR (
            a.type = ${ArtifactType.BRANCH}::"ArtifactType"
            AND ${branchContributorExistsSql(assigneeId)}
          )
        )
      ORDER BY a.created_at DESC, a.id ASC
      LIMIT ${MAX_TREE_ANCHORS + 1}
    `)
  );

  if (rows.length <= MAX_TREE_ANCHORS) {
    return { ids: rows.map((row) => row.id), matchedAtLeast: rows.length };
  }
  // One extra row was requested purely to detect the overflow, so this is a
  // FLOOR, not an exact count. Reporting it as an exact total would be the
  // plausible-but-wrong number the repo's bad-data rule forbids; the caller
  // pairs it with an explicit truncation reason so it is never read as exact.
  return {
    ids: rows.slice(0, MAX_TREE_ANCHORS).map((row) => row.id),
    matchedAtLeast: rows.length,
  };
}
