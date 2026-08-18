// @ts-check
/**
 * FEA-1791 / PLN-886 Phase 2 — emit the embedded migrations manifest.
 *
 * Shell only. ISS-5303 moved every decision this generator makes into
 * ./generate-migrations-manifest-lib.mjs — the legacy-manifest heal, the
 * empty-directory refusal, the symlink and path-escape rejections, the
 * checksum, the render and the write-if-changed branch — so they can be driven
 * against temp fixtures in test/migrations-manifest-lib.test.ts. What is left
 * here is the one thing a test cannot inject: resolving the real desktop paths
 * off `import.meta.url`.
 *
 * Run by `pnpm prebuild` ahead of build / typecheck / test. The output is
 * gitignored.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateMigrationsManifest } from "./generate-migrations-manifest-lib.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(scriptDir, "..");

generateMigrationsManifest({
  appDir,
  migrationsDir: path.join(appDir, "prisma", "migrations"),
  outFile: path.join(
    appDir,
    "src",
    "main",
    "database",
    "migration",
    "migrations-manifest.ts"
  ),
});
