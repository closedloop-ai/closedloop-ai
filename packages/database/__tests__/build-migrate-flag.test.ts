/**
 * ISS-4489 Phase 1 — the build-time migrate kill-switch, and its wiring.
 *
 * Two halves, because either alone is a false green:
 *  1. The predicate and the skip line, driven directly with synthetic env.
 *  2. The disabled path EXECUTED: `scripts/migrate.ts` is spawned exactly the
 *     way `prebuild` spawns it, against env that would otherwise migrate, and
 *     the run is required to open no socket, mint no credential, and print the
 *     skip line. That "no `:5432` traffic from the build" property is what lets
 *     api-stage detach its builds from Secure Compute, so it is asserted as
 *     observed behavior rather than as the shape of the source.
 *
 * Half 2 pairs every disabled run with the same run under a truthy flag. The
 * control is load-bearing, not decoration: "zero connections" also holds when
 * the counter is broken, when the script dies at startup, and when the spawn
 * never happened, so without a run that DOES connect the assertion proves
 * nothing. Together the pair pins polarity in both directions — inverting the
 * guard to `if (isBuildMigrateEnabled())` or double-negating it to
 * `if (!!isBuildMigrateEnabled())` fails one side or the other.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  formatBuildMigrateSkipLine,
  isBuildMigrateEnabled,
} from "../scripts/build-migrate-flag";

/** The package root, so the spawn matches `prebuild`'s `tsx scripts/migrate.ts`. */
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX_BIN = fileURLToPath(
  new URL("../node_modules/.bin/tsx", import.meta.url)
);
const MIGRATE_SCRIPT = "scripts/migrate.ts";

/** Two `tsx` boots per test (the disabled run plus its enabled control). */
const SUBPROCESS_TEST_TIMEOUT_MS = 120_000;

const SKIP_MESSAGE = "build_migrate_skipped";
/** Printed by migrate.ts immediately before it mints an IAM token. */
const TOKEN_MARKER = "Generating IAM authentication token";
/** Non-null so the skip line names a schema and `ensureSchemaExists` connects. */
const TARGET_SCHEMA = "preview_iss4489_killswitch";

type MigrateRun = {
  exitCode: number | null;
  output: string;
};

/** A socket that counts connection attempts and refuses them, in place of RDS. */
type FakeDatabase = {
  port: number;
  connections: number;
  close: () => Promise<void>;
};

