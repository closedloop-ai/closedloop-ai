import "server-only";

import { Signer } from "@aws-sdk/rds-signer";
import { PrismaPg } from "@prisma/adapter-pg";
import { awsCredentialsProvider } from "@vercel/functions/oidc";
import pg from "pg";
import { PrismaClient } from "./generated/client";
import { keys } from "./keys";

const globalForPrisma = global as unknown as { prisma: PrismaClient };

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
 * Matches the migration script pattern exactly.
 */
function createIamPool(): pg.Pool {
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

  let currentToken: string | null = null;
  let tokenExpiry = 0;

  // Get token synchronously using a Promise that we await in the password callback
  async function getToken(): Promise<string> {
    const now = Date.now();

    // Reuse token if still valid (refresh 1 min before expiry)
    if (currentToken && now < tokenExpiry - 60_000) {
      return currentToken;
    }

    // Generate new token (same as migration script)
    const token = await signer.getAuthToken();
    currentToken = token;
    tokenExpiry = now + 15 * 60 * 1000; // Tokens valid for 15 minutes

    return token;
  }

  // Use connection string format exactly like migration script
  const pool = new pg.Pool({
    host: env.PGHOST,
    port: Number(env.PGPORT),
    user: env.PGUSER,
    database: env.PGDATABASE || "app",
    // Password callback - must return promise
    password: getToken,
    ssl: {
      rejectUnauthorized: false,
    },
    max: 20,
    connectionTimeoutMillis: 30_000,
    idleTimeoutMillis: 30_000,
  });

  return pool;
}

const createClient = (): PrismaClient => {
  const pool = isLocalhost ? createLocalPool() : createIamPool();
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
};

export const database = globalForPrisma.prisma || createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = database;
}

// biome-ignore lint/performance/noBarrelFile: re-exporting
export * from "./generated/client";
