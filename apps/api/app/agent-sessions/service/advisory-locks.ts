import type { TransactionClient } from "@repo/database";

/**
 * Acquires BOTH the legacy 32-bit and new 64-bit per-session advisory locks in
 * a fixed old-then-new order for deploy-transition safety (PRD-536 D12).
 *
 * The two locks are acquired in separate sequential statements so PostgreSQL
 * cannot reorder them within a single SELECT list — concurrent transactions
 * always acquire in the same order and cannot deadlock.
 */
export async function acquireSessionAdvisoryLocks(
  tx: TransactionClient,
  externalSessionId: string
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${externalSessionId}))`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${externalSessionId}, 0::bigint))`;
}
