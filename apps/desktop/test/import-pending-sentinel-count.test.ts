/**
 * @file import-pending-sentinel-count.test.ts
 * @description ISS-5103: DB-backed coverage for `listImportPendingSessionIds`,
 * the source of the `import.sessions_pending_revision` counter.
 *
 * The read is deliberately id-shaped and deliberately NOT filtered by
 * `updated_at`. The revision-only heal path in `write-core` stamps
 * `DATA_REVISION_IMPORT_PENDING` without bumping `updated_at` (it is the sync
 * watermark, left alone on purpose), so a "sentinel AND old updated_at" filter
 * would also match a session being imported right this second — the majority
 * case during a DATA_REVISION backfill. The caller instead intersects
 * consecutive snapshots, so this read only has to answer "which sessions are at
 * the sentinel now", stably and bounded.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DATA_REVISION,
  DATA_REVISION_IMPORT_PENDING,
} from "../src/main/collectors/engine/data-revision.js";
import {
  BASELINE_MIGRATIONS,
  LEGACY_SCHEMA_REASSERT_SEQUENCE,
} from "../src/main/database/migration/baseline-schema.js";
import { openMigrationDatabase } from "../src/main/database/migration/migration-executor.js";
import { runDesktopMigrations } from "../src/main/database/migration/migration-runner.js";
import { MIGRATIONS } from "../src/main/database/migration/migrations-manifest.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

const NOW = "2026-07-10T12:00:00.000Z";
const LONG_AGO = "2026-01-01T00:00:00.000Z";

type SeedRow = {
  id: string;
  dataRevision: number;
  updatedAt: string | null;
};

const SEED_ROWS: SeedRow[] = [
  // At the sentinel with a FRESH stamp — the shape the revision-only heal path
  // produces for a session whose import is running right now.
  {
    id: "pending-a",
    dataRevision: DATA_REVISION_IMPORT_PENDING,
    updatedAt: NOW,
  },
  // At the sentinel with a stale stamp, and with none at all. Both are returned:
  // this read makes no claim about how long they have been pending.
  {
    id: "pending-b",
    dataRevision: DATA_REVISION_IMPORT_PENDING,
    updatedAt: LONG_AGO,
  },
  {
    id: "pending-c",
    dataRevision: DATA_REVISION_IMPORT_PENDING,
    updatedAt: null,
  },
  // Sealed at the real revision — never returned, however old.
  { id: "sealed", dataRevision: DATA_REVISION, updatedAt: LONG_AGO },
];

async function openSeededDatabase(dataDir: string) {
  // Seed through the production migration runner, then close before the agent
  // database opens the same file — one writer at a time, as in production.
  const { db } = await openMigrationDatabase(dataDir);
  await runDesktopMigrations(db, {
    migrations: MIGRATIONS,
    baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
    baselineMigrations: BASELINE_MIGRATIONS,
  });
  for (const row of SEED_ROWS) {
    await db.query(
      "INSERT INTO sessions (id, data_revision, updated_at) VALUES ($1, $2, $3)",
      [row.id, row.dataRevision, row.updatedAt]
    );
  }
  await db.close();

  return openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    emit: () => {},
    now: () => NOW,
  });
}

test("listImportPendingSessionIds returns every sentinel row regardless of updated_at", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "import-pending-ids-"));
  const agentDatabase = await openSeededDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  try {
    // Fresh, stale, and null `updated_at` sentinel rows all come back; the
    // sealed row never does. A timestamp filter here would have dropped
    // `pending-a` and mislabeled the other two as stuck without evidence.
    assert.deepEqual(await agentDatabase.listImportPendingSessionIds(100), [
      "pending-a",
      "pending-b",
      "pending-c",
    ]);
  } finally {
    await agentDatabase.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("listImportPendingSessionIds caps the snapshot stably so two ticks compare like for like", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "import-pending-cap-"));
  const agentDatabase = await openSeededDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  try {
    // A capped snapshot must be the SAME capped subset each time — an unordered
    // cap could hand the caller disjoint halves of one backlog and report zero
    // survivors while the backlog sits there untouched.
    const first = await agentDatabase.listImportPendingSessionIds(2);
    const second = await agentDatabase.listImportPendingSessionIds(2);
    assert.deepEqual(first, ["pending-a", "pending-b"]);
    assert.deepEqual(second, first);
    // A nonsense limit still returns a usable snapshot rather than everything.
    assert.equal(
      (await agentDatabase.listImportPendingSessionIds(0)).length,
      1
    );
  } finally {
    await agentDatabase.close();
    await rm(dir, { recursive: true, force: true });
  }
});
