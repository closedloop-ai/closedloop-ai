import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ISS-12017: build a Desktop store from the golden corpus with Desktop's own
 * importer. ISS-12135: it is the vibe profile's `build-store`, the same store a
 * prepared Desktop profile holds (time shift, closed sessions, Acme names), so
 * a seed run without a profile writes the rows a profile's Desktop would sync.
 * Run as a child process because the builder lives in the Desktop package and
 * resolves Desktop's module graph.
 */

const DESKTOP_DIR = fileURLToPath(
  new URL("../../../../desktop/", import.meta.url)
);
const BUILDER_SCRIPT = "scripts/vibe-profile/cli.ts";
/** The file name the builder writes under its `--out` directory. */
const STORE_FILE = "agent-dashboard.sqlite";

/** Build the store into `outDir` and return the store's path. */
export function buildGoldenDesktopStore(
  outDir: string,
  nowIso: string,
  log: (message: string) => void
): Promise<string> {
  log(`building the golden-corpus Desktop store into ${outDir}`);
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pnpm",
      [
        "exec",
        "tsx",
        BUILDER_SCRIPT,
        "build-store",
        "--out",
        outDir,
        "--now",
        nowIso,
      ],
      { cwd: DESKTOP_DIR, stdio: ["ignore", "pipe", "pipe"] }
    );
    const relay = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim().length > 0) {
          log(line);
        }
      }
    };
    child.stdout.on("data", relay);
    child.stderr.on("data", relay);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(join(outDir, STORE_FILE));
        return;
      }
      reject(
        new Error(
          `${BUILDER_SCRIPT} exited ${code ?? "by signal"} in ${outDir}`
        )
      );
    });
  });
}
