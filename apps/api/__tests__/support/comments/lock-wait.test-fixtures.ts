import { type TransactionClient, withDb } from "@repo/database";

/** How the pending call stood when {@link untilSettledOrBlockedBy} returned. */
export const PendingCallState = {
  Settled: "settled",
  /** A backend waits on a lock the holder's transaction holds. */
  Blocked: "blocked",
} as const;
export type PendingCallState =
  (typeof PendingCallState)[keyof typeof PendingCallState];

/** How long the pending call gets to either finish or queue behind a lock. */
const SETTLE_BOUND_MS = 10_000;
const POLL_INTERVAL_MS = 25;

/** The backend a transaction runs on, read inside it. */
export async function backendPid(
  tx: Pick<TransactionClient, "$queryRaw">
): Promise<number> {
  const rows = await tx.$queryRaw<{ pid: number }[]>`
    SELECT pg_backend_pid() AS pid
  `;
  const pid = rows[0]?.pid;
  if (pid === undefined) {
    throw new Error("pg_backend_pid returned no row");
  }
  return pid;
}

async function isBlockingAnyone(holderPid: number): Promise<boolean> {
  const rows = await withDb(
    (db) => db.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting
      FROM pg_stat_activity
      WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))
    `
  );
  return (rows[0]?.waiting ?? 0) > 0;
}

/**
 * Resolves once `pending` has settled or a backend waits on a lock held by the
 * transaction on `holderPid`, so a test can release the holder knowing the
 * call reached it. Only the holder's own waiters count: a lock wait elsewhere
 * in the cluster says nothing about this call.
 */
export async function untilSettledOrBlockedBy(
  pending: Promise<unknown>,
  holderPid: number
): Promise<PendingCallState> {
  let settled = false;
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  const deadline = Date.now() + SETTLE_BOUND_MS;
  while (Date.now() < deadline) {
    if (settled) {
      return PendingCallState.Settled;
    }
    if (await isBlockingAnyone(holderPid)) {
      return PendingCallState.Blocked;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error("the call neither finished nor queued behind the holder");
}
