/**
 * @file sqlite-cov-iss11283-harness.ts
 * @description ISS-11283 lane C: seed-then-reboot helpers for the
 * `openSqliteAgentDatabase` boot-chain suites. The boot chain (heals, sweeps,
 * owner claim, scheduled-run recovery) only runs inside `openSqliteAgentDatabase`,
 * so every scenario seeds a real migrated store through `openTestDb`, closes it,
 * and re-opens the SAME data dir with a capturing `log` to read what the boot
 * reported.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite-contract.js";
import type { BillingMode } from "../src/shared/billing-mode.js";
import { openTestDb } from "./agent-db-test-utils.js";

export const BOOT_NOW = "2026-06-22T12:00:00.000Z";

type OpenOpts = Parameters<typeof openSqliteAgentDatabase>[0];

export type SeedStatement = readonly [sql: string, ...params: unknown[]];

export type BootedStore = {
  database: SqliteAgentDatabase;
  lines: string[];
};

export type StoreDir = {
  dir: string;
  dataDir: string;
  /** Close every store this helper opened and remove the temp dir. */
  dispose: () => Promise<void>;
  /** Seed rows through a settled, ordinary store, then close it. */
  seed: (statements: readonly SeedStatement[]) => Promise<void>;
  /** Re-open the seeded dir, capturing every boot log line. */
  boot: (extra?: Partial<OpenOpts>) => Promise<BootedStore>;
};

export async function makeStoreDir(label: string): Promise<StoreDir> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `iss11283-${label}-`));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const open: SqliteAgentDatabase[] = [];
  return {
    dir,
    dataDir,
    seed: async (statements) => {
      // The seeded rows are the scenario under test (terminal sessions past the
      // window, triggers that refuse writes), so the teardown integrity checks
      // that assume an ordinary store are not what this seed pass is about.
      const db = await openTestDb(
        dir,
        { now: () => BOOT_NOW },
        { skipIntegrityCheck: true, allowImportFailures: true }
      );
      try {
        for (const [sql, ...params] of statements) {
          await db.run(sql, ...params);
        }
      } finally {
        await db.close();
      }
    },
    boot: async (extra) => {
      const lines: string[] = [];
      const database = await openSqliteAgentDatabase({
        dataDir,
        detectBillingMode: (): BillingMode => "unknown",
        now: () => BOOT_NOW,
        ...extra,
        log: (message) => {
          lines.push(message);
          extra?.log?.(message);
        },
      });
      open.push(database);
      return { database, lines };
    },
    dispose: async () => {
      for (const database of open.splice(0)) {
        await database.whenBootMaintenanceSettled();
        await database.close();
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** A terminal/active `sessions` row with explicit timestamps. */
export function sessionRow(input: {
  id: string;
  status: string;
  updatedAt: string;
  lastActivityAt: string;
  startedAt?: string | null;
  userId?: string | null;
  organizationId?: string | null;
}): SeedStatement {
  return [
    `INSERT INTO sessions (id, status, updated_at, last_activity_at, started_at, data_revision, user_id, organization_id)
     VALUES ($1, $2, $3, $4, $5, 1, $6, $7)`,
    input.id,
    input.status,
    input.updatedAt,
    input.lastActivityAt,
    input.startedAt ?? null,
    input.userId ?? null,
    input.organizationId ?? null,
  ];
}

/** Read one session's status + owner columns straight off the store. */
export async function readSession(
  database: SqliteAgentDatabase,
  id: string
): Promise<
  | {
      status: string;
      user_id: string | null;
      ended_at: string | null;
    }
  | undefined
> {
  const rows = await database.prisma.client.$queryRawUnsafe<
    { status: string; user_id: string | null; ended_at: string | null }[]
  >("SELECT status, user_id, ended_at FROM sessions WHERE id = $1", id);
  return rows[0];
}

/** Lines that start with `prefix`. */
export function linesStartingWith(lines: string[], prefix: string): string[] {
  return lines.filter((line) => line.startsWith(prefix));
}
