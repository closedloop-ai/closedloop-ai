/**
 * Cleanup stale preview schemas based on the central preview_schemas registry.
 *
 * - Connects to the stage RDS database using IAM auth (AWS OIDC) or PGPASSWORD.
 * - Reads `public.preview_schemas` to classify each preview_ schema. The
 *   registry is centralized in `public` because `upsertSchemaRegistry()` in
 *   `preview-schema.ts` writes via raw `pg.Client`, which does not honor the
 *   `?schema=` URL parameter, so the connection's search_path stays at public.
 *   (Each preview schema has an empty shadow `preview_schemas` table created
 *   by `cloneDataFromPublic()`; that shadow holds no rows and is not read.)
 * - Drops stale (TTL-expired) and orphaned schemas unless --dry-run is set.
 * - Emits a structured summary line with per-category counters.
 * - Exits non-zero if any per-schema DROP fails.
 *
 * NOTE: AWS RDS Signer tokens are valid for 15 minutes. At current scale the
 * reaper completes well within that window, but do not add unbounded work
 * (e.g., per-schema branch API calls) without revisiting token refresh.
 *
 * Retained as a stage-only operator fallback for direct DB access. The scheduled
 * cleanup and PR-close webhook run through apps/api's preview schema cleanup
 * service, which owns the branch-aware GitHub remote pass.
 */

import { Signer } from "@aws-sdk/rds-signer";
import { normalizePreviewSchemaName } from "../schema-utils";
import {
  buildSummary,
  type CounterBucket,
  categorizeSchema,
  computeExitCode,
  deriveBranchSchemaName,
  getBranchModeCounterBucket,
  makeCounters,
  parseCliArgs,
  validateHost,
} from "./cleanup-preview-schemas-lib";
import { createSslClient, quoteIdentifier } from "./db-utils";

// ---------------------------------------------------------------------------
// Env var reads
// ---------------------------------------------------------------------------

const {
  AWS_REGION,
  PGHOST,
  STAGE_PGHOST,
  PGUSER,
  PGDATABASE,
  PGPORT = "5432",
  PGPASSWORD,
  PREVIEW_SCHEMA_TTL_DAYS = "7",
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  AWS_SESSION_TOKEN,
} = process.env;

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

let cliArgs: ReturnType<typeof parseCliArgs>;
try {
  cliArgs = parseCliArgs(process.argv.slice(2));
} catch (err) {
  console.error(`CLI error: ${(err as Error).message}`);
  process.exit(1);
}

const { dryRun, branch, mode } = cliArgs;

