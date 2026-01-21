import "server-only";

import { Signer } from "@aws-sdk/rds-signer";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "./generated/client";
import { keys } from "./keys";

// biome-ignore lint/performance/noBarrelFile: re-exporting
export * from "./generated/client";

/**
 * Ensures the database is initialized. Safe to call multiple times.
 */
export async function ensureDatabase(): Promise<void> {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = await getDatabase();
  }
}

/**
 * The database client with lazy initialization.
 *
 * Auto-initializes on first use - no need to call ensureDatabase() manually.
 * On Vercel, initialization is deferred until request time when OIDC token is available.
 */
export const database = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    // Fast path: if already initialized, return the real thing
    if (globalForPrisma.prisma) {
      return globalForPrisma.prisma[prop as keyof PrismaClient];
    }

    // For $ methods ($transaction, $queryRaw, etc.), return async wrapper
    if (typeof prop === "string" && prop.startsWith("$")) {
      return async (...args: unknown[]) => {
        await ensureDatabase();
        // biome-ignore lint/suspicious/noExplicitAny: dynamic Prisma method invocation
        return (globalForPrisma.prisma as any)[prop](...args);
      };
    }

    // For model delegates (artifact, user, etc.), return a proxy that wraps method calls
    return new Proxy(
      {},
      {
        get(_target2, method) {
          return async (...args: unknown[]) => {
            await ensureDatabase();
            // biome-ignore lint/suspicious/noExplicitAny: dynamic Prisma delegate method
            return (globalForPrisma.prisma as any)[prop][method](...args);
          };
        },
      }
    );
  },
});

// -----------------------------------------------------------------------------
// Internal implementation
// -----------------------------------------------------------------------------

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
 * For IAM auth, generates token upfront and embeds in connection string.
 * Cached globally to reuse connections.
 */
async function getPool(): Promise<pg.Pool> {
  if (globalForPrisma.pool) {
    return globalForPrisma.pool;
  }

  const env = keys();

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
    });
  } else {
    // Vercel/production with IAM authentication
    const signer = await getSigner();

    const token = await signer.getAuthToken();

    // Build connection string with token (no sslmode in string - use ssl config instead)
    const connectionString = `postgresql://${env.PGUSER}:${encodeURIComponent(
      token
    )}@${env.PGHOST}:${env.PGPORT}/${env.PGDATABASE || "app"}`;

    globalForPrisma.pool = new pg.Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: 20,
      connectionTimeoutMillis: 30_000,
      idleTimeoutMillis: 30_000,
    });
  }

  return globalForPrisma.pool;
}
