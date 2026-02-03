import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { Signer } from "@aws-sdk/rds-signer";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "./generated/client";
import type { TransactionClient } from "./generated/internal/prismaNamespace";
import { keys } from "./keys";
import { resolveSchemaName } from "./schema-utils";

// biome-ignore lint/performance/noBarrelFile: re-exporting
export * from "./generated/client";

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
 */
withDb.tx = async <T>(
  fn: (tx: TransactionClient) => Promise<T>
): Promise<T> => {
  const tx = als.getStore()?.tx;
  if (tx) {
    return fn(tx);
  }

  const db = await getDatabase();
  return db.$transaction(fn);
};

/**
 * Execute a database operation within an implicit transaction.
 *
 * Wraps operations in a Prisma implicit transaction, ensuring all operations
 * either succeed together or roll back on failure.
 *
 * This is designed to be used by tests.
 *
 * @param fn - Callback receiving a transaction client. Must be async.
 * @returns The result of the callback function.
 */
export async function withImplicitTransaction<T>(
  fn: () => Promise<T>
): Promise<T> {
  const db = await getDatabase();
  return db.$transaction((tx) => als.run({ tx }, fn));
}

// -----------------------------------------------------------------------------
// Internal implementation
// -----------------------------------------------------------------------------

const als = new AsyncLocalStorage<{ tx: TransactionClient }>();
const NON_IDENTIFIER_CHARS = /[^a-z0-9_]/;
const LEADING_DIGIT = /^[0-9]/;

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
  const adapter = new PrismaPg(pool);
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

  // Determine if using local DATABASE_URL or remote IAM auth
  const isLocalhost = env.DATABASE_URL
    ? (() => {
        try {
          const url = new URL(env.DATABASE_URL);
          return url.hostname === "localhost" || url.hostname === "127.0.0.1";
        } catch {
          return false;
        }
      })()
    : false;

  if (isLocalhost) {
    // Local development with DATABASE_URL
    const url = new URL(env.DATABASE_URL as string);
    url.searchParams.delete("sslmode");

    globalForPrisma.pool = new pg.Pool({
      connectionString: url.toString(),
      ssl: false,
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
      ssl: { rejectUnauthorized: false },
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

function formatSearchPath(schema: string): string {
  const escaped = schema.replace(/"/g, '""');
  const needsQuotes =
    NON_IDENTIFIER_CHARS.test(schema) || LEADING_DIGIT.test(schema);
  return needsQuotes ? `"${escaped}"` : schema;
}
