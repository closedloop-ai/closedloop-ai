import { AsyncLocalStorage } from "node:async_hooks";
import { Signer } from "@aws-sdk/rds-signer";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "./generated/client";
import type { TransactionClient } from "./generated/internal/prismaNamespace";
import { keys } from "./keys";
import { formatSearchPath, resolveSchemaName } from "./schema-utils";
import {
  classifyDatabaseTransport,
  isLocalhostUrl,
  resolveSslOption,
} from "./scripts/db-utils";

// biome-ignore lint/performance/noBarrelFile: re-exporting Prisma client types
export * from "./generated/client";
export type { TransactionClient } from "./generated/internal/prismaNamespace";

/**
 * Execute a database operation with an initialized Prisma client.
 *
 * @param fn - Callback receiving the initialized PrismaClient. Can be sync or async.
 * @returns The result of the callback function.
 *
 * @example
 * // Simple query
 * const users = await withDb(db => db.user.findMany());
 *
 * @example
 * // Query with parameters
 * const user = await withDb(db =>
 *   db.user.findUnique({ where: { id: userId } })
 * );
 *
 * @example
 * // Multiple operations (not transactional - use withDb.tx for transactions)
 * const [users, projects] = await withDb(async db => {
 *   const users = await db.user.findMany();
 *   const projects = await db.project.findMany();
 *   return [users, projects];
 * });
 */
export async function withDb<T>(
  fn: (db: TransactionClient) => Promise<T> | T
): Promise<T> {
  const tx = als.getStore()?.tx;
  if (tx) {
    return fn(tx);
  }

  const db = await getDatabase();
  return fn(db);
}

export function getDatabaseTransportPosture() {
  return classifyDatabaseTransport({
    databaseUrl: process.env.DATABASE_URL,
    pgHost: process.env.PGHOST,
    pgDatabase: process.env.PGDATABASE,
    pgUser: process.env.PGUSER,
    allowInsecureSsl: process.env.ALLOW_INSECURE_SSL === "1",
  });
}

/**
 * Execute multiple database operations within a transaction.
 *
 * Wraps operations in a Prisma interactive transaction, ensuring all operations
 * either succeed together or roll back on failure.
 *
 * @param fn - Callback receiving a transaction client. Must be async.
 * @returns The result of the callback function.
 *
 * @example
 * // Create related records atomically
 * const { user, profile } = await withDb.tx(async tx => {
 *   const user = await tx.user.create({ data: { email } });
 *   const profile = await tx.profile.create({
 *     data: { userId: user.id, name }
 *   });
 *   return { user, profile };
 * });
 *
 * @example
 * // Update with optimistic locking pattern
 * await withDb.tx(async tx => {
 *   const artifact = await tx.artifact.findUniqueOrThrow({
 *     where: { id }
 *   });
 *   await tx.artifact.update({
 *     where: { id, version: artifact.version },
 *     data: { content, version: artifact.version + 1 }
 *   });
 * });
 *
 * @param options - Optional Prisma interactive-transaction options. Use
 *   `timeout` to raise the default 5s limit for long-running transactions (e.g.
 *   large cascade deletes), and `maxWait` to bound how long to wait for a
 *   connection. Ignored when already inside an ambient transaction (the callback
 *   simply joins it).
 */
withDb.tx = async <T>(
  fn: (tx: TransactionClient) => Promise<T>,
  options?: { maxWait?: number; timeout?: number }
): Promise<T> => {
  const tx = als.getStore()?.tx;
  if (tx) {
    return fn(tx);
  }

  const db = await getDatabase();
  return db.$transaction((tx) => als.run({ tx }, fn, tx), options);
};

// -----------------------------------------------------------------------------
// Internal implementation
// -----------------------------------------------------------------------------

const als = new AsyncLocalStorage<{ tx: TransactionClient }>();

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | null;
  pool: pg.Pool | null;
  signer: Signer | null;
};

/**
 * Gets or creates the Prisma Client.
 *
 * Uses global caching to reuse client across requests.
 */
async function getDatabase(): Promise<PrismaClient> {
  if (globalForPrisma.prisma) {
    return globalForPrisma.prisma;
  }

  const pool = await getPool();
  const schema = resolveSchemaName({
    pgSchema: keys().PGSCHEMA,
    vercelEnv: process.env.VERCEL_ENV,
    vercelGitCommitRef: process.env.VERCEL_GIT_COMMIT_REF,
  });
  const adapter = new PrismaPg(pool, schema ? { schema } : undefined);
  globalForPrisma.prisma = new PrismaClient({ adapter });

  return globalForPrisma.prisma;
}

/**
 * Gets or creates the RDS Signer for IAM authentication.
 * Cached globally to reuse across requests.
 *
 * Note: Uses dynamic import for awsCredentialsProvider to avoid loading
 * OIDC code at module initialization time (which fails during instrumentation
 * when there's no request context).
 */
