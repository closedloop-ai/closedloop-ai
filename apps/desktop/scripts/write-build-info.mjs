// @ts-check
/**
 * Emits the desktop build metadata consumed by both main and renderer code.
 *
 * The file is generated and gitignored. Keep writes content-aware so repeated
 * local launches do not churn mtimes and invalidate incremental work.
 *
 * `BUILD_APP_VERSION` is the app version baked at build time from package.json.
 * It is the authoritative `service.version` source for telemetry (FEA-2199): the
 * release workflow writes the minted `desktop-v*` version into package.json
 * BEFORE `pnpm build`, so this constant equals the released version and is immune
 * to the runtime `app.getVersion()` quirks (Electron `"0.0"` sentinel, Electron
 * version bleed) that polluted the fleet `version` facet.
 *
 * This file is the shell: it resolves paths, shells out to git and reads
 * package.json. The render and the content-aware write live in
 * `write-build-info-lib.mjs` so they can be driven directly by tests.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  renderBuildInfoSource,
  resolveAppVersion,
  writeBuildInfoIfChanged,
} from "./write-build-info-lib.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(scriptDir, "..");
const outFile = path.join(appDir, "src", "shared", "build-info.ts");
const packageJsonFile = path.join(appDir, "package.json");

// Posix-separated on purpose: this is the console line, not a path the script
// resolves, and the original message is what the prebuild logs on every launch.
const outDisplayPath = "src/shared/build-info.ts";

const commitHash = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: appDir,
  encoding: "utf8",
}).trim();

const packageJson = JSON.parse(readFileSync(packageJsonFile, "utf8"));

const contents = renderBuildInfoSource({
  commitHash,
  appVersion: resolveAppVersion(packageJson),
});

const result = writeBuildInfoIfChanged({
  outFile,
  contents,
  displayPath: outDisplayPath,
});

process.stdout.write(result.message);
