/**
 * TS-I.15 — End-to-end smoke test for `pnpm seed`.
 *
 * Asserts:
 *  AC-001  `pnpm seed` exits with code 0.
 *  AC-016  stdout contains a row-count summary line (the "[seed] Total rows seeded per model:" header).
 *  AC-017  The command completes within the local-profile target latency (120 s).
 *
 * This test requires a real database connection and is skipped automatically
 * when the DATABASE_URL environment variable is not set.
 */

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isLocalhostUrl, resolveSslOption } from "../../../db-utils";
import {
  buildPreviewSeedInvocation,
  PREVIEW_SEED_MAX_BUFFER_BYTES,
} from "../../../preview-seed";
import { SeedGuardFailureReason } from "../../cli";
import {
  resolveSeedRunPlan,
  SeedProfileName,
  type SeedProfileTargets,
} from "../../profiles";
import { baselineOrg, baselineUser } from "../fixtures/baseline-org";
import { countProfileModels } from "../fixtures/count-profile-models";
import {
  type EphemeralDbContext,
  setupEphemeralDb,
  teardownEphemeralDb,
} from "../fixtures/ephemeral-db";

const DATABASE_URL_SET = Boolean(process.env.DATABASE_URL);

// Row-count summary header emitted by runSeed() after all domain modules complete.
// See packages/database/scripts/seed/index.ts — seedLog("Total rows seeded per model:")
const ROW_COUNT_SUMMARY_PATTERN = /\[seed\] Total rows seeded per model:/;

// Local-profile latency target: 120 seconds (AC-017).
const LOCAL_LATENCY_MS = 120_000;
// it:171 runs three back-to-back `pnpm seed` subprocesses (each bounded by
// LOCAL_LATENCY_MS) plus an ephemeral-DB teardown/setup and assertions. Budget
// above the three subprocess timeouts so a hang fails via the subprocess timeout
// (captured output), not a bare Vitest abort. See __tests__/timeouts.ts.
const SMOKE_FLOW_TIMEOUT_MS = LOCAL_LATENCY_MS * 3 + 60_000;
const INVALID_PROFILE = "definitely-not-a-seed-profile";
const UNREACHABLE_DATABASE_URL =
  "postgresql://postgres:password@127.0.0.1:1/closedloop_ai";

/**
 * Walks up from `start` until it finds a directory containing any of the
 * `markerFiles` (one of which marks the monorepo root). Throws if no
 * matching directory is found before the filesystem root — that's a
 * configuration error, not something to silently paper over.
 *
 * Preferred to hardcoded `../` depth (which breaks silently if this file
 * ever moves up or down the tree).
 */
