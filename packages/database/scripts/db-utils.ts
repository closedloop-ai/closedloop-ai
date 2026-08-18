import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import tls from "node:tls";
import { TextDecoder } from "node:util";
import {
  DbHealthAuthMode,
  DbHealthCheckStatus,
  DbHealthHostType,
  DbHealthSource,
  DbHealthSslMode,
  type DbHealthTransportCheck,
  DbHealthTransportError,
} from "@repo/api/src/types/db-health";
import pg from "pg";
import { z } from "zod";
import { AWS_RDS_CA_BUNDLE } from "./rds-ca-bundle";

/**
 * `ssl` option shape accepted by `pg.Client` / `pg.Pool`. Either `false`
 * (no TLS — used for localhost) or an object that controls cert verification.
 * `ca` carries an explicit trust-anchor list on the verifying path (see
 * `VERIFIED_SSL_CA`).
 */
export type SslOption =
  | false
  | { rejectUnauthorized: boolean; ca?: string | string[] };

/**
 * Trust anchors for the verifying TLS path. Node's `tls` `ca` option REPLACES
 * the default trust store rather than appending to it, so we merge the bundled
 * Mozilla roots (`tls.rootCertificates`, which verify publicly-trusted hosts
 * such as Neon) with Amazon's RDS CA bundle — which is NOT present in many
 * runtimes' default store, notably Vercel's, where its absence produced
 * `SELF_SIGNED_CERT_IN_CHAIN` and took prod DB connectivity down. The union
 * verifies both RDS and publicly-trusted endpoints under
 * `rejectUnauthorized: true`, so no path has to drop verification.
 */
const VERIFIED_SSL_CA: readonly string[] = [
  ...tls.rootCertificates,
  AWS_RDS_CA_BUNDLE,
];

/**
 * Hostnames the pg driver should connect to without TLS.
 *
 * - `localhost` / `127.0.0.1`: standard IPv4 localhost.
 * - `::1` / `[::1]`: IPv6 localhost. Some Docker on Linux distros default
 *   to `::1` even when the user types `localhost` in the URL; `new URL()`
 *   strips the brackets but pg sees the raw hostname, so both forms must
 *   be recognized.
 */
const LOCALHOST_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
]);

const RDS_HOST_SUFFIXES = [
  ".rds.amazonaws.com",
  ".rds.amazonaws.com.cn",
] as const;

/**
 * Returns true when the URL's hostname resolves to the local machine — used
 * to decide whether to skip TLS entirely.
 */
export function isLocalhostUrl(url: URL): boolean {
  return LOCALHOST_HOSTNAMES.has(url.hostname);
}

/**
 * Single source of truth for "should this DB connection use TLS, and should
 * the server certificate be verified?" Applies the policy:
 *
 *   - localhost / 127.0.0.1 / ::1      → no TLS
 *   - explicit `?sslmode=disable`      → no TLS
 *   - `allowInsecure: true`            → TLS without cert verification
 *                                        (legacy escape hatch for endpoints
 *                                        whose chain still isn't trusted)
 *   - everything else                  → TLS with cert verification against
 *                                        the system roots + RDS CA bundle
 *                                        (`VERIFIED_SSL_CA`); safe default
 *
 * Used by both `seed.ts` and the integration-test fixture
 * (`scripts/seed/__tests__/fixtures/ephemeral-db.ts`) so that the SSL policy
 * lives in one place. `createSslClient` below delegates to this with
 * `allowInsecure: true` to preserve its long-standing behavior for the
 * preview-DB tooling that uses it.
 */
export function resolveSslOption(opts: {
  isLocalhost: boolean;
  sslmode: string | null;
  allowInsecure: boolean;
}): SslOption {
  if (opts.isLocalhost) {
    return false;
  }
  if (opts.sslmode === "disable") {
    return false;
  }
  if (opts.allowInsecure) {
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true, ca: [...VERIFIED_SSL_CA] };
}

export function classifyDatabaseTransport(input: {
  databaseUrl?: string | null;
  pgHost?: string | null;
  pgDatabase?: string | null;
  pgUser?: string | null;
  allowInsecureSsl?: boolean;
}): DbHealthTransportCheck {
  if (input.databaseUrl) {
    return classifyDatabaseUrlTransport(
      input.databaseUrl,
      input.allowInsecureSsl === true
    );
  }

  if (input.pgHost && input.pgDatabase && input.pgUser) {
    const hostType = classifyHostType(input.pgHost);
    const sslMode = classifySslMode({
      hostType,
      sslmode: null,
      allowInsecureSsl: input.allowInsecureSsl === true,
    });

    return buildTransportCheck({
      source: DbHealthSource.PgHostIam,
      authMode: DbHealthAuthMode.Iam,
      hostType,
      sslMode,
    });
  }

  return buildUnknownTransportCheck();
}

