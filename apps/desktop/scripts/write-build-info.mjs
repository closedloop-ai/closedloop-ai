// @ts-check
/**
 * Emits the desktop build metadata consumed by both main and renderer code.
 *
 * The file is generated and gitignored. Keep writes content-aware so repeated
 * local launches do not churn mtimes and invalidate incremental work.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(scriptDir, "..");
const outFile = path.join(appDir, "src", "shared", "build-info.ts");

const commitHash = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: appDir,
  encoding: "utf8",
}).trim();

const contents = `// AUTO-GENERATED — do not edit
export const BUILD_COMMIT_HASH = "${commitHash}";
`;

if (existsSync(outFile) && readFileSync(outFile, "utf8") === contents) {
  process.stdout.write("write-build-info: unchanged\n");
} else {
  writeFileSync(outFile, contents, "utf8");
  process.stdout.write("write-build-info: wrote src/shared/build-info.ts\n");
}
