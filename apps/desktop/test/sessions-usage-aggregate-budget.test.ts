/**
 * ISS-10573: the desktop Sessions usage aggregate must survive a store thread
 * held by an op it does not own, and must never hand a raw driver error to the
 * `desktop:shared-agent-sessions:usage` handler.
 *
 * Driven through `createSqliteSessionSyncSource(...).aggregateUsage`, the
 * production entry point the IPC handler reaches, over a fake store thread — a
 * real 120s budget is not reproducible in a suite, and `no-timing-assertions`
 * forbids writing one. The fake models the one fact that matters:
 * `TRANSACTION_TIMEOUT_MS` is WALL CLOCK, so any check-phase boundary inside the
 * transaction lets a queued foreign op run and spend the budget.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  markStoreReadCancelled,
  runStoreReadUnderCancellation,
} from "../src/main/database/db-host/store-read-cancellation.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { USAGE_AGGREGATE_UNAVAILABLE_MESSAGE } from "../src/main/database/session-usage-aggregate.js";
import { createSqliteSessionSyncSource } from "../src/main/database/sync-source.js";
import {
  READ_CANCELLED_ERROR_MESSAGE,
  READ_CANCELLED_ERROR_NAME,
} from "../src/shared/read-cancellation-contract.js";
import { DB_HOST_EXITED_SIGNATURE } from "../src/shared/transient-db-host-error.js";
import { initGitRepoWithOrigin } from "./attribution-test-helpers.js";

/**
 * Prisma's own wording, verbatim from the 2026-09-17 guest-mode report. Written
 * as a literal because the truth is the driver's, not ours — a fixture built
 * from our own constant would agree with our own mistake.
 */
const EXPIRED_TRANSACTION_MESSAGE =
  "Transaction API error: A query cannot be executed on an expired transaction. The timeout for this transaction was 120000 ms, however 297052 ms passed since the start of the transaction.";

/** The operand validation and grouped reads inside one usage snapshot. */
const USAGE_AGGREGATE_STATEMENT_COUNT = 7;

type StoreThreadFake = {
  prisma: DesktopPrisma;
  statements: string[];
  trace: string[];
};

/**
 * A store thread with one foreign op queued behind this read. The op takes the
 * thread at the first check-phase boundary the transaction reaches and returns
 * it only after the whole budget is gone, so the next statement inside the
 * transaction faults exactly as Prisma's does.
 */
function createStoreThreadFake(): StoreThreadFake {
  const statements: string[] = [];
  const trace: string[] = [];
  let insideTransaction = false;
  let budgetSpent = false;

  const tx = {
    $queryRawUnsafe: (sql: string) => {
      if (budgetSpent) {
        throw new Error(EXPIRED_TRANSACTION_MESSAGE);
      }
      statements.push(sql);
      return Promise.resolve([]);
    },
  };
  const reader = {
    $transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => {
      insideTransaction = true;
      trace.push("tx-open");
      setImmediate(() => {
        if (insideTransaction) {
          budgetSpent = true;
        }
      });
      try {
        return await fn(tx);
      } finally {
        insideTransaction = false;
        trace.push("tx-close");
      }
    },
  };
  const prisma = {
    read: <T>(fn: (client: typeof reader) => Promise<T>) => fn(reader),
    write: () => Promise.reject(new Error("aggregateUsage must not write")),
  };
  return {
    prisma: prisma as unknown as DesktopPrisma,
    statements,
    trace,
  };
}

function createRejectingSource(error: unknown, log: (message: string) => void) {
  const prisma = {
    read: () => Promise.reject(error),
    write: () => Promise.reject(error),
  };
  return createSqliteSessionSyncSource(prisma as unknown as DesktopPrisma, log);
}

/** The rejection `run` produced, or `null` when it resolved. */
async function captureRejection(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return null;
}

test("usage aggregate keeps its cooperative yield outside the snapshot transaction", async () => {
  const { prisma, statements, trace } = createStoreThreadFake();
  const logged: string[] = [];
  const source = createSqliteSessionSyncSource(prisma, (message) =>
    logged.push(message)
  );

  // Queued BEFORE the read, so it runs at the first check-phase boundary the
  // aggregate reaches. Landing before `tx-open` is the retained FEA-2264 /
  // ISS-9802 checkpoint; landing between `tx-open` and `tx-close` is the defect.
  setImmediate(() => trace.push("loop-turn"));
  const aggregate = await source.aggregateUsage?.({});

  assert.deepEqual(trace, ["loop-turn", "tx-open", "tx-close"]);
  assert.equal(statements.length, USAGE_AGGREGATE_STATEMENT_COUNT);
  assert.equal(aggregate?.totalSessions, 0);
  assert.deepEqual(logged, []);
});

test("a failed usage aggregate rejects with the sanitized message, not the driver error", async () => {
  const logged: string[] = [];
  const source = createRejectingSource(
    new Error(EXPIRED_TRANSACTION_MESSAGE),
    (message) => logged.push(message)
  );

  const error = await captureRejection(() => source.aggregateUsage?.({}));

  assert.ok(error instanceof Error);
  assert.equal(error.message, USAGE_AGGREGATE_UNAVAILABLE_MESSAGE);
  assert.equal(error.message.includes("Transaction API error"), false);
  assert.equal(logged.length, 1);
  assert.ok(logged[0]?.includes(EXPIRED_TRANSACTION_MESSAGE));
});

