import { Result } from "@repo/api/src/types/result";
import ConnectionParameters from "pg/lib/connection-parameters";

/**
 * ISS-12017: the refusals the vibe seed decides before it creates any database
 * client. The seed writes thousands of rows into whatever `--database-url`
 * names, so it only ever accepts a local throwaway database carrying the
 * `control_` prefix that control's isolated stacks create and drop
 * (`.claude/skills/control/scripts/stack-db.ts`). The shared developer database
 * and the perf lane's `closedloop_perf` both fail the prefix check.
 */

/** The prefix every throwaway database control creates; the vibe seed accepts nothing else. */
export const VIBE_DATABASE_PREFIX = "control_";

const LOCAL_DATABASE_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
]);

/**
 * ISS-12043: connection-string query parameters that move the connection off
 * the URL's own host. `pg` copies every query parameter into its config, so
 * `?host=` replaces the host the URL names and `?port=` its port; libpq-based
 * tools also honor `hostaddr`. Any of them is refused rather than resolved.
 */
const REDIRECTING_PARAMETERS: readonly string[] = ["host", "hostaddr", "port"];

const POSTGRES_PROTOCOLS: ReadonlySet<string> = new Set([
  "postgres:",
  "postgresql:",
]);

export const VibeSeedRefusalCode = {
  DatabaseUrlMissing: "database_url_missing",
  DatabaseUrlUnparseable: "database_url_unparseable",
  DatabaseUrlNotLocal: "database_url_not_local",
  DatabaseUrlRedirected: "database_url_redirected",
  DatabaseNotThrowaway: "database_not_throwaway",
  UnknownStage: "unknown_stage",
  LocalTrustedOverrideSet: "local_trusted_override_set",
} as const;
export type VibeSeedRefusalCode =
  (typeof VibeSeedRefusalCode)[keyof typeof VibeSeedRefusalCode];

export type VibeSeedRefusal = { code: VibeSeedRefusalCode; message: string };

export type VibeSeedDatabaseTarget = {
  databaseUrl: string;
  databaseName: string;
};

/**
 * Accept only `localhost`/`127.0.0.1` and a database name starting with
 * {@link VIBE_DATABASE_PREFIX}, both as `pg` resolves them, with no query
 * parameter that can redirect the connection. Pure: it opens nothing, so a
 * refusal is decided before any pool or Prisma client exists.
 */
export function checkVibeDatabaseUrl(
  databaseUrl: string | undefined
): Result<VibeSeedDatabaseTarget, VibeSeedRefusal> {
  const trimmed = databaseUrl?.trim();
  if (!trimmed) {
    return refuse(
      VibeSeedRefusalCode.DatabaseUrlMissing,
      "--database-url is required and must name a local control_* database."
    );
  }
  const parsed = URL.parse(trimmed);
  if (parsed === null) {
    return refuse(
      VibeSeedRefusalCode.DatabaseUrlUnparseable,
      "--database-url is not a parseable URL; refusing to connect."
    );
  }
  if (!POSTGRES_PROTOCOLS.has(parsed.protocol)) {
    return refuse(
      VibeSeedRefusalCode.DatabaseUrlNotLocal,
      `--database-url scheme is '${parsed.protocol}', expected postgresql:; refusing to connect.`
    );
  }
  const redirecting = REDIRECTING_PARAMETERS.filter((name) =>
    parsed.searchParams.has(name)
  );
  if (redirecting.length > 0) {
    return refuse(
      VibeSeedRefusalCode.DatabaseUrlRedirected,
      `--database-url sets ${redirecting.join(", ")} as a query parameter, which can send the connection elsewhere; refusing to connect.`
    );
  }
  const resolved = resolveConnectionTarget(trimmed);
  if (resolved === null) {
    return refuse(
      VibeSeedRefusalCode.DatabaseUrlUnparseable,
      "--database-url could not be resolved the way pg resolves it; refusing to connect."
    );
  }
  if (!(resolved.host && LOCAL_DATABASE_HOSTS.has(resolved.host))) {
    return refuse(
      VibeSeedRefusalCode.DatabaseUrlNotLocal,
      `--database-url host is '${resolved.host ?? ""}', expected localhost or 127.0.0.1; refusing to seed a remote database.`
    );
  }
  const databaseName = resolved.database ?? "";
  if (!databaseName.startsWith(VIBE_DATABASE_PREFIX)) {
    return refuse(
      VibeSeedRefusalCode.DatabaseNotThrowaway,
      `--database-url database is '${databaseName}', expected a ${VIBE_DATABASE_PREFIX}* throwaway database; refusing to seed it.`
    );
  }
  return Result.ok({ databaseUrl: trimmed, databaseName });
}

export function refuse<T>(
  code: VibeSeedRefusalCode,
  message: string
): Result<T, VibeSeedRefusal> {
  return Result.err({ code, message });
}

/**
 * The host and database `pg` itself would connect to, from the same parser the
 * seed's pool uses (`pg.Pool({ connectionString })` in `@repo/database`).
 * Constructing the parameters opens nothing; `null` when pg cannot parse it.
 */
function resolveConnectionTarget(
  databaseUrl: string
): { host: string | undefined; database: string | undefined } | null {
  try {
    const parameters = new ConnectionParameters(databaseUrl);
    return { host: parameters.host, database: parameters.database };
  } catch {
    return null;
  }
}
