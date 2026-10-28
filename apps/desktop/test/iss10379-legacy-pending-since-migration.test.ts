import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
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
import { createDesktopPrisma } from "../src/main/database/prisma-client.js";
import { createSyncBurndownReaders } from "../src/main/database/sync-burndown-store.js";
import { createWriteQueue } from "../src/main/database/write-queue.js";
import {
  burndownQuery,
  DELIVERY_SOURCE_KEY,
  SESSION_SOURCE_KEY,
} from "./support/sync-burndown-fixtures.js";

const LEGACY_MIGRATION = "20260918214249_iss10379_sync_outbox_pending_since";
/**
 * Every migration this harness's baseline still owes, in manifest order —
 * exactly what a run against it applies.
 */
const MIGRATIONS_FROM_LEGACY = MIGRATIONS.slice(
  MIGRATIONS.findIndex(({ name }) => name === LEGACY_MIGRATION)
).map(({ name }) => name);
const CORRECTION_MIGRATION =
  "20260919072306_iss10379_legacy_pending_since_unknown";
const SEED_TIME = "2025-01-01T00:00:00.000Z";

const legacyIndex = MIGRATIONS.findIndex(
  ({ name }) => name === LEGACY_MIGRATION
);
const correctionIndex = MIGRATIONS.findIndex(
  ({ name }) => name === CORRECTION_MIGRATION
);

function migrationOptions(migrations: typeof MIGRATIONS) {
  return {
    migrations,
    baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
    baselineMigrations: BASELINE_MIGRATIONS,
  };
}

async function seedLegacyPendingRows(db: SqliteClient): Promise<void> {
  await db.query(
    `INSERT INTO agent_session_sync_outbox
       (source_key, external_session_id, status, sync_class, attempt_count,
        created_at, updated_at)
     VALUES ($1, 'legacy-session', 'pending', 'backfill', 0, $2, $2)`,
    [SESSION_SOURCE_KEY, SEED_TIME]
  );
  await db.query(
    `INSERT INTO agent_component_invocation_sync_outbox
       (source_key, external_session_id, external_generation_id, part_index,
        part_count, part_hash, source_updated_at, data_revision,
        source_sequence, payload, status, attempt_count, created_at, updated_at)
     VALUES ($1, 'legacy-invocation', $2, 0, 1, $3, $4, 1, 1, '{}',
             'pending', 0, $4, $4)`,
    [
      DELIVERY_SOURCE_KEY,
      "legacy-generation".padEnd(64, "0"),
      "legacy-part".padEnd(64, "0"),
      SEED_TIME,
    ]
  );
}

async function seedLaterPendingRows(
  db: SqliteClient,
  pendingSince: string
): Promise<void> {
  await db.query(
    `INSERT INTO agent_session_sync_outbox
       (source_key, external_session_id, status, sync_class, attempt_count,
        pending_since, created_at, updated_at)
     VALUES ($1, 'later-session', 'pending', 'backfill', 0, $2, $2, $2)`,
    [SESSION_SOURCE_KEY, pendingSince]
  );
  await db.query(
    `INSERT INTO agent_component_invocation_sync_outbox
       (source_key, external_session_id, external_generation_id, part_index,
        part_count, part_hash, source_updated_at, data_revision,
        source_sequence, payload, status, attempt_count, pending_since,
        created_at, updated_at)
     VALUES ($1, 'later-invocation', $2, 0, 1, $3, $4, 1, 1, '{}',
             'pending', 0, $4, $4, $4)`,
    [
      DELIVERY_SOURCE_KEY,
      "later-generation".padEnd(64, "0"),
      "later-part".padEnd(64, "0"),
      pendingSince,
    ]
  );
}

type LegacyHarness = Awaited<ReturnType<typeof openLegacyHarness>>;

