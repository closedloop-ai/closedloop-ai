/**
 * @file agent-db-test-utils.ts
 * @description Shared opener for the SQLite agent database used by collector /
 * importer tests. Centralizes the `openSqliteAgentDatabase` boilerplate
 * (`<dir>/agent-dashboard.pgdata` data dir, metered-API billing, a fixed `now`)
 * that was hand-rolled across fea1459 (21 call sites) and fea1785 (`openTestDb`).
 * Pass `extraOpts` to override any field (e.g. a different `now` or billing mode).
 *
 * ISS-5100 (PRD-611): `close()` on the returned handle first asserts the store
 * has no dangling foreign-key rows (`PRAGMA foreign_key_check`), so any
 * import/rebuild/maintenance path that strands a child row fails the test that
 * produced it — even when the write was swallowed by a tolerated-group catch
 * (the FK-787 class: ISS-5098/ISS-5099, previously FEA-1977, ISS-4476,
 * FEA-4160). Opt out per call with `testOpts.skipIntegrityCheck` ONLY when the
 * dangling row is the test's explicit subject.
 *
 * ISS-5101 (PRD-611): `close()` additionally fails the test when the import
 * path swallowed a failure at runtime — `openTestDb` wraps the `log` option
 * (still forwarding to any caller-provided log) and collects every
 * import-failure line (see `src/main/database/import-log-messages.ts`); the
 * teardown then throws listing them. This catches the rolled-back-group class
 * the FK check provably cannot see (a rejected group leaves the store clean).
 * Opt out per call with `testOpts.allowImportFailures` ONLY when a
 * failing/partial import is the test's explicit subject.
 */
import path from "node:path";
import { isImportFailureLogLine } from "../src/main/database/import-log-messages.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

type OpenOpts = Parameters<typeof openSqliteAgentDatabase>[0];

type TestDbOpts = {
  /**
   * Skip the teardown `PRAGMA foreign_key_check` assertion. Reserve for tests
   * whose subject IS a dangling row (e.g. an ISS-5098-style orphan fixture);
   * say why in a comment at the call site.
   */
  skipIntegrityCheck?: boolean;
  /**
   * Skip the teardown swallowed-import-failure assertion. Reserve for tests
   * whose subject IS a failing or partial import (e.g. fault injection,
   * cancellation/timeout); say why in a comment at the call site.
   */
  allowImportFailures?: boolean;
};

type ForeignKeyCheckRow = {
  table: string;
  rowid: number | bigint | null;
  parent: string;
  fkid: number | bigint;
};

const INTEGRITY_SAMPLE_LIMIT = 10;

/**
 * Open a SQLite agent database rooted at `<dir>/agent-dashboard.pgdata` with the
 * standard test defaults. Returns the same handle as `openSqliteAgentDatabase`;
 * callers own `db.close()`, which additionally runs the ISS-5100 teardown
 * integrity check (see `assertStoreIntegrity`).
 */
export async function openTestDb(
  dir: string,
  extraOpts?: Partial<OpenOpts>,
  testOpts?: TestDbOpts
): Promise<SqliteAgentDatabase> {
  // ISS-5101: wrap the caller's log (still forwarding) and collect every
  // swallowed import-failure line so teardown can fail the test on them.
  const swallowedFailures: string[] = [];
  const callerLog = extraOpts?.log;
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
    ...extraOpts,
    log: (message) => {
      if (isImportFailureLogLine(message)) {
        swallowedFailures.push(message);
      }
      callerLog?.(message);
    },
  });
  if (testOpts?.skipIntegrityCheck && testOpts?.allowImportFailures) {
    return db;
  }
  const close = db.close.bind(db);
  db.close = async () => {
    // Quiesce writers BEFORE checking, mirroring close()'s own ordering
    // (scheduler dispose → queue drain), so a queued or in-flight write cannot
    // land after the check passes. Both steps are idempotent, so close()
    // re-running them below is safe.
    await db.scheduler.stop().catch(() => undefined);
    await db.writeQueue.drain();
    try {
      if (!testOpts?.skipIntegrityCheck) {
        await assertStoreIntegrity(db);
      }
      if (!testOpts?.allowImportFailures) {
        assertNoSwallowedImportFailures(swallowedFailures);
      }
    } catch (integrityError) {
      // The handle must be released even when the store is dirty (so the
      // caller's temp-dir cleanup still works), and the integrity error must
      // win even if close() itself rejects — a plain `finally { close() }`
      // would let a close() rejection replace it.
      await close().catch(() => undefined);
      throw integrityError;
    }
    await close();
  };
  return db;
}

/**
 * Throw if the store carries any dangling foreign-key row. Exported for
 * mid-test assertions (e.g. between two import passes); `openTestDb` runs it
 * automatically on `close()`.
 */
export async function assertStoreIntegrity(
  db: SqliteAgentDatabase
): Promise<void> {
  const rows = await db.prisma.client.$queryRawUnsafe<ForeignKeyCheckRow[]>(
    "PRAGMA foreign_key_check"
  );
  if (rows.length === 0) {
    return;
  }
  const sample = rows
    .slice(0, INTEGRITY_SAMPLE_LIMIT)
    .map((row) => `${row.table} rowid=${row.rowid} → ${row.parent}`)
    .join("; ");
  throw new Error(
    `store failed teardown integrity check: ${rows.length} dangling foreign-key row(s) (PRAGMA foreign_key_check): ${sample}`
  );
}

/**
 * Throw when the import path logged a swallowed failure during the test
 * (ISS-5101). The runtime tolerates these by design; a unit test must not,
 * unless it opts out with `testOpts.allowImportFailures`.
 */
function assertNoSwallowedImportFailures(lines: string[]): void {
  if (lines.length === 0) {
    return;
  }
  const sample = lines.slice(0, INTEGRITY_SAMPLE_LIMIT).join("; ");
  throw new Error(
    `test swallowed ${lines.length} import failure(s): ${sample} — assert the failure or pass testOpts.allowImportFailures if a failing import is this test's subject`
  );
}
