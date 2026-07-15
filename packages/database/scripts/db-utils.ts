import tls from "node:tls";
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

export function createSslClient(databaseUrl: string) {
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
  });
}

export function quoteIdentifier(value: string) {
  return `"${String(value).replace(/"/g, '""')}"`;
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
