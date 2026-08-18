/**
 * @file sqlite-boot-failure.test.ts
 * @description ISS-5400: coverage for `openSqliteAgentDatabase`'s BOOT-FAILURE
 * path — the migration-refusal `catch` that closes the boot-time handle and
 * rethrows.
 *
 * Why this was missing. `test/migration-runner.test.ts` already covers the
 * runner's own refusal decisions (drift, downgrade, history gap, baseline). What
 * nothing covered was the CALLER's contract in `sqlite.ts`:
 *
 *   } catch (error) {
 *     // Close the handle so the DB stays closed on refusal, but never let a
 *     // close() failure mask the original migration error (it is the one the
 *     // boot path surfaces to the user).
 *     await db.close().catch(() => undefined);
 *     throw error;
 *   }
 *
 * That block was at 0% function coverage across the whole 7,735-test suite, and
 * it is the boot path: `app.ts` renders whatever escapes here as an Agent Monitor
 * boot failure with DB IPC disabled. The `.catch(() => undefined)` is the subtle
 * part — it exists so a secondary close() failure cannot replace the refusal the
 * user needs to see. A regression there would surface as a useless error message
 * at exactly the moment the app is unusable.
 *
 * These tests drive REAL refusals (a corrupted tracking-table checksum, a
 * from-the-future migration row) rather than mocking the runner, so they also
 * pin that the catch covers every refusal kind, not just the one shape.
 *
 * The `.catch(() => undefined)` is driven directly (wongk review): the last two
 * tests inject a boot handle whose `close()` REJECTS, via the
 * `openMigrationDatabase` seam on `OpenSqliteAgentDatabaseOptions`. Without that
 * seam a real handle always closes cleanly, so the catch's `.catch(...)` never
 * runs and degrading it to a bare `await db.close()` keeps every test green —
 * exactly the regression these two now fail on.
 *
 * NOT asserted, deliberately: that `db.close()` itself ran on the happy path.
 * The handle is module-internal and SQLite's WAL mode permits concurrent
 * connections, so every available proxy for "it was closed" is weak enough to
 * pass while broken. What IS asserted is the observable half of the contract —
 * the original error escapes unmasked, and the store is left re-openable and
 * untouched.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openMigrationDatabase } from "../src/main/database/migration/migration-executor.js";
import { MIGRATIONS } from "../src/main/database/migration/migrations-manifest.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  DesktopMigrationError,
  MigrationRefusalKind,
} from "../src/main/lifecycle/migration-refusal.js";

const BOGUS_CHECKSUM = "0".repeat(64);

/** The options `openSqliteAgentDatabase` requires; nothing else is reached. */
function bootOptions(dataDir: string) {
  return {
    dataDir,
    detectBillingMode: () => "unknown",
    log: () => {
      /* the refusal is asserted from the thrown error, not from logs */
    },
  };
}

/**
 * Seed a `_desktop_migrations` tracking table directly, without running the real
 * migrations — the runner reads this to decide drift/downgrade. Mirrors
 * `seedTracking` in migration-runner.test.ts.
 */
async function seedTracking(
  dataDir: string,
  rows: { name: string; checksum: string }[]
): Promise<void> {
  const { db } = await openMigrationDatabase(dataDir);
  try {
    await db.exec(
      `CREATE TABLE IF NOT EXISTS "_desktop_migrations" (
         "name" TEXT PRIMARY KEY, "checksum" TEXT NOT NULL, "applied_at" TEXT NOT NULL
       )`
    );
    for (const row of rows) {
      await db.query(
        'INSERT INTO "_desktop_migrations" ("name", "checksum", "applied_at") VALUES ($1, $2, $3)',
        [row.name, row.checksum, "2026-01-01T00:00:00.000Z"]
      );
    }
  } finally {
    await db.close();
  }
}

