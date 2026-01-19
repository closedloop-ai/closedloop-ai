import path from "node:path";
import dotenv from "dotenv";
import { defineConfig } from "prisma/config";
import { keys } from "./keys";

dotenv.config({ path: path.resolve(__dirname, ".env") });

const env = keys();

// Use DATABASE_URL if provided, otherwise construct from PG vars
const getDatabaseUrl = () => {
  if (env.DATABASE_URL) {
    return env.DATABASE_URL;
  }
  // Construct URL from PG vars (no password - requires IAM auth or manual password)
  return `postgresql://${env.PGUSER}@${env.PGHOST}:${env.PGPORT}/${env.PGDATABASE}?sslmode=require`;
};

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: getDatabaseUrl(),
  },
});
