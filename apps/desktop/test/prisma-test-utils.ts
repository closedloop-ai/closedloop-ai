/**
 * @file prisma-test-utils.ts
 * @description Shared helpers for the desktop Prisma tests. Builds the Prisma
 * factory over an ephemeral on-disk libSQL database whose schema is created by
 * the SAME migration runner the production boot uses, and reuses the PRODUCTION
 * `createWriteQueue` so the test queue can't drift from the real one.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BASELINE_MIGRATIONS,
  LEGACY_SCHEMA_REASSERT_SEQUENCE,
} from "../src/main/database/migration/baseline-schema.js";
import {
  openMigrationDatabase,
  type SqliteClient,
} from "../src/main/database/migration/migration-executor.js";
import { runDesktopMigrations } from "../src/main/database/migration/migration-runner.js";
import { MIGRATIONS } from "../src/main/database/migration/migrations-manifest.js";
import {
  type CreateDesktopPrismaOptions,
  createDesktopPrisma,
  type DesktopPrisma,
  type WriteSerializer,
} from "../src/main/database/prisma-client.js";
import {
  createWriteQueue,
  type WriteQueueRunOptions,
} from "../src/main/database/write-queue.js";
import type {
  ReadRunner,
  WriteRunner,
} from "../src/main/scheduler/sqlite-task-store.js";

/**
 * The production write queue wrapped with a `runs` counter so tests can assert
 * that work was routed through it. Delegates to the real `createWriteQueue`.
 */
export function makeRecordingQueue(): WriteSerializer & { runs: number } {
  const inner = createWriteQueue();
  const queue = {
    runs: 0,
    run<T>(
      fn: () => Promise<T>,
      token?: string,
      opts?: WriteQueueRunOptions
    ): Promise<T> {
      queue.runs += 1;
      // Forward the ISS-4572 owner token + ISS-4710 fairness class so the wrapped
      // queue behaves exactly like the production one.
      return inner.run(fn, token, opts);
    },
  };
  return queue;
}

export type OpenTestPrisma = {
  db: SqliteClient;
  prisma: DesktopPrisma;
  close: () => Promise<void>;
};

/**
 * Minimal raw-query handle for seeding tables in conversion tests (the store
 * write paths that aren't converted yet still take this shape). The libSQL
 * `db` from {@link openTestPrisma} satisfies it.
 */
export type RawDb = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
};

/**
 * Open an ephemeral on-disk libSQL database (schema created via the production
 * migration runner) with the Prisma factory wired over it. Pass a queue (e.g.
 * {@link makeRecordingQueue}) to assert routing; defaults to the production
 * `createWriteQueue`.
 */
export async function openTestPrisma(
  queue: WriteSerializer = createWriteQueue(),
  options?: CreateDesktopPrismaOptions
): Promise<OpenTestPrisma> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "prisma-test-"));
  const { db, config } = await openMigrationDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  await runDesktopMigrations(db, {
    migrations: MIGRATIONS,
    baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
    baselineMigrations: BASELINE_MIGRATIONS,
  });
  const prisma = await createDesktopPrisma(config, queue, options);
  return {
    db,
    prisma,
    close: async () => {
      await prisma.disconnect();
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Fixed clock shared by the scheduler store/service tests so cron/next-run math
 * and the "due now" window are deterministic. 10s past the minute boundary: for a
 * 1-minute cron the jitter cap is 6s (period*0.1), so `now` is safely past
 * `slot + jitter` and an every-minute task is unambiguously due on the tick.
 */
export const SCHEDULER_TEST_NOW = new Date("2026-07-22T12:00:10.000Z");

/** The write/read/clock seams a `SqliteTaskStore` needs, over a test Prisma. */
export type SchedulerStoreTestDeps = {
  write: WriteRunner;
  read: ReadRunner;
  now: () => Date;
};

/**
 * Build the `SqliteTaskStore` dependency bundle over a test Prisma with the fixed
 * {@link SCHEDULER_TEST_NOW} clock. Shared by the scheduler store/service and the
 * native-scheduler test suites so the store wiring cannot drift between them.
 */
export function schedulerStoreDeps(
  prisma: DesktopPrisma
): SchedulerStoreTestDeps {
  return {
    write: (fn) => prisma.write(fn),
    read: (fn) => prisma.read(fn),
    now: () => SCHEDULER_TEST_NOW,
  };
}
