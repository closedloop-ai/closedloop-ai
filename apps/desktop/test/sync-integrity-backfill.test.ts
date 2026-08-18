/**
 * @file sync-integrity-backfill.test.ts
 * @description ISS-5086 upgrade repair: pre-fix session cursors perform exactly
 * one crash-safe parity re-walk, while current and non-session cursors resume.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildAgentComponentSyncSourceKey,
  buildAgentSessionSyncSourceKey,
} from "../src/main/agent-sync/agent-session-sync-source.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  AGENT_SESSION_SYNC_INTEGRITY_VERSION,
  sessionSyncIntegrityCursorIsStale,
} from "../src/main/database/sync-cursor-state.js";

const CURRENT_STATE = {
  observedTopUpdatedAt: "2026-08-04T12:00:00.000Z",
  observedIdsAtTopUpdatedAt: ["session-a"],
  deadLetteredIds: [],
};

/**
 * The integrity revision shipped before ISS-4569 bumped it to carry the
 * measured-zero duration contract. A historical value, deliberately a literal:
 * the exported constant tracks the CURRENT revision, so asserting against it
 * here would make the test vacuous the moment it moves.
 */
const PRE_MEASURED_ZERO_VERSION = 1;

/**
 * The integrity revision shipped before ISS-5999 bumped it to carry the
 * producer's bin bounds. A historical literal for the same reason as the one
 * above: this is the revision every already-installed build stamped, so it is
 * the population the bump exists to re-walk.
 */
const PRE_BIN_BOUNDS_VERSION = 2;

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

async function withDatabase(run: (db: Db) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sync-integrity-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => "2026-08-04T12:00:00.000Z",
  });
  try {
    await run(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("ISS-5086: a current integrity stamp resumes its durable cursor", async () => {
  await withDatabase(async (db) => {
    const sourceKey = buildAgentSessionSyncSourceKey("target-current");
    await db.syncSource.advanceSyncState?.(sourceKey, CURRENT_STATE);
    assert.deepEqual(
      await db.syncSource.loadSyncState?.(sourceKey),
      CURRENT_STATE
    );
  });
});

test("ISS-5086: a pre-fix cursor clears once, then resumes after persistence", async () => {
  await withDatabase(async (db) => {
    const sourceKey = buildAgentSessionSyncSourceKey("target-upgrade");
    await db.syncSource.advanceSyncState?.(sourceKey, CURRENT_STATE);
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        "UPDATE sync_state SET sync_integrity_version = NULL WHERE source_key = ?",
        sourceKey
      )
    );

    assert.deepEqual(await db.syncSource.loadSyncState?.(sourceKey), {
      observedTopUpdatedAt: null,
      observedIdsAtTopUpdatedAt: [],
      deadLetteredIds: [],
    });

    await db.syncSource.advanceSyncState?.(sourceKey, CURRENT_STATE);
    assert.deepEqual(
      await db.syncSource.loadSyncState?.(sourceKey),
      CURRENT_STATE,
      "the accepted repair cursor must stamp the version so the re-walk does not repeat"
    );
  });
});

test("ISS-5086: integrity-version staleness is scoped to the session lane", () => {
  const sessionKey = buildAgentSessionSyncSourceKey("target-a");
  const componentKey = buildAgentComponentSyncSourceKey("target-a");

  assert.equal(sessionSyncIntegrityCursorIsStale(sessionKey, null), true);
  assert.equal(
    sessionSyncIntegrityCursorIsStale(
      sessionKey,
      AGENT_SESSION_SYNC_INTEGRITY_VERSION
    ),
    false
  );
  assert.equal(sessionSyncIntegrityCursorIsStale(componentKey, null), false);
});

test("ISS-4569: a cursor stamped at the pre-measured-zero revision re-walks exactly once", () => {
  // The bump to revision 2 is what carries the corrected `"0s"` components to
  // sessions already synced as `null` behind the durable watermark. Nothing else
  // in that change schedules a reimport, so an unchanged terminal session would
  // otherwise keep its stale `null` in the cloud forever.
  const sessionKey = buildAgentSessionSyncSourceKey("target-iss4569");

  assert.equal(
    sessionSyncIntegrityCursorIsStale(sessionKey, PRE_MEASURED_ZERO_VERSION),
    true,
    "a revision-1 cursor must be stale so the upgrade re-walk fires"
  );
  assert.equal(
    sessionSyncIntegrityCursorIsStale(
      sessionKey,
      AGENT_SESSION_SYNC_INTEGRITY_VERSION
    ),
    false,
    "and must stop being stale once re-stamped, so the re-walk never repeats"
  );
  // Still scoped to the session lane: the component lane carries no trace
  // durations and must not be re-uploaded for this.
  assert.equal(
    sessionSyncIntegrityCursorIsStale(
      buildAgentComponentSyncSourceKey("target-iss4569"),
      PRE_MEASURED_ZERO_VERSION
    ),
    false
  );
});

test("ISS-5999: a cursor stamped at the pre-bin-bounds revision re-walks exactly once", () => {
  // The bump to revision 3 is what carries `binStartMs`/`binEndMs` to sessions
  // already synced without them. Selection is a keyset walk over
  // `sessions.updated_at`, so an unchanged session behind the watermark would
  // otherwise keep bounds-less buckets forever — an ordinal strip with no scale
  // toggle and no scrubber, permanently.
  const sessionKey = buildAgentSessionSyncSourceKey("target-iss5999");

  assert.equal(
    sessionSyncIntegrityCursorIsStale(sessionKey, PRE_BIN_BOUNDS_VERSION),
    true,
    "a revision-2 cursor must be stale so the bin-bounds re-walk fires"
  );
  assert.equal(
    sessionSyncIntegrityCursorIsStale(
      sessionKey,
      AGENT_SESSION_SYNC_INTEGRITY_VERSION
    ),
    false,
    "and must stop being stale once re-stamped, so the re-walk never repeats"
  );
  // The component lane carries no activity buckets and must not be re-uploaded.
  assert.equal(
    sessionSyncIntegrityCursorIsStale(
      buildAgentComponentSyncSourceKey("target-iss5999"),
      PRE_BIN_BOUNDS_VERSION
    ),
    false
  );
});
