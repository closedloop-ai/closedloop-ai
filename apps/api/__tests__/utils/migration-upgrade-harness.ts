import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

export type PgQueryResult<
  T extends Record<string, unknown> = Record<string, unknown>,
> = {
  rows: T[];
  rowCount: number | null;
};

export type PgClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[]
  ): Promise<PgQueryResult<T>>;
};

export type MigrationUpgradeScenario = {
  baseMigrationName: string;
  targetMigrationNames: string[];
  databaseNamePrefix: string;
  seed(
    client: PgClient,
    context: MigrationUpgradeContext
  ): Promise<void> | void;
  assert(
    client: PgClient,
    context: MigrationUpgradeContext
  ): Promise<void> | void;
};

export type MigrationUpgradeContext = {
  databaseUrl: string;
  repoRoot: string;
  databasePackageDir: string;
};

export type ExpectedMigrationFailure = {
  databaseName: string;
  databaseUrl: string;
  error: unknown;
  message: string;
  stdout: string;
  stderr: string;
};

export type ExpectedFailureMigrationUpgradeScenario = Omit<
  MigrationUpgradeScenario,
  "assert"
> & {
  assertFailure(
    failure: ExpectedMigrationFailure,
    context: MigrationUpgradeContext
  ): Promise<void> | void;
};

const require = createRequire(import.meta.url);
const pg = require("pg") as {
  Client: new (config: { connectionString: string }) => PgClient;
};

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const databasePackageDir = path.join(repoRoot, "packages/database");
const sourcePrismaDir = path.join(databasePackageDir, "prisma");
// localhost is always allowed. These destructive migration-upgrade tests must
// never touch a real/shared DB, hence the host allowlist. Containerized runners
// (e.g. the Dagger `test` tier, FEA-2294) reach an ephemeral, throwaway Postgres
// only by a service hostname, never localhost — so honor an explicit opt-in that
// names that disposable host. The opt-in is the operator asserting that host is
// disposable; it must point only at a throwaway DB. Default (no env) stays
// localhost-only. blockedDatabaseNames below is a backstop that rejects known
// production-like DB names — NOT a guarantee the opted-in host is safe.
const localDatabaseHosts = new Set(["localhost", "127.0.0.1", "::1"]);
const disposableHostOptIn =
  process.env.MIGRATION_UPGRADE_DISPOSABLE_HOST?.trim();
if (disposableHostOptIn) {
  localDatabaseHosts.add(disposableHostOptIn);
}
const blockedDatabaseNames = new Set([
  "postgres",
  "template0",
  "template1",
  "symphony",
  "symphony_prod",
  "production",
]);
const leadingIpv6BracketPattern = /^\[/;
const trailingIpv6BracketPattern = /\]$/;
const leadingPathSlashPattern = /^\/+/;

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for migration-upgrade tests");
  }
  return databaseUrl;
}

function requireDisposableDatabaseUrl({
  requireLocalHost,
  blockDefaultDatabaseNames,
}: {
  requireLocalHost: boolean;
  blockDefaultDatabaseNames: boolean;
}): URL {
  const url = new URL(requireDatabaseUrl());
  const host = url.hostname
    .replace(leadingIpv6BracketPattern, "")
    .replace(trailingIpv6BracketPattern, "");
  const databaseName = decodeURIComponent(
    url.pathname.replace(leadingPathSlashPattern, "")
  );

  if (requireLocalHost && !localDatabaseHosts.has(host)) {
    throw new Error(
      `Migration-upgrade tests require a local DATABASE_URL host; received "${url.hostname}"`
    );
  }
  if (!databaseName) {
    throw new Error(
      "Migration-upgrade tests require DATABASE_URL to include a database name"
    );
  }
  if (
    blockDefaultDatabaseNames &&
    blockedDatabaseNames.has(databaseName.toLowerCase())
  ) {
    throw new Error(
      `Migration-upgrade tests refuse to use blocked database "${databaseName}"`
    );
  }

  return url;
}

export function canRunMigrationUpgradeScenario(): boolean {
  try {
    requireDisposableDatabaseUrl({
      requireLocalHost: true,
      blockDefaultDatabaseNames: false,
    });
    return true;
  } catch {
    return false;
  }
}

export function canRunMigrationUpgradeScenarioExpectingFailure(): boolean {
  try {
    requireDisposableDatabaseUrl({
      requireLocalHost: true,
      blockDefaultDatabaseNames: true,
    });
    return true;
  } catch {
    return false;
  }
}

function databaseUrlForName(
  baseDatabaseUrl: URL,
  databaseName: string
): string {
  const url = new URL(baseDatabaseUrl.toString());
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function adminDatabaseUrl(baseDatabaseUrl: URL): string {
  const url = new URL(baseDatabaseUrl.toString());
  url.pathname = "/postgres";
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function createDatabase(
  baseDatabaseUrl: URL,
  databaseName: string
): Promise<void> {
  const client = new pg.Client({
    connectionString: adminDatabaseUrl(baseDatabaseUrl),
  });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  } finally {
    await client.end();
  }
}

async function dropDatabase(
  baseDatabaseUrl: URL,
  databaseName: string
): Promise<void> {
  const client = new pg.Client({
    connectionString: adminDatabaseUrl(baseDatabaseUrl),
  });
  await client.connect();
  try {
    await client.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
    );
  } finally {
    await client.end();
  }
}