async function getSigner(): Promise<Signer> {
  if (globalForPrisma.signer) {
    return globalForPrisma.signer;
  }

  const env = keys();

  if (!(env.PGHOST && env.PGUSER && env.AWS_REGION && env.AWS_ROLE_ARN)) {
    throw new Error(
      "Missing required IAM credentials: PGHOST, PGUSER, AWS_REGION, AWS_ROLE_ARN"
    );
  }

  // Dynamic import to avoid OIDC token check at module load time
  const { awsCredentialsProvider } = await import("@vercel/functions/oidc");

  globalForPrisma.signer = new Signer({
    hostname: env.PGHOST,
    port: Number(env.PGPORT || "5432"),
    username: env.PGUSER,
    region: env.AWS_REGION,
    credentials: awsCredentialsProvider({
      roleArn: env.AWS_ROLE_ARN,
      clientConfig: { region: env.AWS_REGION },
    }),
  });

  return globalForPrisma.signer;
}

/**
 * Gets or creates the pg Pool.
 * For IAM auth, uses dynamic password generation to refresh tokens automatically.
 * IAM tokens expire after 15 minutes, so we generate a fresh token for each new connection.
 * Cached globally to reuse connections.
 */
async function getPool(): Promise<pg.Pool> {
  if (globalForPrisma.pool) {
    return globalForPrisma.pool;
  }

  const env = keys();
  const schema = resolveSchemaName({
    pgSchema: env.PGSCHEMA,
    vercelEnv: process.env.VERCEL_ENV,
    vercelGitCommitRef: process.env.VERCEL_GIT_COMMIT_REF,
  });
  const searchPath =
    schema && schema.length > 0 ? formatSearchPath(schema) : null;

  if (env.DATABASE_URL) {
    // Password auth via DATABASE_URL (local dev or remote ECS tasks)
    const url = new URL(env.DATABASE_URL);
    const isLocalhost = isLocalhostUrl(url);
    // Read sslmode before stripping it from the connection string — we provide
    // explicit ssl config to the Pool, and keeping sslmode on the URL too can
    // cause driver/adapter conflicts. Delegate to the shared SSL policy so the
    // runtime pool honors the caller's sslmode (e.g. `?sslmode=disable` opts
    // out of TLS) and defaults to verified TLS for non-localhost hosts, matching
    // the seed scripts. Verification trusts the system roots plus the bundled
    // RDS CA (`VERIFIED_SSL_CA`), so both publicly-trusted hosts (e.g. Neon) and
    // RDS endpoints verify. `ALLOW_INSECURE_SSL=1` is the same deploy-free escape
    // hatch the IAM path and seed scripts honor — it restores unverified (but
    // still encrypted) TLS for any endpoint not covered by the bundle, preferable
    // to the only other URL-side opt-out (`?sslmode=disable`, which drops TLS).
    const sslmode = url.searchParams.get("sslmode");
    url.searchParams.delete("sslmode");

    globalForPrisma.pool = new pg.Pool({
      connectionString: url.toString(),
      ssl: resolveSslOption({
        isLocalhost,
        sslmode,
        allowInsecure: process.env.ALLOW_INSECURE_SSL === "1",
      }),
      ...(searchPath ? { options: `-c search_path=${searchPath}` } : {}),
    });
  } else {
    // Vercel/production with IAM authentication
    // Use dynamic password function to generate fresh IAM token for each new connection.
    // This is critical because IAM tokens expire after 15 minutes.
    const signer = await getSigner();

    globalForPrisma.pool = new pg.Pool({
      host: env.PGHOST,
      port: Number(env.PGPORT || "5432"),
      database: env.PGDATABASE || "app",
      user: env.PGUSER,
      // pg.Pool calls this function for each new connection, ensuring fresh tokens
      password: async () => signer.getAuthToken(),
      // Verified TLS against the RDS endpoint via the shared SSL policy. The IAM
      // host is never localhost and carries no sslmode, so this resolves to
      // `{ rejectUnauthorized: true, ca: [...system roots, RDS CA bundle] }` —
      // short-lived IAM tokens and queries are sent over TLS whose server cert
      // is verified. The RDS CA is supplied explicitly (`VERIFIED_SSL_CA` in
      // db-utils.ts) because it is NOT in the Vercel runtime's default trust
      // store; relying on system CAs alone produced `SELF_SIGNED_CERT_IN_CHAIN`
      // and took prod down. `ALLOW_INSECURE_SSL=1` remains a deploy-free escape
      // hatch that drops verification for any endpoint not covered by the bundle.
      ssl: resolveSslOption({
        isLocalhost: false,
        sslmode: null,
        allowInsecure: process.env.ALLOW_INSECURE_SSL === "1",
      }),
      max: 20,
      // How long to wait for connection handshake (network timeout)
      connectionTimeoutMillis: 30_000,
      // Close idle connections after 10 minutes (before 15-minute token expiry)
      // Active connections remain valid for their entire session
      idleTimeoutMillis: 10 * 60 * 1000,
      ...(searchPath ? { options: `-c search_path=${searchPath}` } : {}),
    });
  }

  return globalForPrisma.pool;
}