async function withTempStore(
  run: (dataDir: string) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sqlite-boot-failure-"));
  try {
    await run(path.join(dir, "agent-dashboard.sqlite"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("ISS-5400: a checksum-drift refusal escapes openSqliteAgentDatabase unmasked", async () => {
  await withTempStore(async (dataDir) => {
    const first = MIGRATIONS[0];
    assert.ok(first, "migration manifest is empty");
    // Record the first migration as applied under a checksum that cannot match
    // the bundled SQL — the exact state a hand-edited merged migration produces.
    await seedTracking(dataDir, [
      { name: first.name, checksum: BOGUS_CHECKSUM },
    ]);

    await assert.rejects(
      openSqliteAgentDatabase(bootOptions(dataDir)),
      (error: unknown) =>
        error instanceof DesktopMigrationError &&
        error.kind === MigrationRefusalKind.ChecksumDrift,
      "boot must surface the runner's ChecksumDrift refusal, not a close() error or a wrapper"
    );
  });
});

test("ISS-5400: a downgrade refusal escapes openSqliteAgentDatabase unmasked", async () => {
  await withTempStore(async (dataDir) => {
    // A migration the bundle has never heard of ⇒ the store was written by a
    // NEWER app. Covers the catch for a second refusal kind, proving it is not
    // shaped around drift specifically.
    await seedTracking(dataDir, [
      { name: "0099_from_the_future", checksum: "a".repeat(64) },
    ]);

    await assert.rejects(
      openSqliteAgentDatabase(bootOptions(dataDir)),
      (error: unknown) =>
        error instanceof DesktopMigrationError &&
        error.kind === MigrationRefusalKind.Downgrade,
      "boot must surface the runner's Downgrade refusal unmasked"
    );
  });
});

test("ISS-5400: a refused boot leaves the store re-openable and the refusal reproducible", async () => {
  await withTempStore(async (dataDir) => {
    const first = MIGRATIONS[0];
    assert.ok(first, "migration manifest is empty");
    await seedTracking(dataDir, [
      { name: first.name, checksum: BOGUS_CHECKSUM },
    ]);

    await assert.rejects(openSqliteAgentDatabase(bootOptions(dataDir)));

    // The failed boot must not have left the file locked or half-migrated: a
    // plain handle still opens and reads the tracking table, and the seeded
    // drift row is exactly as it was (the refusal touched no data).
    const { db } = await openMigrationDatabase(dataDir);
    try {
      const rows = await db.query<{ name: string; checksum: string }>(
        'SELECT "name", "checksum" FROM "_desktop_migrations"'
      );
      assert.equal(rows.rows.length, 1);
      assert.equal(rows.rows[0]?.name, first.name);
      assert.equal(rows.rows[0]?.checksum, BOGUS_CHECKSUM);
    } finally {
      await db.close();
    }

    // And the refusal is deterministic — a second boot attempt fails the same
    // way rather than succeeding off half-applied state from the first.
    await assert.rejects(
      openSqliteAgentDatabase(bootOptions(dataDir)),
      (error: unknown) =>
        error instanceof DesktopMigrationError &&
        error.kind === MigrationRefusalKind.ChecksumDrift
    );
  });
});

const CLOSE_FAILURE_MESSAGE = "ISS-5400: injected close() failure";

/**
 * Boot options whose migration handle really closes and THEN reports failure.
 *
 * This is the seam the `.catch(() => undefined)` needs: a genuine `close()`
 * rejection at the exact moment the refusal `catch` is doing its cleanup. The
 * underlying connection is released first so the test leaks nothing — what is
 * injected is the cleanup REPORTING an error, not a handle left open.
 *
 * `attempts` records the calls so a `catch` that stopped closing the handle
 * altogether fails these tests too, not just one that stopped swallowing.
 */
function bootOptionsWithFailingClose(
  dataDir: string,
  attempts: { count: number }
) {
  return {
    ...bootOptions(dataDir),
    openMigrationDatabase: async (filePath: string) => {
      const opened = await openMigrationDatabase(filePath);
      return {
        ...opened,
        db: {
          ...opened.db,
          close: async (): Promise<void> => {
            attempts.count += 1;
            await opened.db.close();
            throw new Error(CLOSE_FAILURE_MESSAGE);
          },
        },
      };
    },
  };
}

test("ISS-5400: a close() failure during cleanup cannot mask the migration refusal", async () => {
  await withTempStore(async (dataDir) => {
    const first = MIGRATIONS[0];
    assert.ok(first, "migration manifest is empty");
    await seedTracking(dataDir, [
      { name: first.name, checksum: BOGUS_CHECKSUM },
    ]);

    const attempts = { count: 0 };
    await assert.rejects(
      openSqliteAgentDatabase(bootOptionsWithFailingClose(dataDir, attempts)),
      (error: unknown) =>
        error instanceof DesktopMigrationError &&
        error.kind === MigrationRefusalKind.ChecksumDrift &&
        !error.message.includes(CLOSE_FAILURE_MESSAGE),
      "the refusal must escape even though cleanup's close() rejected; a bare `await db.close()` in the catch surfaces the close error instead"
    );

    // The catch must still have attempted the close — swallowing the failure is
    // only half the contract; skipping the cleanup entirely is the other half.
    assert.equal(attempts.count, 1, "the refusal catch must close the handle");
  });
});

test("ISS-5400: the cleanup swallow is not shaped around one refusal kind", async () => {
  await withTempStore(async (dataDir) => {
    await seedTracking(dataDir, [
      { name: "0099_from_the_future", checksum: "a".repeat(64) },
    ]);

    const attempts = { count: 0 };
    await assert.rejects(
      openSqliteAgentDatabase(bootOptionsWithFailingClose(dataDir, attempts)),
      (error: unknown) =>
        error instanceof DesktopMigrationError &&
        error.kind === MigrationRefusalKind.Downgrade &&
        !error.message.includes(CLOSE_FAILURE_MESSAGE),
      "a Downgrade refusal must also survive a failing cleanup close()"
    );
    assert.equal(attempts.count, 1, "the refusal catch must close the handle");
  });
});
