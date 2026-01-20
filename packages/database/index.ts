import "server-only";

import { Signer } from "@aws-sdk/rds-signer";
import { PrismaPg } from "@prisma/adapter-pg";
import { awsCredentialsProvider } from "@vercel/functions/oidc";
import pg from "pg";
import { PrismaClient } from "./generated/client";
import { keys } from "./keys";

const globalForPrisma = global as unknown as {
  prisma: PrismaClient | null;
  pool: pg.Pool | null;
  signer: Signer | null;
};

/**
 * Gets or creates the RDS Signer for IAM authentication.
 * Cached globally to reuse across requests.
 */
function getSigner(): Signer {
  if (globalForPrisma.signer) {
    return globalForPrisma.signer;
  }

  const env = keys();

  if (!(env.PGHOST && env.PGUSER && env.AWS_REGION && env.AWS_ROLE_ARN)) {
    throw new Error(
      "Missing required IAM credentials: PGHOST, PGUSER, AWS_REGION, AWS_ROLE_ARN"
    );
  }

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
    const signer = getSigner();

    const token = await signer.getAuthToken();

    // Build connection string with token (matches migration script pattern)
    const connectionString = `postgresql://${env.PGUSER}:${encodeURIComponent(
      token
    )}@${env.PGHOST}:${env.PGPORT}/${env.PGDATABASE || "app"}?sslmode=require`;

    globalForPrisma.pool = new pg.Pool({
      connectionString,
      max: 20,
      connectionTimeoutMillis: 30_000,
      idleTimeoutMillis: 30_000,
    });
  }

  return globalForPrisma.pool;
}

/**
 * Gets or creates the Prisma Client.
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

// Create a proxy that lazily initializes the client
export const database = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    if (prop === "then" || prop === "catch" || prop === "finally") {
      // Don't intercept promise methods
      return;
    }

    // Lazily initialize and delegate to actual client
    return (...args: unknown[]) =>
      getDatabase().then((client) => {
        const value = client[prop as keyof PrismaClient];
        if (typeof value === "function") {
          return (value as (...params: unknown[]) => unknown).apply(
            client,
            args
          );
        }
        return value;
      });
  },
});

// biome-ignore lint/performance/noBarrelFile: re-exporting
export * from "./generated/client";
