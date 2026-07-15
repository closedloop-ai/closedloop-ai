import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ipcSessionCount } from "../src/main/agent-dashboard-ipc-perf.js";
import { createSqliteSessionStore } from "../src/main/database/read-stores.js";
import { countSqliteSessions } from "../src/main/database/session-count.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { openTestPrisma } from "./prisma-test-utils.js";

// Real-store coverage for the FEA-2211 fix. The original FEA-1997 tests stubbed
// `prisma.read` with a fake counter, so a count that returns 0 against a real
// libSQL store (the packaged-build behaviour of the reader-pool `session.count()`
// delegate) was invisible. These exercise the actual reader-pool COUNT. The
// failed-COUNT fallback (→ 0 + onError) is covered in
// agent-dashboard-ipc-perf.test.ts.
//
// FEA-2252: `ipcSessionCount` now reads through the clone-safe
// `agentDatabase.sessions.count()` method so the count can cross the db-host
// process boundary; that method runs the same `countSqliteSessions` SSOT helper
// on the reader pool inside the child. The fake `agentDatabase` therefore wires
// the REAL session store so this exercises the production `count()` path.

const PERF_MODULE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/main/agent-dashboard-ipc-perf.ts"
);
const READ_STORES_MODULE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/main/database/read-stores.ts"
);
const READER_DELEGATE_COUNT_PATTERN = /\.session\.count\(/;
const SSOT_HELPER_PATTERN = /countSqliteSessions/;
const MAIN_PROCESS_PRISMA_CALLBACK_PATTERN = /\bprisma\.(?:read|write)\(/;
const CLONE_SAFE_COUNT_PATTERN = /agentDatabase\.sessions\.count\(\)/;
const LINE_COMMENT_PATTERN = /\/\/.*$/gm;
const BLOCK_COMMENT_PATTERN = /\/\*[\s\S]*?\*\//g;

function sourceWithoutComments(modulePath: string): string {
  return readFileSync(modulePath, "utf8")
    .replace(BLOCK_COMMENT_PATTERN, "")
    .replace(LINE_COMMENT_PATTERN, "");
}

test("countSqliteSessions / ipcSessionCount count the real sessions table", async () => {
  const { prisma, close } = await openTestPrisma();
  // Wire the REAL session store so ipcSessionCount exercises the production
  // `sessions.count()` → `countSqliteSessions` path (FEA-2252), not a stub.
  const agentDatabase = {
    prisma,
    sessions: createSqliteSessionStore(prisma),
  } as unknown as SqliteAgentDatabase;
  try {
    // Empty store → 0 (a legitimate 0, distinct from a failed count).
    assert.equal(await prisma.read((r) => countSqliteSessions(r)), 0);
    assert.equal(await ipcSessionCount(agentDatabase), 0);

    // Seed sessions on the writer; the reader-pool COUNT must see them.
    for (let i = 0; i < 5; i += 1) {
      await prisma.write((client) =>
        client.session.create({ data: { id: `s${i}` } })
      );
    }

    // The shared raw-`COUNT(*)` helper (the SSOT) returns the true count.
    assert.equal(await prisma.read((r) => countSqliteSessions(r)), 5);
    // `ipcSessionCount` routes through `sessions.count()`, which runs that helper
    // on the reader pool, so the perf `session_count` dimension reflects reality.
    assert.equal(await ipcSessionCount(agentDatabase), 5);
  } finally {
    await close();
  }
});

test("countSqliteSessions honours an optional filter clause + params", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    for (const [id, status] of [
      ["a", "ended"],
      ["b", "running"],
      ["c", "running"],
    ] as const) {
      await prisma.write((client) =>
        client.session.create({ data: { id, status } })
      );
    }
    // Same parameterised path the Sessions-list pagination total uses.
    assert.equal(
      await prisma.read((r) =>
        countSqliteSessions(r, "WHERE s.status = $1", ["running"])
      ),
      2
    );
  } finally {
    await close();
  }
});

// FEA-2211 + FEA-2252 mechanical SSOT guard. No behavioural test can catch a
// regression here: the reader-pool `session.count()` model delegate returns the
// CORRECT count in this clean test env and only flat-lines to 0 in packaged
// builds; the real bug is unreproducible in CI. So enforce in source that the
// session count flows through the raw `countSqliteSessions` SSOT helper, never a
// reader-pool `.session.count()` aggregate. Since FEA-2252 the helper lives in
// `read-stores.ts`'s clone-safe `sessions.count()` method (it must run INSIDE the
// db host), and `ipcSessionCount` only calls that method from the main process.
// (The writer-connection `prisma.client.session.count()` in dashboard-queries.ts
// is a different, unaffected path and is intentionally NOT covered by this guard.)
test("sessions.count() counts via the SSOT helper, not a reader-pool delegate", () => {
  const storeCode = sourceWithoutComments(READ_STORES_MODULE_PATH);
  assert.match(
    storeCode,
    SSOT_HELPER_PATTERN,
    "read-stores.ts `sessions.count()` must count via the countSqliteSessions SSOT helper"
  );
  assert.doesNotMatch(
    storeCode,
    READER_DELEGATE_COUNT_PATTERN,
    "read-stores.ts must not call `.session.count()`; the reader-pool delegate returns 0 in packaged builds (FEA-2211)"
  );
});

test("ipcSessionCount routes through the clone-safe sessions.count() method", () => {
  const perfCode = sourceWithoutComments(PERF_MODULE_PATH);
  // FEA-2252: in db-host mode `agentDatabase` is a forwarding proxy in the main
  // process, so a `prisma.read(callback)` here cannot cross IPC (DataCloneError).
  assert.match(
    perfCode,
    CLONE_SAFE_COUNT_PATTERN,
    "ipcSessionCount must count via the clone-safe agentDatabase.sessions.count() method (FEA-2252)"
  );
  assert.doesNotMatch(
    perfCode,
    MAIN_PROCESS_PRISMA_CALLBACK_PATTERN,
    "ipcSessionCount must not issue a prisma.read/write callback from the main process; it can't cross the db-host boundary (FEA-2252)"
  );
  assert.doesNotMatch(
    perfCode,
    READER_DELEGATE_COUNT_PATTERN,
    "ipcSessionCount must not call `.session.count()`; the reader-pool delegate returns 0 in packaged builds (FEA-2211)"
  );
});
