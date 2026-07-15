import type { BranchPushSource } from "@repo/api/src/types/artifact";
import type { TransactionClient } from "@repo/database";

/**
 * Stamp explicit push evidence on an already-resolved branch row, set-once /
 * earliest-wins (PRD-510 FR2, PLN-1099 Phase 2). For producers that own the
 * branch row OUTSIDE the `upsertBranchArtifact` write path — the desktop session
 * lane (`persistSessionBranchArtifactLinks`, `pushSource: session`), the branch
 * write service's own update path, and the PR `synchronize` head advance
 * (`pushSource: webhook`). The EARLIEST verified push wins, a later push never
 * overwrites it, and push state is NEVER derived from `headShaSource` or from row
 * existence (a synced row means "observed", not "pushed" — PRD-510 D3).
 *
 * The WHERE guard advances `firstPushedAt` only from null or a strictly-later
 * stamp, so `pushSource` moves in lockstep with the winning timestamp and
 * out-of-order/duplicate deliveries converge on one stamp. No-op when the branch
 * row is absent or the timestamp is missing/invalid.
 *
 * Lives in its own module (type-only imports) so the desktop-sync ingest lane —
 * which reaches this through the Socket.IO gateway entrypoint that runs under
 * `tsx`, outside Next.js — can call it without dragging in the branch service's
 * `server-only` transitive dependencies (guarded by `smoke-desktop-gateway-import`).
 */
export async function stampBranchFirstPush(
  tx: TransactionClient,
  branchArtifactId: string,
  pushedAt: Date | null | undefined,
  pushSource: BranchPushSource
): Promise<void> {
  if (!pushedAt || Number.isNaN(pushedAt.getTime())) {
    return;
  }
  await tx.branchDetail.updateMany({
    where: {
      artifactId: branchArtifactId,
      OR: [{ firstPushedAt: null }, { firstPushedAt: { gt: pushedAt } }],
    },
    data: { firstPushedAt: pushedAt, pushSource },
  });
}

/**
 * Advance a branch's `lastActivityAt` to `activityAt` when it is genuinely newer
 * (monotonic GREATEST) — the shared writer for real git/GitHub activity (a
 * pushed commit, a PR open/merge/close, a review). No-op when the branch row is
 * absent or the timestamp is missing/invalid.
 *
 * Lives here alongside `stampBranchFirstPush` for the same reason: the
 * desktop-sync ingest lane calls it from the tsx Socket.IO gateway entrypoint
 * and must not drag in the branch service's `server-only` transitive deps
 * (guarded by `smoke-desktop-gateway-import`). The webhook handlers import it
 * directly from this module (there is no `branch-service` re-export).
 */
export async function bumpBranchActivity(
  tx: TransactionClient,
  branchArtifactId: string,
  activityAt: Date | null | undefined
): Promise<void> {
  if (!activityAt || Number.isNaN(activityAt.getTime())) {
    return;
  }
  await tx.branchDetail.updateMany({
    where: {
      artifactId: branchArtifactId,
      OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: activityAt } }],
    },
    data: { lastActivityAt: activityAt },
  });
}