async function startFakeDatabase(): Promise<FakeDatabase> {
  const state = { connections: 0 };
  const server = createServer((socket) => {
    state.connections += 1;
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake database did not bind a TCP port");
  }

  return {
    port: address.port,
    get connections() {
      return state.connections;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * Runs the shipped migrate script in a child process. The env is built from
 * scratch rather than spread over `process.env` on purpose: an inherited
 * `DATABASE_URL` or AWS credential would satisfy a branch this test claims the
 * kill-switch skipped.
 */
function runMigrateScript(env: NodeJS.ProcessEnv): Promise<MigrateRun> {
  return new Promise<MigrateRun>((resolve, reject) => {
    const child = spawn(TSX_BIN, [MIGRATE_SCRIPT], {
      cwd: PACKAGE_ROOT,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    });

    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      reject(new Error(`failed to spawn ${TSX_BIN}: ${error.message}`));
    });
    child.on("close", (exitCode) => {
      resolve({ exitCode, output });
    });
  });
}

/** The structured skip line, or a failure naming what the run printed instead. */
function parseSkipLine(output: string): Record<string, unknown> {
  const line = output
    .split("\n")
    .find((candidate) => candidate.includes(SKIP_MESSAGE));
  if (!line) {
    throw new Error(`migrate.ts printed no ${SKIP_MESSAGE} line:\n${output}`);
  }
  return JSON.parse(line);
}

describe("isBuildMigrateEnabled (kill-switch, default ON)", () => {
  it("is enabled when unset — the shipped behavior is migrating", () => {
    expect(isBuildMigrateEnabled({})).toBe(true);
  });

  it("is disabled only for explicit falsy tokens", () => {
    for (const raw of ["0", "false", "FALSE", " no ", "Off"]) {
      expect(isBuildMigrateEnabled({ BUILD_MIGRATE_ENABLED: raw })).toBe(false);
    }
  });

  it("stays enabled for truthy tokens and for anything unrecognized", () => {
    // The inverse of `isPreviewMigratorEnabled`'s foot-gun: an unrecognized or
    // empty value must not silently stop migrating a database.
    for (const raw of ["1", "true", "yes", "on", "", "nope", "disabled"]) {
      expect(isBuildMigrateEnabled({ BUILD_MIGRATE_ENABLED: raw })).toBe(true);
    }
  });

  it("reads `0`, the token cl-tofu actually writes, as disabled", () => {
    // Pinned separately because a `!== "false"` implementation passes every
    // other case above and breaks exactly this one, in production only.
    expect(isBuildMigrateEnabled({ BUILD_MIGRATE_ENABLED: "0" })).toBe(false);
  });
});

describe("formatBuildMigrateSkipLine", () => {
  it("names the flag, its value, and the schema that was not migrated", () => {
    const line = JSON.parse(
      formatBuildMigrateSkipLine({
        schema: "preview_iss4489_abc12345",
        env: {
          BUILD_MIGRATE_ENABLED: "0",
          VERCEL_ENV: "preview",
          VERCEL_GIT_COMMIT_REF: "feat/iss-4489",
          VERCEL_DEPLOYMENT_ID: "dpl_123",
        },
      })
    );

    expect(line.message).toBe("build_migrate_skipped");
    expect(line.reason).toBe("BUILD_MIGRATE_ENABLED=0");
    expect(line.schema).toBe("preview_iss4489_abc12345");
    expect(line.vercel_env).toBe("preview");
    expect(line.git_ref).toBe("feat/iss-4489");
    expect(line.deployment_id).toBe("dpl_123");
  });

  it("reports the production-target build as a null schema, not an omission", () => {
    // `resolveSchemaName` returns null for the `public` schema; a missing key
    // would read as "unknown schema" rather than "the production target".
    const line = JSON.parse(
      formatBuildMigrateSkipLine({
        schema: null,
        env: { BUILD_MIGRATE_ENABLED: "0" },
      })
    );

    expect(line).toHaveProperty("schema", null);
    expect(line.vercel_env).toBeNull();
    expect(line.git_ref).toBeNull();
  });

  it("never serializes a credential from the surrounding env", () => {
    const line = formatBuildMigrateSkipLine({
      schema: null,
      env: {
        BUILD_MIGRATE_ENABLED: "0",
        DATABASE_URL: "postgresql://u:sup3rs3cr3t@db.example:5432/app",
        PGHOST: "db.example",
        PGUSER: "u",
      },
    });

    expect(line).not.toContain("sup3rs3cr3t");
    expect(line).not.toContain("db.example");
  });
});

describe("migrate.ts kill-switch, executed (ISS-4489)", () => {
  it(
    "opens no database connection when disabled",
    async () => {
      const database = await startFakeDatabase();
      try {
        // Password auth: `runMigrationPipeline` connects on its first step, so
        // any leak past the guard lands on this socket.
        const passwordAuthEnv: NodeJS.ProcessEnv = {
          DATABASE_URL: `postgresql://migrator:pw@127.0.0.1:${database.port}/app`,
          PGSCHEMA: TARGET_SCHEMA,
        };

        const disabled = await runMigrateScript({
          ...passwordAuthEnv,
          BUILD_MIGRATE_ENABLED: "0",
        });

        expect(database.connections).toBe(0);
        expect(disabled.exitCode).toBe(0);
        expect(parseSkipLine(disabled.output)).toMatchObject({
          message: SKIP_MESSAGE,
          reason: "BUILD_MIGRATE_ENABLED=0",
          schema: TARGET_SCHEMA,
        });

        // Control: identical env, switch ON. Without a run that reaches the
        // socket, "zero connections" above would also pass against a migrate
        // script that crashed at startup or a counter that never counts.
        const enabled = await runMigrateScript(passwordAuthEnv);

        expect(database.connections).toBeGreaterThan(0);
        expect(enabled.output).not.toContain(SKIP_MESSAGE);
      } finally {
        await database.close();
      }
    },
    SUBPROCESS_TEST_TIMEOUT_MS
  );

  it(
    "mints no IAM credential when disabled",
    async () => {
      const database = await startFakeDatabase();
      try {
        // No DATABASE_URL, so the run takes the IAM branch: sign a token, then
        // connect. Both are past the guard.
        const iamAuthEnv: NodeJS.ProcessEnv = {
          AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/iss4489-test",
          AWS_REGION: "us-east-1",
          PGHOST: "127.0.0.1",
          PGPORT: String(database.port),
          PGUSER: "migrator",
          PGDATABASE: "app",
          PGSCHEMA: TARGET_SCHEMA,
        };

        const disabled = await runMigrateScript({
          ...iamAuthEnv,
          BUILD_MIGRATE_ENABLED: "0",
        });

        expect(disabled.output).not.toContain(TOKEN_MARKER);
        expect(database.connections).toBe(0);
        expect(disabled.exitCode).toBe(0);
        expect(parseSkipLine(disabled.output)).toMatchObject({
          message: SKIP_MESSAGE,
          schema: TARGET_SCHEMA,
        });

        // Control: identical env, switch ON. The run reaches credential
        // acquisition and fails there (no OIDC token outside a Vercel build),
        // which is what makes the silence above evidence of the guard.
        const enabled = await runMigrateScript(iamAuthEnv);

        expect(enabled.output).toContain(TOKEN_MARKER);
        expect(enabled.exitCode).not.toBe(0);
      } finally {
        await database.close();
      }
    },
    SUBPROCESS_TEST_TIMEOUT_MS
  );
});
