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
import { requireFixtureDatabaseUrl } from "@/__tests__/utils/fixture-db";

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

// Anchored on the `@repo/database` package, not on this file's own depth.
// Counting `..` up from `import.meta.dirname` re-breaks every time the harness
// moves — and ISS-8553 moved it, landing `repoRoot` on `apps/` and every schema
// read on a path that does not exist.
const databasePackageDir = path.dirname(
  require.resolve("@repo/database/package.json")
);
const repoRoot = path.resolve(databasePackageDir, "../..");
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

/**
 * Whether `DATABASE_URL` names a database a test may freely write to and throw
 * away: a local host, and not one of the shared or default names.
 *
 * Exported under its own name because the check is not specific to the
 * migration-upgrade scenarios — `DATABASE_URL` being merely PRESENT is not the
 * same question, and any suite invoking an UNSCOPED production routine needs
 * this one instead.
 */
export function hasDisposableDatabase(): boolean {
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

export function canRunMigrationUpgradeScenarioExpectingFailure(): boolean {
  return hasDisposableDatabase();
}

/**
 * The identity every connection this harness opens uses.
 *
 * All of them create a database, run `prisma migrate deploy`, seed a throwaway
 * schema, or drop it again — the MIGRATOR's work under the ISS-5978 role split,
 * none of it the runtime role's. Only the CREDENTIALS move: host, port and
 * database name stay the ones `requireDisposableDatabaseUrl` already validated,
 * and `requireFixtureDatabaseUrl` refuses a fixture URL naming a different
 * host or database, so pointing `MIGRATE_DATABASE_URL` elsewhere cannot
 * sidestep the disposable-host allowlist above.
 */
function withFixtureCredentials(baseDatabaseUrl: URL): URL {
  const fixture = new URL(requireFixtureDatabaseUrl("migration-upgrade tests"));
  const url = new URL(baseDatabaseUrl.toString());
  url.username = fixture.username;
  url.password = fixture.password;
  return url;
}

function databaseUrlForName(
  baseDatabaseUrl: URL,
  databaseName: string
): string {
  const url = withFixtureCredentials(baseDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function adminDatabaseUrl(baseDatabaseUrl: URL): string {
  const url = withFixtureCredentials(baseDatabaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function createDatabase(
  baseDatabaseUrl: URL,
  databaseName: string,
  templateName?: string
): Promise<void> {
  const client = new pg.Client({
    connectionString: adminDatabaseUrl(baseDatabaseUrl),
  });
  await client.connect();
  const template = templateName
    ? ` TEMPLATE ${quoteIdentifier(templateName)}`
    : "";
  try {
    await client.query(
      `CREATE DATABASE ${quoteIdentifier(databaseName)}${template}`
    );
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

/**
 * ISS-8553 — one replay of the base migrations per base, not one per scenario.
 *
 * Replaying 147 migrations through the Prisma CLI costs ~15s, and the suite's
 * scenarios each wanted their own isolated database, so the cost was paid six
 * times inside a single test. Postgres already copies a database far more
 * cheaply than it can be rebuilt, so the replay lands once in a template and
 * every scenario still gets a database of its own via `CREATE DATABASE ...
 * TEMPLATE` — isolation unchanged, the replay amortized. Keyed by base
 * migration because that is the only thing the replay depends on.
 */
const templateDatabasesByBaseMigration = new Map<
  string,
  { baseDatabaseUrl: URL; databaseName: string }
>();

async function templateDatabaseFor(
  baseDatabaseUrl: URL,
  baseMigrationName: string
): Promise<string> {
  const cached = templateDatabasesByBaseMigration.get(baseMigrationName);
  if (cached) {
    return cached.databaseName;
  }
  const databaseName = `migration_upgrade_template_${randomUUID().replaceAll("-", "_")}`;
  const fixture = preparePrismaFixture(baseMigrationName);
  try {
    await createDatabase(baseDatabaseUrl, databaseName);
    runMigrateDeploy(
      fixture.configPath,
      databaseUrlForName(baseDatabaseUrl, databaseName)
    );
  } catch (error) {
    await dropDatabase(baseDatabaseUrl, databaseName);
    throw error;
  } finally {
    rmSync(fixture.tmpPath, { recursive: true, force: true });
  }
  templateDatabasesByBaseMigration.set(baseMigrationName, {
    baseDatabaseUrl,
    databaseName,
  });
  return databaseName;
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
  const templateName = await templateDatabaseFor(
    baseDatabaseUrl,
    scenario.baseMigrationName
  );
  const fixture = preparePrismaFixture(scenario.baseMigrationName);
  let client: PgClient | null = null;

  try {
    await createDatabase(baseDatabaseUrl, databaseName, templateName);

    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    const context = { databaseUrl, repoRoot, databasePackageDir };
    await scenario.seed(client, context);

    for (const migrationName of scenario.targetMigrationNames) {
      copyNamedMigrationToFixture(fixture.migrationsDir, migrationName);
    }

    if (mode === "success") {
      // Nothing was copied in, so the fixture still names exactly the
      // migrations the template already carries: deploying it applies nothing.
      // An expected-failure scenario still deploys unconditionally, because a
      // deploy that unexpectedly succeeds is the outcome it asserts on.
      if (scenario.targetMigrationNames.length > 0) {
        runMigrateDeploy(fixture.configPath, databaseUrl);
      }
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

/**
 * Replay the base migrations once, before any scenario runs, so the cost lands
 * in a suite-level hook instead of inside the first test that happens to ask
 * for it. Scenarios clone the result; calling this is an optimization, not a
 * precondition.
 */
export async function prepareMigrationUpgradeTemplate(
  baseMigrationName: string
): Promise<void> {
  await templateDatabaseFor(
    requireDisposableDatabaseUrl({
      requireLocalHost: true,
      blockDefaultDatabaseNames: false,
    }),
    baseMigrationName
  );
}

/** Drop every template database this process provisioned. */
export async function releaseMigrationUpgradeTemplates(): Promise<void> {
  const templates = [...templateDatabasesByBaseMigration.values()];
  templateDatabasesByBaseMigration.clear();
  for (const template of templates) {
    await dropDatabase(template.baseDatabaseUrl, template.databaseName);
  }
}
