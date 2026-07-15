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
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(scriptDir, "..");
const outFile = path.join(appDir, "src", "shared", "build-info.ts");
const packageJsonFile = path.join(appDir, "package.json");

const commitHash = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: appDir,
  encoding: "utf8",
}).trim();

const packageJson = JSON.parse(readFileSync(packageJsonFile, "utf8"));
const appVersion =
  typeof packageJson.version === "string" ? packageJson.version : "";

const contents = `// AUTO-GENERATED — do not edit
export const BUILD_COMMIT_HASH = "${commitHash}";
export const BUILD_APP_VERSION = "${appVersion}";
`;

if (existsSync(outFile) && readFileSync(outFile, "utf8") === contents) {
  process.stdout.write("write-build-info: unchanged\n");
} else {
  writeFileSync(outFile, contents, "utf8");
  process.stdout.write("write-build-info: wrote src/shared/build-info.ts\n");
}
