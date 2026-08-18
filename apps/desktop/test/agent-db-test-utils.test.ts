/**
 * @file agent-db-test-utils.test.ts
 * @description ISS-5100 (PRD-611): the shared test opener's teardown integrity
 * gate. `openTestDb(...).close()` must fail the owning test when the store
 * carries a dangling foreign-key row — the FK-787 class (ISS-5098/ISS-5099,
 * previously FEA-1977, ISS-4476, FEA-4160) — and stay silent on a clean store.
 *
 * ISS-5101 (PRD-611): `close()` must also fail the owning test when the import
 * path swallowed a failure at runtime (a tolerated-group rollback the FK gate
 * cannot see), quoting the collected log line(s); `allowImportFailures`
 * suppresses it; a clean import stays silent.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isImportFailureLogLine } from "../src/main/database/import-log-messages.js";
import { assertStoreIntegrity, openTestDb } from "./agent-db-test-utils.js";
import { makePopulatedSession } from "./normalized-session-test-utils.js";

const INTEGRITY_MESSAGE_RE = /teardown integrity check/;
const OFFENDING_TABLE_RE = /agents/;
const SWALLOWED_FAILURE_RE = /swallowed \d+ import failure/;
const EVENTS_GROUP_FAILED_RE = /sqlite import events failed for /;

/**
 * Strand an `agents` row pointing at a session that does not exist. Enqueued as
 * ONE write-queue task (so an unawaited call is fully drained by `close()`),
 * running its statements sequentially on the single writer connection. The
 * PRAGMA toggles run OUTSIDE any explicit transaction (SQLite ignores a
 * `foreign_keys` change issued mid-transaction), so the insert lands unchecked
 * and the dangle persists after enforcement is restored.
 */
function strandOrphanAgentRow(
  db: Awaited<ReturnType<typeof openTestDb>>
): Promise<void> {
  return db.prisma.write(async (client) => {
    await client.$executeRawUnsafe("PRAGMA foreign_keys=OFF");
    await client.$executeRawUnsafe(
      "INSERT INTO agents (id, session_id, status) VALUES ($1, $2, 'completed')",
      "iss5100-orphan-agent",
      "iss5100-no-such-session"
    );
    await client.$executeRawUnsafe("PRAGMA foreign_keys=ON");
  });
}

test("close() throws on a store with a dangling foreign-key row", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5100-fk-"));
  const db = await openTestDb(dir);
  try {
    await strandOrphanAgentRow(db);
  } finally {
    await assert.rejects(
      () => db.close(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, INTEGRITY_MESSAGE_RE);
        assert.match(error.message, OFFENDING_TABLE_RE);
        return true;
      },
      "a dangling agents.session_id must fail teardown"
    );
    await rm(dir, { recursive: true, force: true });
  }
});

test("close() drains queued writes before the integrity check", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5100-fk-"));
  const db = await openTestDb(dir);
  try {
    // Fire the stranding writes WITHOUT awaiting them: they are still queued
    // (or in flight) when close() is called, so the gate only catches the
    // dangle if it runs after the write-queue drain. Rejections surface via
    // the close() assertion below, not as unhandled rejections.
    const pending = strandOrphanAgentRow(db).catch(() => undefined);
    await assert.rejects(
      () => db.close(),
      INTEGRITY_MESSAGE_RE,
      "a write queued at close() time must be drained before the check"
    );
    await pending;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("close() is silent on a clean store", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5100-fk-"));
  const db = await openTestDb(dir);
  try {
    await assertStoreIntegrity(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("skipIntegrityCheck opts a deliberate-orphan test out of the gate", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5100-fk-"));
  // Opt-out under test: this fixture's subject IS the dangling row.
  const db = await openTestDb(dir, undefined, { skipIntegrityCheck: true });
  try {
    await strandOrphanAgentRow(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Make the tolerated `events` import group fail for real: rename the table it
 * inserts into, then import. write-core's runGroup catches the rejection, logs
 * the `sqlite import events failed for …` line, and flips `incomplete` — the
 * exact runtime-swallowed shape the sentinel exists to surface. The store
 * stays FK-clean (no events row ever lands), so the FK gate provably cannot
 * catch this class on its own.
 */
function breakEventsGroup(
  db: Awaited<ReturnType<typeof openTestDb>>
): Promise<void> {
  return db.prisma.write(async (client) => {
    await client.$executeRawUnsafe(
      "ALTER TABLE events RENAME TO events_iss5101_hidden"
    );
  });
}

test("close() throws when an import swallowed a group failure, quoting the line", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5101-sentinel-"));
  const forwarded: string[] = [];
  const db = await openTestDb(dir, {
    log: (message) => forwarded.push(message),
  });
  try {
    await breakEventsGroup(db);
    const result = await db.importer.importSession(
      makePopulatedSession(),
      "claude"
    );
    assert.equal(result.incomplete, true, "the runtime swallowed the failure");
  } finally {
    await assert.rejects(
      () => db.close(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, SWALLOWED_FAILURE_RE);
        assert.match(error.message, EVENTS_GROUP_FAILED_RE);
        return true;
      },
      "a swallowed import-group failure must fail teardown"
    );
    await rm(dir, { recursive: true, force: true });
  }
  // The sentinel wraps the caller's log; it must still forward every line.
  assert.ok(
    forwarded.some((line) => EVENTS_GROUP_FAILED_RE.test(line)),
    "the caller-provided log still receives the failure line"
  );
});

test("allowImportFailures suppresses the sentinel for a failure-subject test", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5101-sentinel-"));
  // Opt-out under test: this fixture's subject IS the failing import.
  const db = await openTestDb(dir, undefined, { allowImportFailures: true });
  try {
    await breakEventsGroup(db);
    const result = await db.importer.importSession(
      makePopulatedSession(),
      "claude"
    );
    assert.equal(result.incomplete, true);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the matcher covers the failure family but not the FEA-2027 skip line", () => {
  assert.ok(isImportFailureLogLine("sqlite importSession failed for s1: boom"));
  assert.ok(
    isImportFailureLogLine("sqlite import token_usage failed for s1: boom")
  );
  assert.ok(
    isImportFailureLogLine(
      "sqlite import revision_seal did not complete for s1; row left at pending revision to re-heal on rebuild"
    )
  );
  // Deliberate input-data skip (unsafe token count), not a swallowed failure.
  assert.ok(
    !isImportFailureLogLine(
      "sqlite import: skipping s1 — unsafe token count (overflow); nothing written"
    )
  );
});

test("a clean import leaves close() silent under the sentinel", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5101-sentinel-"));
  const db = await openTestDb(dir);
  try {
    const result = await db.importer.importSession(
      makePopulatedSession(),
      "claude"
    );
    assert.equal(result.incomplete, undefined);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
