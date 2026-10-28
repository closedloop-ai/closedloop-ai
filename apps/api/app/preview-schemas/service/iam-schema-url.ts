import {
  createSchemaUrlMinter,
  readIamAuthConfig,
} from "@repo/database/scripts/iam-database-url";

export type SchemaUrls = {
  databaseUrl: string;
  refreshDatabaseUrl: () => Promise<string>;
};

/**
 * Mints the connection URL for `schema` by signing an RDS IAM token as the
 * MIGRATOR identity (`readIamAuthConfig`: `MIGRATE_PGUSER`, else `PGUSER`).
 * Shared by `/preview-schemas/ensure` and `/preview-schemas/seed` (ISS-6804),
 * the two routes that write to a schema from a runtime function, and by the
 * preview-schema DROP (`migrator-connection.ts`, ISS-5978).
 *
 * IAM ONLY, deliberately — the build migrate's `DATABASE_URL` fallback does NOT
 * come along. `DATABASE_URL` is also what `@repo/database` uses for this app's
 * own runtime pool, so honoring it here would run `migrate deploy` (or the seed)
 * over the application's connection: the wrong role (the exact 42501
 * partial-DDL wedge ISS-5952's ownership preflight exists for), and — because
 * `addSchemaToUrl` leaves an existing `?schema=` alone — potentially the wrong
 * SCHEMA, while the response still names the branch's preview schema. A build
 * script running once per controlled deploy can carry that precedence; an
 * on-demand endpoint cannot.
 *
 * The returned minter is also the ISS-5285 `refreshDatabaseUrl` seam, which
 * re-signs after the (unbounded) clone. `null` when the IAM config is not
 * present in the environment.
 */
export async function mintSchemaUrls(
  schema: string | null,
  env: NodeJS.ProcessEnv = process.env
): Promise<SchemaUrls | null> {
  const iamAuthConfig = readIamAuthConfig(env);
  if (!iamAuthConfig) {
    return null;
  }

  const mintSchemaUrl = createSchemaUrlMinter(iamAuthConfig);
  return {
    databaseUrl: await mintSchemaUrl(schema),
    refreshDatabaseUrl: () => mintSchemaUrl(schema),
  };
}

/** The message a caller answers with when `mintSchemaUrls` returns `null`. */
export const IAM_NOT_CONFIGURED_MESSAGE =
  "RDS IAM credentials are not configured: AWS_REGION, PGHOST, MIGRATE_PGUSER or PGUSER, and PGDATABASE are all required";
