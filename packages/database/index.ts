import "server-only";

import { neonConfig } from "@neondatabase/serverless";
import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import ws from "ws";
import { PrismaClient } from "./generated/client";
import { keys } from "./keys";

const globalForPrisma = global as unknown as { prisma: PrismaClient };

const connectionString = keys().DATABASE_URL;
const isNeon = connectionString.includes("neon.tech");

// Use Neon adapter for Neon databases (production)
// Use pg adapter for local PostgreSQL
const createClient = () => {
  if (isNeon) {
    neonConfig.webSocketConstructor = ws;
    const adapter = new PrismaNeon({ connectionString });
    return new PrismaClient({ adapter });
  }
  // For local PostgreSQL, don't use SSL
  const url = new URL(connectionString);
  const isLocalhost =
    url.hostname === "localhost" || url.hostname === "127.0.0.1";
  url.searchParams.delete("sslmode");

  const pool = new pg.Pool({
    connectionString: url.toString(),
    // Only use SSL for non-localhost connections
    ssl: isLocalhost ? false : { rejectUnauthorized: false },
  });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
};

export const database = globalForPrisma.prisma || createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = database;
}

// biome-ignore lint/performance/noBarrelFile: re-exporting
export * from "./generated/client";
