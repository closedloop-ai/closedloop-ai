import "server-only";

import { Signer } from "@aws-sdk/rds-signer";
import { PrismaPg } from "@prisma/adapter-pg";
import { awsCredentialsProvider } from "@vercel/functions/oidc";
import pg from "pg";
import { PrismaClient } from "./generated/client";
import { keys } from "./keys";

const globalForPrisma = global as unknown as { prisma: PrismaClient };

const env = keys();

const signer = new Signer({
  hostname: env.PGHOST,
  port: Number(env.PGPORT),
  username: env.PGUSER,
  region: env.AWS_REGION,
  credentials: awsCredentialsProvider({
    roleArn: env.AWS_ROLE_ARN,
    clientConfig: { region: env.AWS_REGION },
  }),
});

const pool = new pg.Pool({
  host: env.PGHOST,
  user: env.PGUSER,
  database: env.PGDATABASE || "app",
  password: () => signer.getAuthToken(),
  port: Number(env.PGPORT || "5432"),
  ssl: { rejectUnauthorized: false },
  max: 20,
});

const createClient = () => {
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
};

export const database = globalForPrisma.prisma || createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = database;
}

// biome-ignore lint/performance/noBarrelFile: re-exporting
export * from "./generated/client";
