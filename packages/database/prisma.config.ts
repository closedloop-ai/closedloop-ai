import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { defineConfig } from "prisma/config";
import { keys } from "./keys";
import { addSchemaToUrl, resolveSchemaName } from "./schema-utils";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

dotenv.config({ path: path.resolve(import.meta.dirname, ".env") });

const env = keys();

const resolvedSchema = resolveSchemaName({
  pgSchema: env.PGSCHEMA,
  vercelEnv: process.env.VERCEL_ENV,
  vercelGitCommitRef: process.env.VERCEL_GIT_COMMIT_REF,
});

const addSchema = (databaseUrl: string) =>
  addSchemaToUrl(databaseUrl, resolvedSchema);

// Use DATABASE_URL if provided, otherwise construct from PG vars
const getDatabaseUrl = () => {
  if (env.DATABASE_URL) {
    return addSchema(env.DATABASE_URL);
  }
  // Construct URL from PG vars (no password - requires IAM auth or manual password)
  const baseUrl = `postgresql://${env.PGUSER}@${env.PGHOST}:${env.PGPORT}/${env.PGDATABASE}?sslmode=require`;
  return addSchema(baseUrl);
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