if (mode === "pr-close" && !branch) {
  console.error("pr-close mode requires --branch <name>");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Validate required env vars
// ---------------------------------------------------------------------------

if (!(PGHOST && PGUSER && PGDATABASE)) {
  console.error("Missing required env vars: PGHOST, PGUSER, PGDATABASE");
  process.exit(1);
}

const ttlDays = Number(PREVIEW_SCHEMA_TTL_DAYS);
if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
  console.error("PREVIEW_SCHEMA_TTL_DAYS must be a positive number");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Host validation (AC-006.3)
// ---------------------------------------------------------------------------

const hostError = validateHost({ pgHost: PGHOST, stagePgHost: STAGE_PGHOST });
if (hostError !== null) {
  console.error(`Host validation failed: ${hostError}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Build database URL (IAM auth or PGPASSWORD)
// ---------------------------------------------------------------------------

async function buildDatabaseUrl(): Promise<string> {
  if (PGPASSWORD) {
    return `postgresql://${PGUSER}:${encodeURIComponent(PGPASSWORD)}@${PGHOST}:${PGPORT}/${PGDATABASE}?sslmode=require`;
  }

  if (!(AWS_REGION && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY)) {
    throw new Error(
      "No PGPASSWORD set and AWS credentials are incomplete (need AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)"
    );
  }

  const signer = new Signer({
    hostname: PGHOST!,
    port: Number(PGPORT),
    username: PGUSER!,
    region: AWS_REGION,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
      sessionToken: AWS_SESSION_TOKEN,
    },
  });

  const token = await signer.getAuthToken();
  return `postgresql://${PGUSER}:${encodeURIComponent(token)}@${PGHOST}:${PGPORT}/${PGDATABASE}?sslmode=require`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SchemaDecision = {
  schemaName: string;
  category: "active" | "stale" | "orphaned";
};

/**
 * Reads the central public.preview_schemas registry for a given schema.
 * Returns { registryRow, registryTableMissing } for use with categorizeSchema().
 *
 * The registry is keyed by schema_name (PRIMARY KEY), so this returns at most
 * one row. "No row" is treated as orphaned (the schema exists in pg_namespace
 * but was never registered, e.g. created out-of-band or by an older migrate.ts
 * that predates upsertSchemaRegistry).
 */
async function readRegistryRow(
  client: ReturnType<typeof createSslClient>,
  schemaName: string
): Promise<{
  registryRow: { lastSeenAt: Date } | null;
  registryTableMissing: boolean;
}> {
  try {
    const { rows } = await client.query<{ last_seen_at: string }>(
      `SELECT last_seen_at
       FROM public.preview_schemas
       WHERE schema_name = $1
       ORDER BY last_seen_at DESC
       LIMIT 1`,
      [schemaName]
    );

    if (rows.length === 0) {
      // No row for this schema in the central registry — treated as orphaned.
      return { registryRow: null, registryTableMissing: false };
    }

    return {
      registryRow: { lastSeenAt: new Date(rows[0].last_seen_at) },
      registryTableMissing: false,
    };
  } catch (err) {
    // SQLSTATE 42P01 = undefined_table; only this signals a truly missing
    // registry table (e.g. fresh database before any preview deploy ran). Mark
    // all preview schemas as orphaned in that edge case.
    if ((err as { code?: string }).code === "42P01") {
      return { registryRow: null, registryTableMissing: true };
    }
    // Any other error (permission denied, timeout, connection blip, etc.) is
    // transient/unknown. Rethrow so the caller can skip the schema rather than
    // misclassify it as orphaned and drop it.
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main reap loop — helpers
// ---------------------------------------------------------------------------

// Branch mode is operator-driven (surgical drop via --branch). It does NOT
// consult the registry, TTL, or remote branch list — the operator is
// asserting the target schema should be dropped. The preview_ prefix check in
// deriveBranchSchemaName is the only safety guard.
async function runBranchMode(
  client: ReturnType<typeof createSslClient>,
  counters: ReturnType<typeof makeCounters>,
  branchName: string,
  bucket: CounterBucket
): Promise<void> {
  const schemaName = deriveBranchSchemaName(
    branchName,
    normalizePreviewSchemaName
  );
  console.log(
    `Branch mode: targeting schema ${schemaName} (branch: ${branchName})`
  );

  if (dryRun) {
    console.log(`[dry-run] Would drop schema: ${schemaName}`);
    counters[bucket].kept += 1;
    return;
  }

  const quoted = quoteIdentifier(schemaName);
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    console.log(`Dropped schema: ${schemaName}`);
    counters[bucket].dropped += 1;
  } catch (err) {
    console.error(
      `Failed to drop schema ${schemaName}: ${(err as Error).message}`
    );
    counters[bucket].errored += 1;
  }
}

async function dropSchemas(
  client: ReturnType<typeof createSslClient>,
  schemaNames: string[],
  label: string,
  bucket: { dropped: number; errored: number }
): Promise<void> {
  for (const schemaName of schemaNames) {
    const quoted = quoteIdentifier(schemaName);
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
      console.log(`Dropped ${label} schema: ${schemaName}`);
      bucket.dropped += 1;
    } catch (err) {
      console.error(
        `Failed to drop ${label} schema ${schemaName}: ${(err as Error).message}`
      );
      bucket.errored += 1;
    }
  }
}

async function categorizeAllSchemas(
  client: ReturnType<typeof createSslClient>,
  schemaRows: { schema_name: string }[],
  now: Date,
  counters: ReturnType<typeof makeCounters>
): Promise<SchemaDecision[]> {
  const decisions: SchemaDecision[] = [];

  for (const { schema_name: schemaName } of schemaRows) {
    let registryRow: { lastSeenAt: Date } | null;
    let registryTableMissing: boolean;
    try {
      ({ registryRow, registryTableMissing } = await readRegistryRow(
        client,
        schemaName
      ));
    } catch (err) {
      // Transient/unknown registry-read error — skip without dropping.
      // Tracked under registryReadErrored (not orphan.errored) so operators
      // can distinguish classification failures from DROP failures.
      // computeExitCode still forces non-zero exit so monitoring catches it.
      console.warn(
        `Warning: skipping ${schemaName}: could not read registry: ${(err as Error).message}`
      );
      counters.registryReadErrored += 1;
      continue;
    }

    const category = categorizeSchema({
      schemaName,
      registryRow,
      registryTableMissing,
      ttlDays,
      now,
    });

    decisions.push({ schemaName, category });
  }

  return decisions;
}

// ---------------------------------------------------------------------------
// Main reap loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const databaseUrl = await buildDatabaseUrl();
  const client = createSslClient(databaseUrl);
  await client.connect();

  const counters = makeCounters();
  const now = new Date();

  try {
    // --branch mode or pr-close mode: derive the schema for that branch, drop
    // it, and skip the daily enumeration. pr-close mode was validated above to
    // require --branch.
    if (branch === null) {
      // Standard reap loop: enumerate all preview_ schemas.
      const { rows: schemaRows } = await client.query<{ schema_name: string }>(
        `SELECT schema_name
         FROM information_schema.schemata
         WHERE schema_name LIKE 'preview_%'
         ORDER BY schema_name`
      );

      if (schemaRows.length === 0) {
        console.log("No preview schemas found.");
      } else {
        console.log(
          `Found ${schemaRows.length} preview schema(s). mode=${mode}`
        );

        const decisions = await categorizeAllSchemas(
          client,
          schemaRows,
          now,
          counters
        );

        const staleSchemas = decisions
          .filter((d) => d.category === "stale")
          .map((d) => d.schemaName);
        const orphanedSchemas = decisions
          .filter((d) => d.category === "orphaned")
          .map((d) => d.schemaName);
        const activeSchemas = decisions
          .filter((d) => d.category === "active")
          .map((d) => d.schemaName);

        console.log(
          `Categorized: ${staleSchemas.length} stale (ttl-expired), ${orphanedSchemas.length} orphaned, ${activeSchemas.length} active`
        );

        if (dryRun) {
          // Report would-drop counts and a sample of names — execute zero DROPs.
          const staleSample = staleSchemas.slice(0, 5).join(", ") || "(none)";
          const orphanSample =
            orphanedSchemas.slice(0, 5).join(", ") || "(none)";

          console.log(
            `[dry-run] Would drop ${staleSchemas.length} ttl-expired schema(s). Sample: ${staleSample}`
          );
          console.log(
            `[dry-run] Would drop ${orphanedSchemas.length} orphan schema(s). Sample: ${orphanSample}`
          );
          console.log(
            `[dry-run] Kept ${activeSchemas.length} active schema(s).`
          );

          counters["ttl-expired"].kept = staleSchemas.length;
          counters.orphan.kept = orphanedSchemas.length;
        } else {
          await dropSchemas(
            client,
            staleSchemas,
            "stale",
            counters["ttl-expired"]
          );
          await dropSchemas(
            client,
            orphanedSchemas,
            "orphaned",
            counters.orphan
          );
        }
      }
    } else {
      await runBranchMode(
        client,
        counters,
        branch,
        getBranchModeCounterBucket(mode)
      );
    }
  } finally {
    await client.end();
  }

  const summary = buildSummary(counters);
  console.log(summary);
  process.exit(computeExitCode(counters));
}

main().catch((err) => {
  console.error(`Unexpected error: ${(err as Error).message}`);
  process.exit(1);
});
