import { withDb } from "@repo/database";
import {
  type CheckResult,
  GENERIC_ERRORS,
  isMissingTableError,
} from "./db-health-helpers";

type HealthChecks = Record<
  "connectivity" | "migrations" | "tables",
  CheckResult
>;

export async function getDatabaseHealth() {
  const checks: HealthChecks = {
    connectivity: { status: "error", error: "not_run" },
    migrations: { status: "error", error: "not_run" },
    tables: { status: "error", error: "not_run" },
  };

  try {
    // Check 1: Connectivity + basic query
    const start = Date.now();
    await withDb((db) => db.$queryRaw`SELECT 1 AS health_check`);
    checks.connectivity = { status: "ok", latencyMs: Date.now() - start };

    // Check 2: Migration status
    try {
      const rows = await withDb(
        (db) => db.$queryRaw<{ total: bigint; pending: bigint }[]>`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS pending
        FROM _prisma_migrations
      `
      );
      const total = Number(rows[0].total);
      const pending = Number(rows[0].pending);
      checks.migrations =
        pending > 0
          ? {
              status: "error",
              total,
              pending,
              error: GENERIC_ERRORS.migrations,
            }
          : { status: "ok", total, pending };
    } catch (err) {
      if (isMissingTableError(err)) {
        checks.migrations = {
          status: "ok",
          note: "No migrations table (first deploy)",
        };
      } else {
        console.error("DB health migrations check failed", err);
        checks.migrations = {
          status: "error",
          error: GENERIC_ERRORS.migrations,
        };
      }
    }

    // Check 3: Table count
    try {
      const tableRows = await withDb(
        (db) => db.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) AS count
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      `
      );
      checks.tables = { status: "ok", count: Number(tableRows[0].count) };
    } catch (err) {
      console.error("DB health table count check failed", err);
      checks.tables = { status: "error", error: GENERIC_ERRORS.tables };
    }
  } catch (err) {
    console.error("DB health connectivity check failed", err);
    checks.connectivity = {
      status: "error",
      error: GENERIC_ERRORS.connectivity,
    };
  }

  const ok =
    checks.connectivity.status === "ok" &&
    checks.migrations.status !== "error" &&
    checks.tables.status === "ok";

  return {
    timestamp: new Date().toISOString(),
    ok,
    checks,
  };
}