/**
 * `opts.connectionTimeoutMillis` bounds the CONNECT itself. pg's default is `0`
 * — wait forever — so a blackholed or unreachable endpoint hangs before any
 * `SET statement_timeout` the caller issues can possibly apply (ISS-5285).
 * Optional, so every existing caller keeps today's behavior; pass it wherever an
 * unbounded connect could hold a build open.
 */
export function createSslClient(
  databaseUrl: string,
  opts: { connectionTimeoutMillis?: number } = {}
) {
  const url = new URL(databaseUrl);
  const isLocalhost = isLocalhostUrl(url);
  const sslmode = url.searchParams.get("sslmode");
  url.searchParams.delete("sslmode");

  // Preserve historical behavior of this helper (preview-DB tooling in
  // clone-schema.ts / preview-schema.ts / cleanup-preview-schemas.mjs):
  // unverified TLS against arbitrary RDS endpoints. Callers that want the
  // safe default should call `resolveSslOption({ allowInsecure: false })`
  // directly.
  const ssl = resolveSslOption({ isLocalhost, sslmode, allowInsecure: true });

  return new pg.Client({
    connectionString: url.toString(),
    ssl,
    ...(opts.connectionTimeoutMillis === undefined
      ? {}
      : { connectionTimeoutMillis: opts.connectionTimeoutMillis }),
  });
}

export function quoteIdentifier(value: string) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

/**
 * The `CREATE [UNIQUE] INDEX` head of an index DDL statement, captured so callers
 * can rewrite what follows it. Shared by `preview-plain-index.ts` (which forces
 * `IF NOT EXISTS` onto a plain build) and `invalid-index-sweep.ts` (which inserts
 * `CONCURRENTLY` into a `pg_get_indexdef` string) so the two cannot drift.
 */
export const CREATE_INDEX_HEAD_REGEX = /^(create\s+(?:unique\s+)?index)\s+/i;

/**
 * Floor for a budget-clamped timeout. Postgres reads a `statement_timeout` of `0`
 * as "no timeout", so a budget that has run out must never clamp to it — that
 * would turn an exhausted deadline into an unbounded wait.
 */
export const MIN_TIMEOUT_MS = 1000;

/**
 * Caps a fixed timeout at the caller's remaining `budgetMs` (the FEA-3071 walk's
 * admission deadline) so a step cannot run past it, with the non-zero floor
 * above. `undefined` budget → the fixed value unchanged.
 *
 * Shared by `preview-plain-index.ts` and `invalid-index-sweep.ts` — same reason
 * `CREATE_INDEX_HEAD_REGEX` lives here rather than in each of them.
 */
export function clampTimeoutMs(
  fixedMs: number,
  budgetMs: number | undefined
): number {
  if (budgetMs === undefined) {
    return fixedMs;
  }
  return Math.max(MIN_TIMEOUT_MS, Math.min(fixedMs, budgetMs));
}

/**
 * Hostname substrings that identify a production database. Any hostname that
 * CONTAINS one of these substrings is treated as production.
 *
 * Matching is intentionally broad (plain substring, not segment-aware). This
 * is a fail-closed safety denylist whose only job is to reject production
 * hosts, so over-rejecting a borderline name is preferable to letting a
 * production-shaped host (e.g. `cl-ai-production-db.aws.com`,
 * `production.rds.amazonaws.com`) slip through.
 *
 * The non-localhost fail-closed guard in seed.ts is the primary safety net;
 * these patterns are defense-in-depth on top of it to reject known
 * production-shaped names even when SEED_ALLOW_REMOTE=1 is set.
 */
export const PRODUCTION_HOST_PATTERNS: readonly string[] = [
  "cl-ai-prod",
  ".prod.",
  "production",
  "prod-",
];

