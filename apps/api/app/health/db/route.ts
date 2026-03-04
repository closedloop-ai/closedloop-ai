import { createHash, timingSafeEqual } from "node:crypto";
import { withDb } from "@repo/database";

type CheckResult = {
  status: "ok" | "error";
  latencyMs?: number;
  total?: number;
  pending?: number;
  count?: number;
  note?: string;
  error?: string;
};

export const dynamic = "force-dynamic";

const GENERIC_ERRORS = {
  connectivity: "db_connectivity_check_failed",
  migrations: "db_migration_check_failed",
  tables: "db_table_count_check_failed",
} as const;

function isMissingTableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("does not exist") &&
    normalized.includes("_prisma_migrations")
  );
}

function tokenMatches(actual: string | null, expected: string): boolean {
  if (!actual) {
    return false;
  }

  const digest = (value: string) =>
    createHash("sha256").update(value, "utf8").digest();

  const actualDigest = digest(actual);
  const expectedDigest = digest(expected);
  return timingSafeEqual(actualDigest, expectedDigest);
}

export const GET = async (request: Request) => {
  const expectedToken = process.env.DB_HEALTH_TOKEN;
  if (!expectedToken) {
    console.error("DB_HEALTH_TOKEN not configured");
    return Response.json(
      { ok: false, error: "service_unavailable" },
      { status: 503 }
    );
  }

  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;
  if (!tokenMatches(token, expectedToken)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const checks: Record<string, CheckResult> = {};

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
    checks.connectivity ??= {
      status: "error",
      error: GENERIC_ERRORS.connectivity,
    };
  }

  const ok =
    checks.connectivity?.status === "ok" &&
    checks.migrations?.status !== "error" &&
    checks.tables?.status === "ok";

  return Response.json({
    timestamp: new Date().toISOString(),
    ok,
    checks,
  });
};
