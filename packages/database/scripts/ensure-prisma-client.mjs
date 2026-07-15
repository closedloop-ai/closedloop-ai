import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureArtifact } from "./ensure-artifact.mjs";

// Ensure the generated Prisma client exists AND is current WITHOUT
// unconditionally regenerating it. Turbo's dedicated `db:generate` task is the
// single upstream producer of `generated/` (see turbo.json: build/test/typecheck
// all depend on `@repo/database#db:generate`). This guard exists only so
// standalone script runs (`pnpm --filter @repo/database build|test`, not
// orchestrated by turbo) still have a client.
//
// Freshness is an mtime comparison against prisma/schema.prisma. `prisma
// generate` rewrites generated/client.ts, so every (re)generation — including
// the upstream turbo db:generate task — bumps the client's mtime past the
// schema's. That has two consequences:
//   1. In a turbo run the client is regenerated first, so this guard is a
//      race-free NO-OP: no concurrent `prisma generate` rewrites
//      generated/client.ts while a sibling `test` task imports it (the torn
//      read that intermittently broke the seed unit tests across main).
//   2. A standalone build/test after editing the schema sees schema.prisma
//      newer than the client and regenerates, so it never imports a stale
//      client — the freshness gap flagged in review.

const scriptDir = dirname(fileURLToPath(import.meta.url));
const dbRoot = resolve(scriptDir, "..");
const generatedClient = join(dbRoot, "generated", "client.ts");
const schemaPath = join(dbRoot, "prisma", "schema.prisma");

function isClientFresh() {
  if (!existsSync(generatedClient)) {
    return false;
  }
  // No schema to compare against (unexpected) — trust the existing client
  // rather than regenerate on every run.
  if (!existsSync(schemaPath)) {
    return true;
  }
  return statSync(generatedClient).mtimeMs >= statSync(schemaPath).mtimeMs;
}

// Invoke the `db:generate` script rather than re-declaring the prisma flags, so
// the generate invocation has a single source of truth (packages/database
// package.json).
ensureArtifact({
  isFresh: isClientFresh,
  command: "pnpm",
  args: ["run", "db:generate"],
  cwd: dbRoot,
  missingMessage:
    "Generating Prisma client (generated/ missing or stale vs schema).",
});
