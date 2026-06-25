import { defineConfig } from "prisma/config";

// CLI-only configuration — never loaded at app runtime. The desktop store is
// in-process SQLite (apps/desktop/src/main/database/sqlite.ts); there is no
// live database for the CLI to reach by default.
//
// - `prisma generate` and `prisma migrate diff --from-empty --to-schema`
//   need a datasource argument but never connect, so the placeholder URL is
//   sufficient for the common paths (build, CI guard).
// - `prisma migrate dev` (schema iteration) needs a real throwaway Postgres:
//   run `npx prisma dev` (SQLite-backed local server) and export
//   DESKTOP_DATABASE_URL with the URL it prints. See package.json
//   db:* scripts.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url:
      process.env.DESKTOP_DATABASE_URL ??
      "postgresql://placeholder@localhost:5432/desktop_local_placeholder",
  },
});
