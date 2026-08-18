/**
 * Shared setup for the electron-free local-Insights suites.
 *
 * `openInsightsDb` builds a migrated temp SQLite store plus a `DesktopPrisma`
 * client straight from the migration runner — no `sqlite.ts`/electron import —
 * so the Insights backend is verifiable in the dev sandbox as well as CI.
 * Extracted from `local-insights-contract.test.ts` (ISS-5412) so a focused
 * sibling suite can reuse it instead of re-deriving the fixture, and so the
 * grandfathered contract file does not have to grow to host a new scenario.
 */
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BASELINE_MIGRATIONS,
  LEGACY_SCHEMA_REASSERT_SEQUENCE,
} from "../src/main/database/migration/baseline-schema.js";
import { openMigrationDatabase } from "../src/main/database/migration/migration-executor.js";
import { runDesktopMigrations } from "../src/main/database/migration/migration-runner.js";
import { MIGRATIONS } from "../src/main/database/migration/migrations-manifest.js";
import type { CapturedStatement } from "../src/main/database/prisma-client.js";
import {
  createDesktopPrisma,
  type WriteSerializer,
} from "../src/main/database/prisma-client.js";

// computeLocalInsights only reads, so the write queue is never exercised — a
// pass-through satisfies the factory without importing sqlite.ts (electron).
const passthroughQueue: WriteSerializer = { run: (fn) => fn() };

/**
 * Open a migrated, empty desktop database in a fresh temp dir named for `label`.
 * Every DB-backed test starts from this same fixture and tears it down in its
 * own `finally` (`prisma.disconnect()`, `db.close()`, `rm(dir, …)`).
 *
 * ISS-5936: `onStatement` is the ISS-5336 driver-adapter capture hook, passed
 * straight through to `createDesktopPrisma`. A suite that needs to assert HOW
 * MANY times a statement is issued (rather than what it returns) opts in here
 * instead of hand-rolling a proxy. Capturing at the adapter boundary sees the
 * statement whichever dispatch path issued it — `prisma.client` or a pooled
 * `prisma.read` reader.
 */
export async function openInsightsDb(
  label: string,
  onStatement?: (statement: CapturedStatement) => void
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), label));
  const { db, config } = await openMigrationDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  await runDesktopMigrations(db, {
    migrations: MIGRATIONS,
    baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
    baselineMigrations: BASELINE_MIGRATIONS,
  });
  const prisma = await createDesktopPrisma(config, passthroughQueue, {
    onStatement,
  });
  return { dir, db, prisma };
}
