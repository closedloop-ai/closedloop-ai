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

  return new pg.Pool({
    host: env.PGHOST,
    user: env.PGUSER,
    database: env.PGDATABASE || "app",
    password: () => signer.getAuthToken(),
    port: Number(env.PGPORT),
    ssl: { rejectUnauthorized: false },
    max: 20,
  });
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