/**
 * Returns the first production pattern contained in the supplied hostname, or
 * `null` when none match.
 *
 * This is a pure function: it takes a plain string and returns a string or
 * null - no side effects, no env-var reads, no process.exit. Callers decide
 * what to do with the result. Matching is a plain substring check against
 * PRODUCTION_HOST_PATTERNS - fail-closed, so it over-rejects rather than
 * under-rejects.
 *
 * @param hostname - The bare hostname string to inspect (no scheme, no port,
 *   no path). Typically `new URL(databaseUrl).hostname`.
 * @returns The first matched pattern string, or `null` if no pattern matched.
 */
export function matchesProductionHostPattern(hostname: string): string | null {
  const normalizedHostname = hostname.toLowerCase();
  for (const pattern of PRODUCTION_HOST_PATTERNS) {
    if (normalizedHostname.includes(pattern)) {
      return pattern;
    }
  }
  return null;
}

function classifyDatabaseUrlTransport(
  databaseUrl: string,
  allowInsecureSsl: boolean
): DbHealthTransportCheck {
  try {
    const url = new URL(databaseUrl);
    const hostType = classifyHostType(url.hostname);
    const sslMode = classifySslMode({
      hostType,
      sslmode: url.searchParams.get("sslmode"),
      allowInsecureSsl,
    });

    return buildTransportCheck({
      source: DbHealthSource.DatabaseUrl,
      authMode: DbHealthAuthMode.Password,
      hostType,
      sslMode,
    });
  } catch {
    return buildUnknownTransportCheck();
  }
}

function classifyHostType(hostname: string): DbHealthHostType {
  const normalizedHostname = hostname.toLowerCase();

  if (LOCALHOST_HOSTNAMES.has(normalizedHostname)) {
    return DbHealthHostType.Localhost;
  }

  if (RDS_HOST_SUFFIXES.some((suffix) => normalizedHostname.endsWith(suffix))) {
    return DbHealthHostType.Rds;
  }

  if (normalizedHostname.length > 0) {
    return DbHealthHostType.Other;
  }

  return DbHealthHostType.Unknown;
}

function classifySslMode(input: {
  hostType: DbHealthHostType;
  sslmode: string | null;
  allowInsecureSsl: boolean;
}): DbHealthSslMode {
  if (input.hostType === DbHealthHostType.Localhost) {
    return DbHealthSslMode.Disabled;
  }

  if (input.sslmode?.toLowerCase() === "disable") {
    return DbHealthSslMode.Disabled;
  }

  if (input.allowInsecureSsl) {
    return DbHealthSslMode.Insecure;
  }

  if (input.hostType === DbHealthHostType.Unknown) {
    return DbHealthSslMode.Unknown;
  }

  return DbHealthSslMode.Verified;
}

function buildTransportCheck(input: {
  source: DbHealthSource;
  authMode: DbHealthAuthMode;
  hostType: DbHealthHostType;
  sslMode: DbHealthSslMode;
}): DbHealthTransportCheck {
  const verifiedRdsTls =
    input.hostType === DbHealthHostType.Rds &&
    input.sslMode === DbHealthSslMode.Verified;

  if (verifiedRdsTls) {
    return {
      status: DbHealthCheckStatus.Ok,
      hostType: input.hostType,
      sslMode: input.sslMode,
      authMode: input.authMode,
      source: input.source,
      verifiedRdsTls,
    };
  }

  return {
    status: DbHealthCheckStatus.Error,
    hostType: input.hostType,
    sslMode: input.sslMode,
    authMode: input.authMode,
    source: input.source,
    verifiedRdsTls,
    error: getTransportError(input.hostType, input.sslMode),
  };
}

function buildUnknownTransportCheck(): DbHealthTransportCheck {
  return {
    status: DbHealthCheckStatus.Error,
    hostType: DbHealthHostType.Unknown,
    sslMode: DbHealthSslMode.Unknown,
    authMode: DbHealthAuthMode.Unknown,
    source: DbHealthSource.Unknown,
    verifiedRdsTls: false,
    error: DbHealthTransportError.UnknownPosture,
  };
}

function getTransportError(
  hostType: DbHealthHostType,
  sslMode: DbHealthSslMode
): DbHealthTransportError {
  if (sslMode === DbHealthSslMode.Disabled) {
    return DbHealthTransportError.TlsDisabled;
  }

  if (sslMode === DbHealthSslMode.Insecure) {
    return DbHealthTransportError.TlsInsecure;
  }

  if (hostType === DbHealthHostType.Unknown) {
    return DbHealthTransportError.UnknownPosture;
  }

  return DbHealthTransportError.NotRds;
}

