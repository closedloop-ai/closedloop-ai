import "server-only";

import { Prisma, withDb } from "@repo/database";

/** Run a Product Branch read on one bounded repeatable-read database snapshot. */
export function withBranchProductReadSnapshot<Result>(
  _organizationId: string,
  read: (db: BranchProductReadSnapshotClient) => Promise<Result>,
  workload: BranchProductReadWorkload = BranchProductReadWorkload.Bounded
): Promise<Result> {
  const budget = branchProductReadBudgetByWorkload[workload];
  return withDb.tx(read, {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    maxWait: budget.maxWait,
    timeout: budget.timeout,
  });
}

type BranchProductReadSnapshotClient = Parameters<
  Parameters<typeof withDb.tx>[0]
>[0];

export const BranchProductReadWorkload = {
  Bounded: "bounded",
  FullCorpus: "full_corpus",
} as const;

export type BranchProductReadWorkload =
  (typeof BranchProductReadWorkload)[keyof typeof BranchProductReadWorkload];

export const BRANCH_PRODUCT_READ_SNAPSHOT_MAX_WAIT_MS = 2000;
/**
 * ISS-10295: raised from 15s. The read did not get slower — the database got
 * busier. ISS-9831 re-grained the analytics rollup from one row per session
 * LIFETIME to one row per session per UTC day, and the every-5-minute sweep
 * that writes it drove RDS to 97-99% CPU at 26k-53k rows inserted/s. Under that
 * load this snapshot expired mid-read and `/branches` 500d: 674 expired-
 * transaction errors in 24h, with measured overruns of 15,721ms and 30,593ms.
 * 45s clears the worst observed overrun with headroom; the sweep pressure that
 * makes a bounded read take this long is the sibling half of ISS-10295.
 */
export const BRANCH_PRODUCT_READ_SNAPSHOT_BOUNDED_TIMEOUT_MS = 45_000;
/**
 * ISS-10300: a full-corpus read is strictly the heavier of the two workloads,
 * so it cannot share the bounded deadline. It reads the org's whole branch
 * corpus and then aggregates per-branch session usage over it, where a bounded
 * read stops at one page's worth of hydration. Measured against production on
 * 2026-09-15: 781 branches, and a 25-row server page already costs 5.14s on an
 * UNSATURATED database (the whole-corpus scan behind that page is ISS-10298,
 * not this ticket). The bounded path's worst observed overrun under the
 * ISS-10295 sweep load was 30,593ms — roughly 6x its unsaturated cost — and 45s
 * was chosen to clear it. Doubling to 90s gives the heavier workload the same
 * kind of headroom over its own larger baseline instead of borrowing the
 * lighter one's, while still bounding how long a single read may hold a
 * repeatable-read snapshot open against that sweep.
 */
export const BRANCH_PRODUCT_READ_SNAPSHOT_FULL_CORPUS_TIMEOUT_MS = 90_000;

/**
 * `maxWait` is deliberately shared: it bounds how long the read queues for a
 * connection, which is a property of pool contention and not of how much work
 * the read does once it has one. Only the execution budget splits.
 */
const branchProductReadBudgetByWorkload = {
  [BranchProductReadWorkload.Bounded]: {
    maxWait: BRANCH_PRODUCT_READ_SNAPSHOT_MAX_WAIT_MS,
    timeout: BRANCH_PRODUCT_READ_SNAPSHOT_BOUNDED_TIMEOUT_MS,
  },
  [BranchProductReadWorkload.FullCorpus]: {
    maxWait: BRANCH_PRODUCT_READ_SNAPSHOT_MAX_WAIT_MS,
    timeout: BRANCH_PRODUCT_READ_SNAPSHOT_FULL_CORPUS_TIMEOUT_MS,
  },
} satisfies Record<
  BranchProductReadWorkload,
  { maxWait: number; timeout: number }
>;