test("a cancelled usage aggregate rejects unchanged so the caller abort stays classified", async () => {
  const cancelled = new Error(READ_CANCELLED_ERROR_MESSAGE);
  cancelled.name = READ_CANCELLED_ERROR_NAME;
  const logged: string[] = [];
  const source = createRejectingSource(cancelled, (message) =>
    logged.push(message)
  );

  const error = await captureRejection(() => source.aggregateUsage?.({}));

  assert.equal(error, cancelled);
  assert.equal(logged.length, 0);
});

test("a db-host lifecycle failure rejects unchanged so the transient classification survives", async () => {
  const transient = new Error(`${DB_HOST_EXITED_SIGNATURE} (code: 0)`);
  const logged: string[] = [];
  const source = createRejectingSource(transient, (message) =>
    logged.push(message)
  );

  const error = await captureRejection(() => source.aggregateUsage?.({}));

  assert.equal(error, transient);
  assert.equal(logged.length, 0);
});

/** Repo the fixture's `origin` resolves to, and the value the fill-back writes. */
const FILL_BACK_REPO = "acme/fill-back-repo";

/** Only the repo-count statement of the six projects `repo_full_name`. */
const REPO_COUNT_STATEMENT_MARKER = "AS repo_full_name";

/** The bounds statement is the snapshot's LAST, so a cancel here closes with it. */
const LAST_SNAPSHOT_STATEMENT_MARKER = "AS earliest_session_at";

type SnapshotFake = {
  prisma: DesktopPrisma;
  /** `repo_full_name` each fill-back UPDATE carried, in order. */
  writes: string[];
};

/**
 * A store thread that serves the snapshot and records every fill-back write. The
 * one repo row has no stored name and a cwd that still exists, which is what
 * makes the fold live-resolve it and issue the write. `onStatement` is where a
 * test posts a cancel mid-snapshot.
 */
function createSnapshotFake(
  repoCwd: string,
  onStatement?: (sql: string) => void
): SnapshotFake {
  const writes: string[] = [];
  const tx = {
    $queryRawUnsafe: (sql: string) => {
      onStatement?.(sql);
      return Promise.resolve(
        sql.includes(REPO_COUNT_STATEMENT_MARKER)
          ? [{ cwd: repoCwd, repo_full_name: null, session_count: 2 }]
          : []
      );
    },
  };
  const reader = {
    $transaction: <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx),
  };
  const writer = {
    $executeRawUnsafe: (_sql: string, repoFullName: string) => {
      writes.push(repoFullName);
      return Promise.resolve(1);
    },
  };
  const prisma = {
    read: <T>(fn: (client: typeof reader) => Promise<T>) => fn(reader),
    write: <T>(fn: (client: typeof writer) => Promise<T>) => fn(writer),
  };
  return { prisma: prisma as unknown as DesktopPrisma, writes };
}

test("a cancel raised during the snapshot is observed before the repo probes and the fill-back write", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss10573-cancel-fold-"));
  const repoDir = path.join(dir, "repo");
  try {
    await mkdir(repoDir, { recursive: true });
    initGitRepoWithOrigin(repoDir, FILL_BACK_REPO);

    // Positive control on the same fixture and the same write hook: uncancelled,
    // the fold live-resolves the repo and DOES issue the fill-back UPDATE. Without
    // it the absence assertion below would pass against a hook that never fires.
    const control = createSnapshotFake(repoDir);
    const controlSource = createSqliteSessionSyncSource(control.prisma, () => {
      // control run must stay silent; the cancelled run below asserts that.
    });
    const controlAggregate = await runStoreReadUnderCancellation(
      "iss10573-uncancelled-control",
      async () => await controlSource.aggregateUsage?.({})
    );

    assert.deepEqual(control.writes, [FILL_BACK_REPO]);
    assert.deepEqual(controlAggregate?.repoSessionCounts, [
      { repositoryFullName: FILL_BACK_REPO, sessionCount: 2 },
    ]);

    // A DISTINCT token: `markStoreReadCancelled` remembers pre-cancelled tokens
    // process-wide, so reusing the control's would cancel it retroactively.
    const token = "iss10573-cancelled-during-snapshot";
    const cancelled = createSnapshotFake(repoDir, (sql) => {
      if (sql.includes(LAST_SNAPSHOT_STATEMENT_MARKER)) {
        markStoreReadCancelled(token);
      }
    });
    const logged: string[] = [];
    const source = createSqliteSessionSyncSource(cancelled.prisma, (message) =>
      logged.push(message)
    );

    const error = await captureRejection(() =>
      runStoreReadUnderCancellation(
        token,
        async () => await source.aggregateUsage?.({})
      )
    );

    // The write first: it is the half that outlives the abandoned read.
    assert.deepEqual(
      cancelled.writes,
      [],
      "the superseded read must not reach the fill-back write"
    );
    assert.ok(error instanceof Error);
    assert.equal(error.name, READ_CANCELLED_ERROR_NAME);
    assert.deepEqual(logged, [], "a caller abort is not an aggregate failure");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
