/**
 * Mints RDS IAM-authenticated connection URLs for a target schema.
 *
 * Extracted from `migrate.ts` (ISS-5983) so the build-time migrate and the
 * `apps/api` runtime ensure route share ONE implementation of "sign a fresh
 * 15-minute RDS IAM token and build a schema-scoped connection string" instead
 * of each keeping its own copy of the URL format.
 */

import { Signer } from "@aws-sdk/rds-signer";
import { createRdsCredentialsProvider } from "../aws-credentials";
import { addSchemaToUrl } from "../schema-utils";

const DEFAULT_PGPORT = "5432";

export type IamAuthConfig = {
  roleArn: string | undefined;
  region: string;
  host: string;
  port: string;
  user: string;
  database: string;
};

/**
 * Reads the four required IAM connection variables (plus the optional port and
 * role ARN). Returns `null` when any is missing so the caller can report its
 * own guidance — the build prints a skip notice, the runtime route returns a
 * 500.
 *
 * `AWS_ROLE_ARN` is optional here for the same reason it is for the runtime
 * pool (ISS-9122): with it, `createRdsCredentialsProvider` assumes the role
 * through Vercel OIDC; without it (an ECS task role), it uses the AWS
 * credential chain. So `null` means the connection target is incomplete, never
 * that credentials are unavailable — that is decided by invoking the provider
 * when the minter signs (ISS-9108), and a failure there throws.
 *
 * Every caller of this is a DDL path (the build migrate, the ensure/seed routes,
 * the preview-migrator walk, the preview-schema DROP), so the user is the
 * MIGRATOR identity: `MIGRATE_PGUSER`, falling back to `PGUSER` when unset
 * (ISS-5978, PRD-598 ISS-1). `PGUSER` alone cannot carry the split: Vercel
 * scopes env vars by target (production/preview), not by build vs runtime, and
 * the runtime pool in `index.ts` reads `PGUSER` too — so setting it to the
 * migrator would move the runtime onto the owner role instead of off it. The
 * fallback keeps every environment that has not set the new variable exactly
 * as it was.
 */
export function readIamAuthConfig(
  env: NodeJS.ProcessEnv
): IamAuthConfig | null {
  const {
    AWS_ROLE_ARN,
    AWS_REGION,
    PGHOST,
    PGUSER,
    MIGRATE_PGUSER,
    PGDATABASE,
    PGPORT = DEFAULT_PGPORT,
  } = env;
  // `||`, not `??`: an empty string is unset here, as in every keys.ts schema.
  const user = MIGRATE_PGUSER || PGUSER;

  if (!(AWS_REGION && PGHOST && user && PGDATABASE)) {
    return null;
  }

  return {
    roleArn: AWS_ROLE_ARN,
    region: AWS_REGION,
    host: PGHOST,
    port: PGPORT,
    user,
    database: PGDATABASE,
  };
}

/**
 * Returns a minter that yields a connection URL for `schema` with a FRESHLY
 * signed IAM token, reusing one `Signer` across calls.
 *
 * Callers pass the minter both as the initial URL source and as the ISS-5285
 * `refreshDatabaseUrl` seam, which re-mints after the (unbounded) data clone so
 * the steps that follow do not authenticate with an expired token.
 */
export function createSchemaUrlMinter(
  config: IamAuthConfig
): (schema: string | null) => Promise<string> {
  const signer = new Signer({
    hostname: config.host,
    port: Number(config.port),
    username: config.user,
    region: config.region,
    credentials: createRdsCredentialsProvider({
      roleArn: config.roleArn,
      region: config.region,
      minRemainingMs: RDS_AUTH_TOKEN_LIFETIME_MS,
    }),
  });

  return async (schema: string | null): Promise<string> => {
    const freshToken = await signer.getAuthToken();
    const schemaUrl = `postgresql://${config.user}:${encodeURIComponent(freshToken)}@${config.host}:${config.port}/${config.database}?sslmode=require`;
    return addSchemaToUrl(schemaUrl, schema);
  };
}

/**
 * The Signer's token lifetime (`expiresIn: 900` in `@aws-sdk/rds-signer`). AWS
 * requires temporary credentials to still be valid when the token they signed
 * is used to connect, and the URL minted here is handed to later steps that
 * budget for the full 15 minutes (`MIGRATION_SERIALIZE_LOCK_BUDGET_MS`), so the
 * signing credentials must outlive the token.
 */
const RDS_AUTH_TOKEN_LIFETIME_MS = 15 * 60 * 1000;
