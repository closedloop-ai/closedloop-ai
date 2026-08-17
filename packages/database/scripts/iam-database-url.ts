/**
 * Mints RDS IAM-authenticated connection URLs for a target schema.
 *
 * Extracted from `migrate.ts` (ISS-5983) so the build-time migrate and the
 * `apps/api` runtime ensure route share ONE implementation of "sign a fresh
 * 15-minute RDS IAM token and build a schema-scoped connection string" instead
 * of each keeping its own copy of the URL format.
 */

import { Signer } from "@aws-sdk/rds-signer";
import { awsCredentialsProvider } from "@vercel/functions/oidc";
import { addSchemaToUrl } from "../schema-utils";

const DEFAULT_PGPORT = "5432";

export type IamAuthConfig = {
  roleArn: string;
  region: string;
  host: string;
  port: string;
  user: string;
  database: string;
};

/**
 * Reads the five required IAM connection variables (plus the optional port).
 * Returns `null` when any is missing so the caller can report its own guidance
 * — the build prints a skip notice, the runtime route returns a 500.
 */
export function readIamAuthConfig(
  env: NodeJS.ProcessEnv
): IamAuthConfig | null {
  const {
    AWS_ROLE_ARN,
    AWS_REGION,
    PGHOST,
    PGUSER,
    PGDATABASE,
    PGPORT = DEFAULT_PGPORT,
  } = env;

  if (!(AWS_ROLE_ARN && AWS_REGION && PGHOST && PGUSER && PGDATABASE)) {
    return null;
  }

  return {
    roleArn: AWS_ROLE_ARN,
    region: AWS_REGION,
    host: PGHOST,
    port: PGPORT,
    user: PGUSER,
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
    credentials: awsCredentialsProvider({
      roleArn: config.roleArn,
      clientConfig: { region: config.region },
    }),
  });

  return async (schema: string | null): Promise<string> => {
    const freshToken = await signer.getAuthToken();
    const schemaUrl = `postgresql://${config.user}:${encodeURIComponent(freshToken)}@${config.host}:${config.port}/${config.database}?sslmode=require`;
    return addSchemaToUrl(schemaUrl, schema);
  };
}
