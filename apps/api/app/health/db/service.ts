import {
  DbHealthCheckStatus,
  type DbHealthDeployment,
  DbHealthHostType,
  DbHealthSslMode,
} from "@repo/api/src/types/db-health";
import { getDatabaseTransportPosture, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  type CheckResult,
  GENERIC_ERRORS,
  isMissingTableError,
} from "./db-health-helpers";

type HealthChecks = Record<
  "connectivity" | "migrations" | "tables",
  CheckResult
> & {
  transport: ReturnType<typeof getDatabaseTransportPosture>;
};

export async function getDatabaseHealth() {
  const checks: HealthChecks = {
    connectivity: { status: DbHealthCheckStatus.Error, error: "not_run" },
    migrations: { status: DbHealthCheckStatus.Error, error: "not_run" },
    tables: { status: DbHealthCheckStatus.Error, error: "not_run" },
    transport: getDatabaseTransportPosture(),
  };

  try {
    // Check 1: Connectivity + basic query
    const start = Date.now();
    await withDb((db) => db.$queryRaw`SELECT 1 AS health_check`);
    checks.connectivity = {
      status: DbHealthCheckStatus.Ok,
      latencyMs: Date.now() - start,
    };

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
              status: DbHealthCheckStatus.Error,
              total,
              pending,
              error: GENERIC_ERRORS.migrations,
            }
          : { status: DbHealthCheckStatus.Ok, total, pending };
    } catch (err) {
      if (isMissingTableError(err)) {
        checks.migrations = {
          status: DbHealthCheckStatus.Ok,
          note: "No migrations table (first deploy)",
        };
      } else {
        log.error("health.db_check_failed", {
          check: "migrations",
          error: err,
        });
        checks.migrations = {
          status: DbHealthCheckStatus.Error,
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
      checks.tables = {
        status: DbHealthCheckStatus.Ok,
        count: Number(tableRows[0].count),
      };
    } catch (err) {
      log.error("health.db_check_failed", { check: "tables", error: err });
      checks.tables = {
        status: DbHealthCheckStatus.Error,
        error: GENERIC_ERRORS.tables,
      };
    }
  } catch (err) {
    log.error("health.db_check_failed", { check: "connectivity", error: err });
    checks.connectivity = {
      status: DbHealthCheckStatus.Error,
      error: GENERIC_ERRORS.connectivity,
    };
  }

  // ISS-8410. `transport` used to be reported BESIDE the verdict rather than
  // in it, so `ALLOW_INSECURE_SSL=1` degraded every connection to unverified
  // TLS while this endpoint answered `ok: true` next to `sslMode: "insecure"` —
  // nothing failed and nobody was alerted.
  //
  // Stated as the SAFE set, not as an excluded unsafe one. Excluding only
  // `Insecure` let two other postures through: `Unknown`, which means the
  // posture could not be read at all, and a REMOTE host carrying
  // `sslmode=disable`, which is plaintext on the wire — graded healthier than
  // the encrypted-but-unverified case this change does fail. Naming the safe
  // set fails those closed and cannot silently admit a member added later.
  //
  // `Verified` rather than `verifiedRdsTls`: a publicly-trusted non-RDS host
  // (a Neon preview) verifies against the same bundle and is not degraded.
  // Localhost is the one deliberate pass — it has no TLS by design, and
  // demanding otherwise would answer not-ok in local development. The stricter
  // "must be verified RDS TLS" demand belongs to the deploy gate, which asks
  // for it per-environment via DB_HEALTH_REQUIRE_RDS_VERIFIED_TLS.
  const transportIsSafe =
    checks.transport.sslMode === DbHealthSslMode.Verified ||
    checks.transport.hostType === DbHealthHostType.Localhost;

  const ok =
    checks.connectivity.status === DbHealthCheckStatus.Ok &&
    checks.migrations.status !== DbHealthCheckStatus.Error &&
    checks.tables.status === DbHealthCheckStatus.Ok &&
    transportIsSafe;

  return {
    timestamp: new Date().toISOString(),
    ok,
    checks,
    ...buildDeploymentMetadata(),
  };
}

function buildDeploymentMetadata(): { deployment?: DbHealthDeployment } {
  const deployment: DbHealthDeployment = {};

  if (process.env.VERCEL_GIT_COMMIT_SHA) {
    deployment.gitSha = process.env.VERCEL_GIT_COMMIT_SHA;
  }

  if (process.env.VERCEL_GIT_COMMIT_REF) {
    deployment.gitCommitRef = process.env.VERCEL_GIT_COMMIT_REF;
  }

  if (process.env.VERCEL_DEPLOYMENT_ID) {
    deployment.vercelDeploymentId = process.env.VERCEL_DEPLOYMENT_ID;
  }

  if (process.env.VERCEL_URL) {
    deployment.vercelUrl = process.env.VERCEL_URL;
  }

  if (Object.keys(deployment).length === 0) {
    return {};
  }

  return { deployment };
}
