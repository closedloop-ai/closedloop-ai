import pg from "pg";

/**
 * `ssl` option shape accepted by `pg.Client` / `pg.Pool`. Either `false`
 * (no TLS — used for localhost) or an object that controls cert verification.
 */
export type SslOption = false | { rejectUnauthorized: boolean };

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
 *                                        (legacy behavior for self-signed
 *                                        RDS endpoints / preview DBs)
 *   - everything else                  → TLS with cert verification (safe default)
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
  return { rejectUnauthorized: true };
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