function copyMigrationsThrough(
  targetMigrationsDir: string,
  migrationName: string
): void {
  for (const entry of readdirSync(path.join(sourcePrismaDir, "migrations"), {
    withFileTypes: true,
  })) {
    const source = path.join(sourcePrismaDir, "migrations", entry.name);
    const target = path.join(targetMigrationsDir, entry.name);
    if (entry.name === "migration_lock.toml") {
      cpSync(source, target);
      continue;
    }
    if (entry.isDirectory() && entry.name <= migrationName) {
      cpSync(source, target, { recursive: true });
    }
  }
}

function copyNamedMigrationToFixture(
  migrationsDir: string,
  migrationName: string
): void {
  cpSync(
    path.join(sourcePrismaDir, "migrations", migrationName),
    path.join(migrationsDir, migrationName),
    { recursive: true }
  );
}

function preparePrismaFixture(baseMigrationName: string): {
  configPath: string;
  migrationsDir: string;
  tmpPath: string;
} {
  const tmpPath = mkdtempSync(path.join(tmpdir(), "migration-upgrade-"));
  const prismaDir = path.join(tmpPath, "prisma");
  const migrationsDir = path.join(prismaDir, "migrations");
  const configPath = path.join(tmpPath, "prisma.config.mjs");
  const schemaPath = path.join(prismaDir, "schema.prisma");
  mkdirSync(migrationsDir, { recursive: true });
  cpSync(path.join(sourcePrismaDir, "schema.prisma"), schemaPath);
  copyMigrationsThrough(migrationsDir, baseMigrationName);
  writeFileSync(
    configPath,
    `export default {
  schema: ${JSON.stringify(schemaPath)},
  migrations: { path: ${JSON.stringify(migrationsDir)} },
  datasource: { url: process.env.DATABASE_URL },
};
`
  );
  return { configPath, migrationsDir, tmpPath };
}

function runMigrateDeploy(configPath: string, databaseUrl: string): void {
  execFileSync(
    "pnpm",
    [
      "-C",
      databasePackageDir,
      "exec",
      "prisma",
      "migrate",
      "deploy",
      "--config",
      configPath,
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    }
  );
}

function outputToString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf-8");
  }
  if (value === undefined || value === null) {
    return "";
  }
  return String(value);
}

function normalizeExpectedMigrationFailure(
  error: unknown,
  databaseName: string,
  databaseUrl: string
): ExpectedMigrationFailure {
  const maybeError = error as {
    message?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
  return {
    databaseName,
    databaseUrl,
    error,
    message:
      error instanceof Error
        ? error.message
        : outputToString(maybeError.message ?? error),
    stdout: outputToString(maybeError.stdout),
    stderr: outputToString(maybeError.stderr),
  };
}

type MigrationUpgradeLifecycle =
  | { mode: "success"; scenario: MigrationUpgradeScenario }
  | {
      mode: "expected-failure";
      scenario: ExpectedFailureMigrationUpgradeScenario;
    };

async function runMigrationUpgradeLifecycle({
  mode,
  scenario,
}: MigrationUpgradeLifecycle): Promise<void> {
  const baseDatabaseUrl =
    mode === "expected-failure"
      ? requireDisposableDatabaseUrl({
          requireLocalHost: true,
          blockDefaultDatabaseNames: true,
        })
      : requireDisposableDatabaseUrl({
          requireLocalHost: true,
          blockDefaultDatabaseNames: false,
        });
  const databaseName = `${scenario.databaseNamePrefix}_${randomUUID().replaceAll("-", "_")}`;
  const databaseUrl = databaseUrlForName(baseDatabaseUrl, databaseName);
  const fixture = preparePrismaFixture(scenario.baseMigrationName);
  let client: PgClient | null = null;

  try {
    await createDatabase(baseDatabaseUrl, databaseName);
    runMigrateDeploy(fixture.configPath, databaseUrl);

    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const context = { databaseUrl, repoRoot, databasePackageDir };
    await scenario.seed(client, context);

    for (const migrationName of scenario.targetMigrationNames) {
      copyNamedMigrationToFixture(fixture.migrationsDir, migrationName);
    }

    if (mode === "success") {
      runMigrateDeploy(fixture.configPath, databaseUrl);
      await scenario.assert(client, context);
      return;
    }

    try {
      runMigrateDeploy(fixture.configPath, databaseUrl);
    } catch (error) {
      await scenario.assertFailure(
        normalizeExpectedMigrationFailure(error, databaseName, databaseUrl),
        context
      );
      return;
    }

    throw new Error("Expected migration deploy to fail, but it succeeded");
  } finally {
    if (client) {
      await client.end();
    }
    await dropDatabase(baseDatabaseUrl, databaseName);
    rmSync(fixture.tmpPath, { recursive: true, force: true });
  }
}

/**
 * Run a migration-upgrade scenario against a fresh Postgres database.
 *
 * The scenario controls the base migration, legacy seed graph, target
 * migrations, and post-upgrade assertions. This catches drift that a normal
 * latest-schema migration test cannot see.
 */
export async function runMigrationUpgradeScenario(
  scenario: MigrationUpgradeScenario
): Promise<void> {
  await runMigrationUpgradeLifecycle({ mode: "success", scenario });
}

export async function runMigrationUpgradeScenarioExpectingFailure(
  scenario: ExpectedFailureMigrationUpgradeScenario
): Promise<void> {
  await runMigrationUpgradeLifecycle({ mode: "expected-failure", scenario });
}
