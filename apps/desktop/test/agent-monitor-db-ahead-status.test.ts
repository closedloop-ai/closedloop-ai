/**
 * @file agent-monitor-db-ahead-status.test.ts
 * @description ISS-4714 — the DB-ahead-of-app startup path. Drives the REAL
 * migration runner to the forward-migration-guard refusal (a local DB carrying a
 * migration this build does not include), proves that failure is classified as
 * the DB-ahead condition, and that the runtime-status IPC payload built from it
 * reports a FAILED / update-required Agent Monitor status — never a healthy one.
 *
 * Uses `node:test` (not vitest) because it exercises the on-disk libSQL runner,
 * mirroring `migration-runner.test.ts`.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AuthorizedCommandKeyStore } from "../src/main/command-signing/authorized-command-key-store.js";
import { openMigrationDatabase } from "../src/main/database/migration/migration-executor.js";
import {
  type EmbeddedMigration,
  type MigrationDb,
  runDesktopMigrations,
} from "../src/main/database/migration/migration-runner.js";
import {
  RuntimeInfoIpcChannel,
  type RuntimeInfoIpcDeps,
  registerRuntimeInfoIpcHandlers,
} from "../src/main/ipc/runtime-info-ipc.js";
import {
  buildAgentMonitorFailureStatus,
  DesktopMigrationError,
  isDbAheadOfAppError,
} from "../src/main/lifecycle/migration-refusal.js";
import {
  type AgentMonitorRuntimeStatus,
  AgentMonitorRuntimeStatusKind,
} from "../src/shared/agent-monitor-status.js";
import { unknownCloudReadReadiness } from "../src/shared/cloud-read-readiness-contract.js";
import {
  emptyTranscriptStatusCounts,
  TranscriptEgressGate,
} from "../src/shared/transcript-sync-status-contract.js";

type IpcHandler = (event: unknown, payload?: unknown) => unknown;

const TRUSTED_EVENT = { sender: {} };

function migration(name: string, sql: string): EmbeddedMigration {
  return {
    name,
    checksum: createHash("sha256").update(sql, "utf8").digest("hex"),
    sql,
  };
}

const M1 = migration(
  "0001_init",
  "CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT);"
);

const tempDirs: string[] = [];

async function freshDb(): Promise<MigrationDb> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "db-ahead-status-"));
  tempDirs.push(dir);
  const { db } = await openMigrationDatabase(path.join(dir, "widgets.sqlite"));
  return db;
}

async function seedTracking(
  db: MigrationDb,
  rows: { name: string; checksum: string }[]
): Promise<void> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS "_desktop_migrations" (
       "name" TEXT PRIMARY KEY, "checksum" TEXT NOT NULL, "applied_at" TEXT NOT NULL
     );`
  );
  for (const row of rows) {
    await db.query(
      'INSERT INTO "_desktop_migrations" ("name", "checksum", "applied_at") VALUES ($1, $2, $3)',
      [row.name, row.checksum, "2026-01-01T00:00:00.000Z"]
    );
  }
}

// Build the runtime-status IPC payload from a fixed Agent Monitor status. Only
// the fields this test asserts on are real; the rest are inert stubs (the
// trusted `GetRuntimeStatus` reads them but the test does not assert them). The
// partial cast is sanctioned by AGENTS.md for impractical-to-build test shapes.
function buildRuntimeStatusPayload(
  agentMonitor: AgentMonitorRuntimeStatus,
  dashboardReady: boolean
): unknown {
  const handlers = new Map<string, IpcHandler>();
  // Only the fields this test reads are real; the rest are inert stubs the
  // trusted `GetRuntimeStatus` reads but the test does not assert. The partial
  // cast is sanctioned by AGENTS.md for impractical-to-build test shapes.
  const deps: Partial<RuntimeInfoIpcDeps> = {
    isTrustedSender: () => true,
    getAppVersion: () => "0.0.0-test",
    getIsPackaged: () => true,
    settingsStore: {
      getAllFlags: () => ({}),
      getRelayOrigin: () => "",
      getApiOrigin: () => "",
      getSandboxBaseDirectory: () => "",
      getCommandSigningEnforcementEnabled: () => false,
    } as RuntimeInfoIpcDeps["settingsStore"],
    // A REAL store pointed at a path that does not exist: `list()` reads the
    // empty set, matching the previous fake, without a structural double that
    // could never satisfy this class's private state.
    authorizedCommandKeys: new AuthorizedCommandKeyStore({
      filePath: path.join(os.tmpdir(), "db-ahead-status-no-such-keys.json"),
    }),
    getTranscriptSyncStatus: () =>
      Promise.resolve({
        enabled: false,
        online: false,
        tierGate: TranscriptEgressGate.Denied,
        storeReady: false,
        statusCounts: emptyTranscriptStatusCounts(),
      }),
    getActivePort: () => 0,
    getCloudStatus: () => ({ state: "idle" }),
    getCloudCommandsPaused: () => false,
    getCloudConnectionEnabled: () => false,
    getConnectionSecurityStatus: () => ({ mode: "standard", detail: "" }),
    getServerCommandSigningSupported: () => false,
    isServerAlive: () => false,
    getGatewayHealthy: () => true,
    getIngestProgress: () => null,
    getFileAccessBlocks: () => [],
    getMaintenanceProgress: () => null,
    getCloudSyncProgress: () => ({
      identified: false,
      pendingBackfillSessions: 0,
      pendingIncrementalSessions: 0,
      backfilling: false,
      caughtUp: false,
      deadLetteredSessions: 0,
      deadLetteredComponents: 0,
    }),
    getDashboardReady: () => dashboardReady,
    getAgentMonitorStatus: () => agentMonitor,
    // ISS-5768: the runtime-status payload now also carries the whole-app sync
    // backlog. Unknown here — this suite is about the DB-ahead status, and an
    // unsampled burn-down is what a refusing-to-start app would report anyway.
    getCloudReadReadiness: () => unknownCloudReadReadiness(),
  };

  registerRuntimeInfoIpcHandlers(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    deps as RuntimeInfoIpcDeps
  );
  const handler = handlers.get(RuntimeInfoIpcChannel.GetRuntimeStatus);
  if (!handler) {
    throw new Error("GetRuntimeStatus handler must be registered");
  }
  return handler(TRUSTED_EVENT);
}

test.after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

test("a DB-ahead migration history is classified as the DB-ahead condition", async () => {
  const db = await freshDb();
  // The store recorded a migration this build's bundle does not ship — a DB
  // created by a NEWER Desktop build. The forward-guard must refuse.
  await seedTracking(db, [
    { name: M1.name, checksum: M1.checksum },
    { name: "0099_from_the_future", checksum: "a".repeat(64) },
  ]);

  let caught: unknown;
  try {
    await runDesktopMigrations(db, {
      migrations: [M1],
      baselineStatements: [],
      baselineMigrations: [],
      legacySentinelTable: "widgets",
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(
    caught instanceof DesktopMigrationError,
    "the runner must throw a DesktopMigrationError on a DB-ahead history"
  );
  assert.equal(
    isDbAheadOfAppError(caught),
    true,
    "the DB-ahead refusal must classify as the DB-ahead condition"
  );
});

test("the runtime status for the DB-ahead failure is FAILED + dbAhead, not healthy", async () => {
  const db = await freshDb();
  await seedTracking(db, [
    { name: M1.name, checksum: M1.checksum },
    { name: "0099_from_the_future", checksum: "a".repeat(64) },
  ]);

  let caught: unknown;
  try {
    await runDesktopMigrations(db, {
      migrations: [M1],
      baselineStatements: [],
      baselineMigrations: [],
      legacySentinelTable: "widgets",
    });
  } catch (error) {
    caught = error;
  }

  const status = buildAgentMonitorFailureStatus(caught);
  assert.equal(status.kind, AgentMonitorRuntimeStatusKind.Failed);
  assert.equal(status.dbAhead, true);
  assert.notEqual(
    status.kind,
    AgentMonitorRuntimeStatusKind.Ready,
    "a DB-ahead failure must never report a ready/healthy runtime"
  );
  assert.ok(
    typeof status.reason === "string" && status.reason.length > 0,
    "the failed status must carry a user-facing reason"
  );

  // The status must reach the renderer through the runtime-status IPC payload,
  // and it must not simultaneously claim the dashboard/sync is ready.
  const payload = buildRuntimeStatusPayload(status, false);
  assert.ok(
    payload && typeof payload === "object",
    "runtime status payload must be an object"
  );
  const shape = payload as Record<string, unknown>;
  assert.deepEqual(shape.agentMonitor, status);
  assert.equal(
    shape.dashboardReady,
    false,
    "the payload must not report the dashboard ready while the DB is ahead"
  );
});

test("a non-DB-ahead boot error is NOT classified as DB-ahead", () => {
  const error = new Error("some unrelated boot failure");
  assert.equal(isDbAheadOfAppError(error), false);
  const status = buildAgentMonitorFailureStatus(error);
  assert.equal(status.kind, AgentMonitorRuntimeStatusKind.Failed);
  assert.equal(
    status.dbAhead,
    false,
    "a generic failure must not surface the update-required state"
  );
});