async function openLegacyHarness() {
  if (legacyIndex < 0 || correctionIndex <= legacyIndex) {
    throw new Error("ISS-10379 migrations are missing or out of order");
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss10379-legacy-age-"));
  const opened = await openMigrationDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  await runDesktopMigrations(
    opened.db,
    migrationOptions(MIGRATIONS.slice(0, legacyIndex))
  );
  await seedLegacyPendingRows(opened.db);
  await runDesktopMigrations(
    opened.db,
    migrationOptions(MIGRATIONS.slice(0, legacyIndex + 1))
  );
  const boundary = await opened.db.query<{
    applied_at: string;
    pending_since: string;
  }>(
    `SELECT m.applied_at, o.pending_since
     FROM _desktop_migrations m
     JOIN agent_session_sync_outbox o
       ON o.external_session_id = 'legacy-session'
     WHERE m.name = $1`,
    [LEGACY_MIGRATION]
  );
  const observed = boundary.rows[0];
  if (!observed) {
    throw new Error(
      "the runner did not record the affected migration boundary"
    );
  }
  return {
    ...opened,
    dir,
    boundary: observed.applied_at,
    legacyPendingSince: observed.pending_since,
  };
}

async function closeHarness(harness: LegacyHarness): Promise<void> {
  await harness.db.close();
  await rm(harness.dir, { recursive: true, force: true });
}

async function readPendingSince(
  db: SqliteClient,
  table: "agent_session_sync_outbox" | "agent_component_invocation_sync_outbox"
): Promise<
  Array<{ external_session_id: string; pending_since: string | null }>
> {
  const result = await db.query<{
    external_session_id: string;
    pending_since: string | null;
  }>(
    `SELECT external_session_id, pending_since FROM ${table}
     ORDER BY external_session_id`
  );
  return result.rows;
}

test("ISS-10379: upgrade keeps legacy pending age unknown and preserves later transitions", async () => {
  assert.ok(legacyIndex >= 0, "the original migration is present");
  assert.ok(
    correctionIndex > legacyIndex,
    "the correction follows the migration that fabricated age"
  );
  const harness = await openLegacyHarness();
  let prisma: Awaited<ReturnType<typeof createDesktopPrisma>> | null = null;
  try {
    assert.ok(
      harness.legacyPendingSince <= harness.boundary,
      "SQLite stamps the legacy row no later than the runner tracking record"
    );
    const laterPendingSince = new Date(
      Date.parse(harness.boundary) + 1
    ).toISOString();
    await seedLaterPendingRows(harness.db, laterPendingSince);
    await runDesktopMigrations(harness.db, migrationOptions(MIGRATIONS));

    assert.deepEqual(
      await readPendingSince(harness.db, "agent_session_sync_outbox"),
      [
        {
          external_session_id: "later-session",
          pending_since: laterPendingSince,
        },
        { external_session_id: "legacy-session", pending_since: null },
      ]
    );
    assert.deepEqual(
      await readPendingSince(
        harness.db,
        "agent_component_invocation_sync_outbox"
      ),
      [
        {
          external_session_id: "later-invocation",
          pending_since: laterPendingSince,
        },
        { external_session_id: "legacy-invocation", pending_since: null },
      ]
    );

    prisma = await createDesktopPrisma(harness.config, createWriteQueue());
    const sample = await createSyncBurndownReaders(prisma).readSyncBurndown(
      burndownQuery()
    );
    assert.equal(sample.sessionOutbox.pending, 2);
    assert.equal(sample.sessionOutbox.oldestPendingSinceIso, null);
    assert.equal(sample.invocationOutbox.pendingParts, 2);
    assert.equal(sample.invocationOutbox.oldestPendingSinceIso, null);
  } finally {
    await prisma?.disconnect();
    await closeHarness(harness);
  }
});

test("ISS-10379: malformed migration metadata keeps every existing age unknown", async () => {
  const harness = await openLegacyHarness();
  try {
    await seedLaterPendingRows(
      harness.db,
      new Date(Date.parse(harness.boundary) + 1).toISOString()
    );
    await harness.db.query(
      `UPDATE _desktop_migrations SET applied_at = 'malformed'
       WHERE name = $1`,
      [LEGACY_MIGRATION]
    );
    await runDesktopMigrations(harness.db, migrationOptions(MIGRATIONS));
    for (const table of [
      "agent_session_sync_outbox",
      "agent_component_invocation_sync_outbox",
    ] as const) {
      assert.deepEqual(await readPendingSince(harness.db, table), [
        {
          external_session_id:
            table === "agent_session_sync_outbox"
              ? "later-session"
              : "later-invocation",
          pending_since: null,
        },
        {
          external_session_id:
            table === "agent_session_sync_outbox"
              ? "legacy-session"
              : "legacy-invocation",
          pending_since: null,
        },
      ]);
    }
  } finally {
    await closeHarness(harness);
  }
});

test("ISS-10379: a missing legacy tracking row heals age to unknown", async () => {
  const harness = await openLegacyHarness();
  try {
    await harness.db.query("DELETE FROM _desktop_migrations WHERE name = $1", [
      LEGACY_MIGRATION,
    ]);
    const outcome = await runDesktopMigrations(
      harness.db,
      migrationOptions(MIGRATIONS)
    );
    // DERIVED, not a frozen pair. This harness opens at the legacy baseline, so
    // a run applies everything from there to the tip — and freezing two names
    // made the assertion break on the next unrelated migration to land. Deriving
    // keeps the claim it was making, that the two ISS-10379 migrations are
    // applied IN ORDER, without taxing every later migration author (the reason
    // main's own fix for this stopped pinning the tail at all).
    assert.deepEqual(outcome.applied, MIGRATIONS_FROM_LEGACY);
    assert.deepEqual(MIGRATIONS_FROM_LEGACY.slice(0, 2), [
      LEGACY_MIGRATION,
      CORRECTION_MIGRATION,
    ]);
    assert.deepEqual(
      outcome.applied.filter((name) => name < LEGACY_MIGRATION),
      [],
      "a migration tracked before the deleted row is not re-applied"
    );
    for (const table of [
      "agent_session_sync_outbox",
      "agent_component_invocation_sync_outbox",
    ] as const) {
      assert.deepEqual(await readPendingSince(harness.db, table), [
        {
          external_session_id:
            table === "agent_session_sync_outbox"
              ? "legacy-session"
              : "legacy-invocation",
          pending_since: null,
        },
      ]);
    }
  } finally {
    await closeHarness(harness);
  }
});

test("ISS-10379: an untracked partial store heals legacy age to unknown", async () => {
  const harness = await openLegacyHarness();
  try {
    await harness.db.query("DELETE FROM _desktop_migrations");
    await runDesktopMigrations(harness.db, migrationOptions(MIGRATIONS));
    for (const table of [
      "agent_session_sync_outbox",
      "agent_component_invocation_sync_outbox",
    ] as const) {
      assert.deepEqual(await readPendingSince(harness.db, table), [
        {
          external_session_id:
            table === "agent_session_sync_outbox"
              ? "legacy-session"
              : "legacy-invocation",
          pending_since: null,
        },
      ]);
    }
  } finally {
    await closeHarness(harness);
  }
});
