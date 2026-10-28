// @ts-check
/**
 * Builds the Electron main + preload bundles for local development.
 *
 * Both dev and release builds now go through the same `build:main` script,
 * which runs plain Vite over the main and preload configs and bundles workspace
 * TypeScript from source — see vite.main.config.ts, vite.preload.config.ts and
 * PLN-999. This script keeps the dev launcher's indirection so `pnpm dev`
 * rebuilds the bundled main/preload before spawning Electron.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(scriptDir, "..");

const result = spawnSync("pnpm", ["run", "build:main"], {
  cwd: appDir,
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
