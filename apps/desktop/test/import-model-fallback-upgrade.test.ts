/**
 * @file import-model-fallback-upgrade.test.ts
 * @description FEA-4376 (PR #3903 review): `session.model` may be resolved from a
 * `/model`-switch display label (a fallback NAME, not a priceable wire id) when a
 * transcript has no assistant record yet. `sessions.model` is otherwise
 * COALESCE-sticky, so without an upgrade path the label the parser wrote before an
 * assistant record appeared would persist forever, and the promised
 * assistant-id-wins precedence would never take effect across incremental imports
 * (watcher mode / DATA_REVISION rebuild). It would also never re-sync to the cloud
 * because a model-only change is invisible to `buildImportMetadata`.
 *
 * These DB-backed tests drive the real ingest path and assert:
 *   1. a fresh REAL assistant model id upgrades a previously-stored fallback label
 *      AND is surfaced as a content change (`sessionDataChanged`) so it re-syncs;
 *   2. a fresh fallback label never clobbers a stored real assistant id (stays
 *      COALESCE-sticky).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-07-10T12:00:00.000Z";
const FALLBACK_LABEL = "Opus 4.8 (1M context)";
const REAL_MODEL_ID = "claude-opus-4-8";

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

async function openDb(dir: string): Promise<Db> {
  return await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
}

function labelOnlySession(sessionId: string): NormalizedSession {
  // A session whose only model signal was a /model switch echo: the parser
  // resolved `model` from the display label and flagged it a fallback.
  return makeSession({
    sessionId,
    model: FALLBACK_LABEL,
    modelIsFallback: true,
  });
}

function realModelSession(sessionId: string): NormalizedSession {
  // The same session re-parsed after an assistant record appeared: `model` is a
  // real wire id and is NOT a fallback.
  return makeSession({
    sessionId,
    model: REAL_MODEL_ID,
    modelIsFallback: false,
  });
}

async function queryModel(db: Db, sessionId: string): Promise<string | null> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    Array<{ model: string | null }>
  >("SELECT model FROM sessions WHERE id = $1", sessionId);
  return rows[0]?.model ?? null;
}

test("a fresh real assistant model id upgrades a stored /model fallback label and re-syncs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "import-model-upgrade-"));
  const db = await openDb(dir);
  try {
    const sessionId = "sess-fallback-then-real";

    // Import 1: only the /model label is known → stored as a fallback.
    await db.importer.importSession(labelOnlySession(sessionId), "claude");
    assert.equal(await queryModel(db, sessionId), FALLBACK_LABEL);

    // Import 2: a real assistant id is now known. It must overwrite the stored
    // fallback label (the whole point of the precedence promise) AND NOT be
    // reported as a byte-identical no-op — `skipped === false` is the collector's
    // "this row changed, re-sync it" signal, so the model-only delta reaches the
    // cloud instead of leaving it stuck on the label.
    const result = await db.importer.importSession(
      realModelSession(sessionId),
      "claude"
    );
    assert.equal(await queryModel(db, sessionId), REAL_MODEL_ID);
    assert.equal(result.skipped, false);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a fresh /model fallback label never clobbers a stored real assistant model id", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "import-model-sticky-"));
  const db = await openDb(dir);
  try {
    const sessionId = "sess-real-then-fallback";

    // Import 1: a real assistant id is stored.
    await db.importer.importSession(realModelSession(sessionId), "claude");
    assert.equal(await queryModel(db, sessionId), REAL_MODEL_ID);

    // Import 2: a fallback label must NOT overwrite the stored real id — the
    // fallback stays COALESCE-sticky (fill-only). A weaker display name can never
    // replace an authoritative wire id.
    await db.importer.importSession(labelOnlySession(sessionId), "claude");
    assert.equal(await queryModel(db, sessionId), REAL_MODEL_ID);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
