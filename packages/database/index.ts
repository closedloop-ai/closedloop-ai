import "server-only";

import { Signer } from "@aws-sdk/rds-signer";
import { PrismaPg } from "@prisma/adapter-pg";
import { awsCredentialsProvider } from "@vercel/functions/oidc";
import pg from "pg";
import { PrismaClient } from "./generated/client";
import { keys } from "./keys";

const globalForPrisma = global as unknown as {
  prisma: PrismaClient | null;
  prismaPromise: Promise<PrismaClient> | null;
};

const env = keys();

// Determine if connecting to localhost (local dev) or remote (Vercel/production)
const isLocalhost = env.DATABASE_URL
  ? (() => {
      const url = new URL(env.DATABASE_URL);
      return url.hostname === "localhost" || url.hostname === "127.0.0.1";
    })()
  : false;

/**
 * Creates a pg Pool for local development using DATABASE_URL.
 */
function createLocalPool(): pg.Pool {
  const url = new URL(env.DATABASE_URL as string);
  url.searchParams.delete("sslmode");

  return new pg.Pool({
    connectionString: url.toString(),
    ssl: false,
  });
}

/**
 * Creates a pg Pool for Vercel/production using RDS IAM authentication.
 * Uses connection string with token (same as migration script).
 */
async function createIamPool(): Promise<pg.Pool> {
  const signer = new Signer({
    hostname: env.PGHOST as string,
    port: Number(env.PGPORT),
    username: env.PGUSER as string,
    region: env.AWS_REGION as string,
    credentials: awsCredentialsProvider({
      roleArn: env.AWS_ROLE_ARN as string,
      clientConfig: { region: env.AWS_REGION as string },
    }),
  });

  // Generate token (same as migration script)
  const token = await signer.getAuthToken();

  // Build connection string with token (same as migration script)
  const connectionString = `postgresql://${env.PGUSER}:${encodeURIComponent(
    token
  )}@${env.PGHOST}:${env.PGPORT}/${env.PGDATABASE || "app"}?sslmode=require`;

  return new pg.Pool({
    connectionString,
    max: 20,
    connectionTimeoutMillis: 30_000,
    idleTimeoutMillis: 30_000,
  });
}

async function createClient(): Promise<PrismaClient> {
  const pool = isLocalhost ? createLocalPool() : await createIamPool();
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

// Initialize client on first access
function getDatabase(): Promise<PrismaClient> {
  if (globalForPrisma.prisma) {
    return Promise.resolve(globalForPrisma.prisma);
  }

  if (!globalForPrisma.prismaPromise) {
    globalForPrisma.prismaPromise = createClient().then((client) => {
      globalForPrisma.prisma = client;
      return client;
    });
  }

  return globalForPrisma.prismaPromise;
}

// Create a proxy that lazily initializes the client
export const database = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    if (prop === "then" || prop === "catch" || prop === "finally") {
      // Don't intercept promise methods
      return;
    }

    return (...args: unknown[]) =>
      getDatabase().then((client) => {
        const value = client[prop as keyof PrismaClient];
        if (typeof value === "function") {
          return (value as (...params: unknown[]) => unknown)(...args);
        }
        return value;
      });
  },
});

// biome-ignore lint/performance/noBarrelFile: re-exporting
export * from "./generated/client";