/**
 * Narrow `pg.Client` surface shared by the migration-time DB helpers (the
 * migration-lock.ts serialize gate and preview-prestamp.ts). Kept minimal so
 * tests can mock it without the full `pg.Client` type. Note `pg.Client` does
 * NOT reliably match this structurally — its heavily-overloaded `query` defeats
 * a direct assignment — which is why `createSqlClient` below adapts it by
 * explicit delegation rather than casting `createSslClient`'s result.
 */
export type SqlClient = {
  connect(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
};

/**
 * Adapts the real `pg.Client` (from `createSslClient`) to the narrow `SqlClient`
 * surface via explicit delegation — avoids relying on `pg.Client.query`'s heavy
 * overloads structurally matching `SqlClient`. Default factory for the
 * migration-time helpers.
 *
 * `opts.connectionTimeoutMillis` is forwarded to `createSslClient` — omitted, pg
 * waits forever on the connect (see its note above), which on the deploy critical
 * path is a hang rather than an error. Existing callers pass nothing and are
 * unchanged.
 */
export function createSqlClient(
  databaseUrl: string,
  opts: { connectionTimeoutMillis?: number } = {}
): SqlClient {
  const client = createSslClient(databaseUrl, opts);
  return {
    connect: async () => {
      await client.connect();
    },
    query: (text, values) => client.query(text, values),
    end: async () => {
      await client.end();
    },
  };
}

/**
 * Close a client without letting a disconnect error escape — a failed close
 * must never fail the caller (a deploy). No-op on `null`.
 */
export async function endQuietly(client: SqlClient | null): Promise<void> {
  if (!client) {
    return;
  }
  try {
    await client.end();
  } catch {
    // Best-effort close.
  }
}

/**
 * STRICT UTF-8, and both options are load-bearing:
 *
 * - `fatal` makes malformed input THROW instead of substituting U+FFFD, which is
 *   what `readFileSync(…, "utf8")` does silently. See `decodeMigrationSql`.
 * - `ignoreBOM` (i.e. "do not strip it") keeps a leading BOM as a real U+FEFF, so
 *   decoding is byte-exact — the property `migrationChecksum` depends on. The
 *   default would swallow the BOM and derive a checksum over bytes that are not
 *   the file's.
 */
const MIGRATION_SQL_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

/**
 * Decodes `migration.sql` bytes as strict UTF-8, THROWING on malformed input
 * rather than substituting U+FFFD.
 *
 * The substitution is not cosmetic here: it is silent data corruption that
 * reaches `_prisma_migrations`. `readFileSync(…, "utf8")` never rejects bad
 * bytes, so a corrupt file would yield a plausible string, `migrationChecksum`
 * would hash bytes the file does not contain, and `preview-prestamp.ts` would
 * stamp the migration APPLIED with that value — and `migrate deploy` matches an
 * applied row on `migration_name` + `finished_at` without validating the
 * checksum, so it would skip the build of a migration nobody could read. Both
 * callers already have a correct answer for an unreadable file (fail-CLOSED for
 * the plain-build entries, warn-and-skip for perf-only); throwing is what routes
 * a corrupt file to it instead of past it.
 *
 * Rejecting is also the faithful behaviour: Prisma's engine reads migrations
 * with Rust `read_to_string`, which refuses non-UTF-8 outright, so such a file
 * has no Prisma checksum to match in the first place.
 */
export function decodeMigrationSql(migrationSqlBytes: Uint8Array): string {
  return MIGRATION_SQL_DECODER.decode(migrationSqlBytes);
}

/**
 * The Prisma migrations directory the build resolves: `prisma/migrations`
 * relative to `process.cwd()` — the same base `prisma migrate deploy` uses (NOT
 * `import.meta.dirname`, which is undefined under tsx's CJS transform and would
 * crash the migrate run at import; see preview-at-head.ts). Evaluated lazily,
 * never at module load, for the same reason.
 */
export function defaultMigrationsDir(): string {
  return join(process.cwd(), "prisma", "migrations");
}

/**
 * Reads a migration's SQL from `<migrationsDir>/<name>/migration.sql`.
 *
 * Reads raw bytes and decodes them through `decodeMigrationSql`, so a file that
 * is not valid UTF-8 throws here exactly like a missing one — see that function
 * for why a substituted U+FFFD would be worse than an error.
 *
 * Both failures are rethrown WITH THE RESOLVED PATH, because this is the only
 * frame that knows it. `readFileSync`'s ENOENT carries the path itself, but a
 * strict-decode failure does not: Node's `TypeError[ERR_ENCODING_INVALID_ENCODED_DATA]`
 * has only `code` as an own property, so its bare message ("The encoded data was
 * not valid for encoding utf-8") reaches the operator with no migration name and
 * no file — through `preview-prestamp.ts`'s fail-CLOSED refusal, which interpolates
 * just the message, that is a red preview deploy against 302 candidate files and
 * nothing to point at. Raise it where the actionable detail lives (root AGENTS.md,
 * "Handling Bad or Nonsensical Data").
 *
 * Shared by `preview-plain-index.ts` (which rewrites the CONCURRENTLY builds into
 * plain ones) and `preview-prestamp.ts` (which checksums the file), for the same
 * reason `CREATE_INDEX_HEAD_REGEX` lives here: both resolve the identical path off
 * the identical base, and a second copy would be free to drift from this one.
 *
 * ISS-6810: `migrationsDir` is that base, and it defaults to the cwd-relative
 * one. A caller whose cwd is NOT the Prisma project — the ensure route, whose
 * function runs from `apps/api` while the migrations are traced in at
 * `packages/database/prisma/migrations` — names it per run.
 */
export function readMigrationSql(
  migrationName: string,
  migrationsDir: string = defaultMigrationsDir()
): string {
  const migrationSqlPath = join(migrationsDir, migrationName, "migration.sql");
  try {
    return decodeMigrationSql(readFileSync(migrationSqlPath));
  } catch (error) {
    throw new Error(
      `Could not read migration SQL at ${migrationSqlPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }
}

/**
 * A `_prisma_migrations` row, as the migrate-time helpers read it.
 *
 * node-postgres parses the timestamptz columns to `Date | null` (a string form is
 * coerced too, defensively). Only null-ness is consulted: `finished_at` non-null
 * + `rolled_back_at` null ⇒ applied; both null ⇒ an unresolved (in-flight/failed)
 * migration Prisma would surface as P3009 and will act on again.
 *
 * Shared by `preview-at-head.ts` (the at-head probe) and `ownership-preflight.ts`
 * (the pending-work half of its decision matrix) for the same reason
 * `CREATE_INDEX_HEAD_REGEX` lives here: two copies of one row contract are free
 * to drift, and both consumers must agree on what "applied" means.
 */
export const MigrationRowSchema = z.object({
  migration_name: z.string(),
  finished_at: z.coerce.date().nullable(),
  rolled_back_at: z.coerce.date().nullable(),
});

/**
 * Prisma's canonical `_prisma_migrations.checksum` for a migration: the SHA-256
 * of `migration.sql`'s bytes, lowercase hex. This is Prisma's own algorithm, not
 * an approximation of it — verified empirically against a checksum `prisma
 * migrate deploy` 7.8.0 wrote for a real migration (the fixture in
 * `preview-prestamp.test.ts`).
 *
 * That fixture is a RECORDED value, not a live comparison, and the distinction
 * matters: it re-derives nothing from the installed Prisma, so it pins THIS
 * function against the observed 7.8.0 output and catches a change on OUR side
 * only. A Prisma upgrade that changed the algorithm would NOT fail it. Grounding
 * that would take a real Postgres for Prisma to write a fresh row against — 7.8.0
 * computes the checksum in the Rust schema engine and exposes no JS API for it —
 * which is a DB-backed integration test, not this unit fixture (ISS-4600 review).
 * That test now exists and closes the gap — "derives exactly the checksum Prisma
 * itself wrote, for every migration in scope" in
 * `__tests__/integration/preview-prestamp.integration.test.ts` (ISS-5788). The
 * fixture's own scope is unchanged: it still pins OUR side only.
 *
 * Deriving the checksum is what lets `preview-prestamp.ts` stamp a migration that
 * has never reached `public` — i.e. the one introduced by the very PR being
 * previewed (ISS-4600).
 *
 * Takes the DECODED string (what `readMigrationSql` returns) rather than raw
 * bytes, which is byte-exact for every migration Prisma can itself process:
 * decoding valid UTF-8 and re-encoding it is lossless, and a BOM survives the
 * round trip. The inputs where the two could diverge — files that are not valid
 * UTF-8 — cannot reach here, because `decodeMigrationSql` throws on them rather
 * than handing this function a U+FFFD-substituted string.
 */
export function migrationChecksum(migrationSql: string): string {
  return createHash("sha256").update(migrationSql, "utf8").digest("hex");
}