function findWorkspaceRoot(start: string, markerFiles: string[]): string {
  let dir = start;
  while (true) {
    if (markerFiles.some((m) => fs.existsSync(path.join(dir, m)))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not locate workspace root from ${start}: no ancestor contains any of ${markerFiles.join(", ")}`
      );
    }
    dir = parent;
  }
}

// Resolve the monorepo root by walking up from this test file until we find
// `pnpm-workspace.yaml` or `turbo.json`. Tolerates the file moving within the
// repo; the previous `../../../../../..` hardcoded depth silently broke when
// any directory between this file and the root was added or removed.
const __filename = fileURLToPath(import.meta.url);
const MONOREPO_ROOT = findWorkspaceRoot(path.dirname(__filename), [
  "pnpm-workspace.yaml",
  "turbo.json",
]);
const DATABASE_PACKAGE_DIR = path.resolve(MONOREPO_ROOT, "packages/database");

type SeedCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  elapsedMs: number;
};

function runSeedCommand(
  args: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env
): SeedCommandResult {
  const startMs = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;

  try {
    const command = ["pnpm seed", ...args].join(" ");
    stdout = execSync(command, {
      cwd: DATABASE_PACKAGE_DIR,
      env: { ...env },
      timeout: LOCAL_LATENCY_MS,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    exitCode = 0;
  } catch (err: unknown) {
    const spawnError = err as {
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    exitCode = spawnError.status ?? 1;
    stdout = spawnError.stdout ?? "";
    stderr = spawnError.stderr ?? "";
  }

  return { stdout, stderr, exitCode, elapsedMs: Date.now() - startMs };
}

function getPrivateBaselineOutputLeaks(output: string): string[] {
  return [
    baselineOrg.name,
    baselineOrg.slug,
    baselineUser.email,
    "postgres:password",
  ].filter((value) => output.includes(value));
}

function getCountsOutOfRange(
  counts: SeedProfileTargets,
  profile: SeedProfileName
): string[] {
  const plan = resolveSeedRunPlan({ profile });
  const failures: string[] = [];
  for (const key of Object.keys(plan.targets) as Array<
    keyof SeedProfileTargets
  >) {
    const count = counts[key];
    const range = plan.targetRanges[key];
    if (count < range.min || count > range.max) {
      failures.push(
        `${key} count ${count} should be within ${range.min}-${range.max}`
      );
    }
  }
  return failures;
}

describe.skipIf(!DATABASE_URL_SET)(
  "pnpm seed — end-to-end smoke (TS-I.15)",
  () => {
    // The `pnpm seed` subprocess opens its own PrismaClient and calls
    // `prisma.user.findFirst()` before doing any work — it exits 1 when no
    // user exists. CI brings up a fresh Postgres container with no rows, so
    // we upsert the baseline Organization + User here. teardownEphemeralDb
    // afterAll removes the seeded data (baseline org/user are left in place
    // for stable re-runs since setupEphemeralDb is idempotent).
    let ctx: EphemeralDbContext;

    beforeAll(async () => {
      ctx = await setupEphemeralDb();
    });

    afterAll(async () => {
      if (ctx) {
        await teardownEphemeralDb(ctx);
      }
    });

    it(
      "runs default twice without growth, then isolates a minimal smoke run (AC-001, AC-016, AC-017)",
      async () => {
        const first = runSeedCommand();

        // AC-001: exit code must be 0.
        expect(
          first.exitCode,
          `pnpm seed exited with code ${first.exitCode}.\nstdout:\n${first.stdout}\nstderr:\n${first.stderr}`
        ).toBe(0);

        // AC-016: stdout must contain the row-count summary header.
        expect(
          ROW_COUNT_SUMMARY_PATTERN.test(first.stdout),
          `Expected stdout to contain row-count summary matching ${ROW_COUNT_SUMMARY_PATTERN}.\nActual stdout:\n${first.stdout}`
        ).toBe(true);
        expect(
          getPrivateBaselineOutputLeaks(first.stdout + first.stderr)
        ).toEqual([]);

        // AC-017: must complete within the local-profile latency target.
        expect(
          first.elapsedMs,
          `pnpm seed took ${first.elapsedMs} ms, which exceeds the 120 s local-profile target`
        ).toBeLessThan(LOCAL_LATENCY_MS);

        const countsBeforeRerun = await countProfileModels(ctx);
        const second = runSeedCommand();
        expect(
          second.exitCode,
          `pnpm seed rerun exited with code ${second.exitCode}.\nstdout:\n${second.stdout}\nstderr:\n${second.stderr}`
        ).toBe(0);
        expect(await countProfileModels(ctx)).toEqual(countsBeforeRerun);

        await teardownEphemeralDb(ctx);
        ctx = await setupEphemeralDb();

        const minimal = runSeedCommand([
          "--",
          "--profile",
          SeedProfileName.Minimal,
        ]);
        expect(
          minimal.exitCode,
          `pnpm seed -- --profile minimal exited with code ${minimal.exitCode}.\nstdout:\n${minimal.stdout}\nstderr:\n${minimal.stderr}`
        ).toBe(0);
        expect(
          getPrivateBaselineOutputLeaks(minimal.stdout + minimal.stderr)
        ).toEqual([]);
        expect(
          getCountsOutOfRange(
            await countProfileModels(ctx),
            SeedProfileName.Minimal
          )
        ).toEqual([]);
      },
      // vitest test-level timeout matches the latency budget.
      SMOKE_FLOW_TIMEOUT_MS
    );
  }
);

describe("pnpm seed — pre-DB CLI guards", () => {
  it("rejects an invalid profile before DB access and keeps diagnostics private", () => {
    const result = runSeedCommand(["--", "--profile", INVALID_PROFILE], {
      ...process.env,
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
      PGHOST: "",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(SeedGuardFailureReason.InvalidProfile);
    expect(result.stdout + result.stderr).not.toContain(
      "Initializing PrismaClient"
    );
    expect(result.stdout + result.stderr).not.toContain("ECONNREFUSED");
    expect(
      getPrivateBaselineOutputLeaks(result.stdout + result.stderr)
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC-005 (FEA-1715) — real `ci-preview --bootstrap-user` subprocess against a
// migrated preview schema. Exercises the actual seed binary end-to-end through
// the production preview-seed invocation (buildPreviewSeedInvocation): module
// resolution, CLI parsing, the schema guard / search_path, synthetic bootstrap
// target resolution, and the real ci-preview fixtures — asserting the bootstrap
// org/user and seeded rows land in the PREVIEW schema, not `public`.
//
// Self-contained: creates and migrates its own `preview_` schema and drops it on
// teardown. Skipped when DATABASE_URL is unset (same as the smoke suite above).
// ---------------------------------------------------------------------------
const PREVIEW_SEED_SCHEMA = "preview_fea1715_ac005";

function makeAdminClient(): pg.Client {
  const url = new URL(process.env.DATABASE_URL as string);
  const sslmode = url.searchParams.get("sslmode");
  url.searchParams.delete("sslmode");
  url.searchParams.delete("schema");
  const ssl = resolveSslOption({
    isLocalhost: isLocalhostUrl(url),
    sslmode,
    allowInsecure: process.env.ALLOW_INSECURE_SSL === "1",
  });
  return new pg.Client({ connectionString: url.toString(), ssl });
}

async function countIn(
  client: pg.Client,
  schema: string,
  table: string,
  whereSql = "",
  params: unknown[] = []
): Promise<number> {
  const { rows } = await client.query(
    `SELECT count(*)::int AS c FROM "${schema}"."${table}" ${whereSql}`,
    params
  );
  return rows[0].c as number;
}

describe.skipIf(!DATABASE_URL_SET)(
  "preview-schema seed via the real subprocess (AC-005, FEA-1715)",
  () => {
    let admin: pg.Client;

    beforeAll(async () => {
      admin = makeAdminClient();
      await admin.connect();
      await admin.query(
        `DROP SCHEMA IF EXISTS "${PREVIEW_SEED_SCHEMA}" CASCADE`
      );
      await admin.query(`CREATE SCHEMA "${PREVIEW_SEED_SCHEMA}"`);
      // Migrate the preview schema (mirrors the migration pipeline's
      // ensureSchemaExists → migrate deploy step).
      const migrateUrl = new URL(process.env.DATABASE_URL as string);
      migrateUrl.searchParams.set("schema", PREVIEW_SEED_SCHEMA);
      execSync("pnpm exec prisma migrate deploy", {
        cwd: DATABASE_PACKAGE_DIR,
        env: { ...process.env, DATABASE_URL: migrateUrl.toString() },
        encoding: "utf-8",
        stdio: "pipe",
        timeout: LOCAL_LATENCY_MS,
      });
    }, LOCAL_LATENCY_MS + 30_000);

    afterAll(async () => {
      if (admin) {
        try {
          await admin.query(
            `DROP SCHEMA IF EXISTS "${PREVIEW_SEED_SCHEMA}" CASCADE`
          );
        } finally {
          await admin.end();
        }
      }
    });

    it(
      "runs ci-preview --bootstrap-user into the preview schema and populates it (AC-005)",
      async () => {
        // Strip any ambient Sandbox identity config so this test deterministically
        // exercises (and asserts) the SYNTHETIC bootstrap path regardless of the
        // CI environment — once the Sandbox clerkIds are provisioned into CI, an
        // un-sanitized env would bind the seed to those real clerkIds and break
        // the synthetic-clerkId assertions below.
        // `sanitizedEnv` is a plain copy (not the real process.env), so setting
        // keys to undefined is safe — spawnSync omits undefined-valued keys from
        // the child env rather than coercing them to the string "undefined".
        const sanitizedEnv: NodeJS.ProcessEnv = { ...process.env };
        sanitizedEnv.SEED_SANDBOX_CLERK_ORG_ID = undefined;
        sanitizedEnv.SEED_SANDBOX_CLERK_USER_ID = undefined;

        // Build the invocation exactly as the migration pipeline does so the
        // authoritative-schema behavior (schema-stripped URL + PGSCHEMA) is
        // exercised, not re-implemented. Pin the subprocess timeout BELOW the
        // it budget (LOCAL_LATENCY_MS + 30s) — not the 300s default — so a hung
        // seed fails via the subprocess (captured output) rather than a bare
        // vitest abort, per the latency convention at the top of this file.
        const invocation = buildPreviewSeedInvocation(
          process.env.DATABASE_URL as string,
          PREVIEW_SEED_SCHEMA,
          sanitizedEnv,
          LOCAL_LATENCY_MS
        );
        const result = spawnSync(invocation.command, invocation.args, {
          cwd: MONOREPO_ROOT,
          env: invocation.env,
          encoding: "utf-8",
          timeout: invocation.timeoutMs,
          maxBuffer: PREVIEW_SEED_MAX_BUFFER_BYTES,
          stdio: ["ignore", "pipe", "pipe"],
        });

        expect(
          result.status,
          `seed exited ${result.status}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
        ).toBe(0);

        // Bootstrap identity landed in the preview schema.
        expect(
          await countIn(
            admin,
            PREVIEW_SEED_SCHEMA,
            "organizations",
            "WHERE clerk_id = $1",
            ["seed_preview_org_synthetic"]
          )
        ).toBe(1);
        expect(
          await countIn(
            admin,
            PREVIEW_SEED_SCHEMA,
            "users",
            "WHERE clerk_id = $1",
            ["seed_preview_user_synthetic"]
          )
        ).toBe(1);

        // ci-preview fixtures populated the preview schema.
        expect(
          await countIn(admin, PREVIEW_SEED_SCHEMA, "projects")
        ).toBeGreaterThan(0);
        expect(
          await countIn(admin, PREVIEW_SEED_SCHEMA, "artifacts")
        ).toBeGreaterThan(0);
      },
      LOCAL_LATENCY_MS + 30_000
    );
  }
);
