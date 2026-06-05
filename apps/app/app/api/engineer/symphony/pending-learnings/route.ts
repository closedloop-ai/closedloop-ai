import { getWorktreesWithPendingLearnings } from "@/lib/engineer/repos";

/**
 * GET /api/engineer/symphony/pending-learnings
 *
 * Returns the total count of pending learning files across all worktrees.
 * Cheap synchronous filesystem scan.
 */
export function GET() {
  const worktrees = getWorktreesWithPendingLearnings();
  const totalCount = worktrees.reduce((sum, w) => sum + w.pendingCount, 0);

  return Response.json({
    totalCount,
    worktreeCount: worktrees.length,
  });
}
