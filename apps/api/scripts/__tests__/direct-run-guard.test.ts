/**
 * ISS-10436: the two scripts below used to decide "am I the entrypoint" by
 * comparing `import.meta.url` against a raw `file://${process.argv[1]}` string.
 * `import.meta.url` percent-encodes a space and the template literal does not,
 * and a symlinked argv[1] never equals the real module URL, so from a spaced or
 * symlinked checkout `main()` never ran and the process exited 0 with no output.
 *
 * Every child here runs with a minimal env and NO `DATABASE_URL`, so each
 * script reaches `main()` and fails loudly inside `withDb` before any socket is
 * opened; that failure line is the proof the guard fired. Measured on the old
 * guard: the spaced and symlinked runs exit 0 with an empty stderr.
 *
 * Nothing this suite materializes lands in a scanned source directory: the
 * source gates walk the tree while other lanes run, and a file that appears in
 * `apps/api/scripts/` mid-scan crashed one. The links live under the package's
 * own `.cache/`, which git ignores, which is on the same filesystem as the
 * scripts (a hard link cannot cross one), and which is NOT `node_modules`,
 * where tsx stops applying the tsconfig path aliases the scripts import by.
 */

import { execFile } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPTS_DIR = fileURLToPath(new URL("..", import.meta.url));
const API_DIR = fileURLToPath(new URL("../..", import.meta.url));
const TSX_BIN = join(API_DIR, "node_modules/.bin/tsx");
const TSCONFIG = join(API_DIR, "tsconfig.json");
const SCRATCH_ROOT = join(API_DIR, ".cache/direct-run-guard");
const IMPORT_SENTINEL = "direct-run-guard: imported without running main";
const SPAWN_TIMEOUT_MS = 60_000;

/**
 * `siblings` are the modules a script imports by relative path; a hard link of
 * the script only resolves them when they sit beside it, so they are linked too.
 */
const SCRIPTS = [
  {
    file: "backfill-transcript-search.ts",
    failureLine: "[backfill-transcript-search] failed:",
    siblings: [],
  },
  {
    file: "branch-analytics-perf-fixture.ts",
    failureLine: "[branch-analytics-perf] failed:",
    siblings: ["branch-analytics-perf-fixture-guards.ts"],
  },
] as const;

type RunResult = { code: number | null; stdout: string; stderr: string };

function runUnderTsx(entry: string): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      TSX_BIN,
      ["--tsconfig", TSCONFIG, "--conditions=react-server", entry],
      {
        cwd: API_DIR,
        timeout: SPAWN_TIMEOUT_MS,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          NODE_ENV: "test",
        },
      },
      (error, stdout, stderr) => {
        resolvePromise({
          code: exitCodeOf(error),
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      }
    );
    child.on("error", reject);
  });
}

function exitCodeOf(error: Error | null): number | null {
  if (!error) {
    return 0;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : null;
}

function scratchDir(): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  return mkdtempSync(join(SCRATCH_ROOT, "direct run guard "));
}

describe.each(SCRIPTS)(
  "$file direct-run guard",
  ({ file, failureLine, siblings }) => {
    const scriptPath = join(SCRIPTS_DIR, file);

    it(
      "runs main() through the real path",
      async () => {
        const result = await runUnderTsx(scriptPath);
        expect(result.stderr).toContain(failureLine);
        expect(result.code).not.toBe(0);
      },
      SPAWN_TIMEOUT_MS
    );

    it(
      "runs main() through a symlink inside a directory whose name has a space",
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "direct run guard "));
        const link = join(dir, file);
        try {
          symlinkSync(scriptPath, link);
          const result = await runUnderTsx(link);
          expect(result.stderr).toContain(failureLine);
          expect(result.code).not.toBe(0);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      SPAWN_TIMEOUT_MS
    );

    // A symlink is canonicalized by `realpathSync`, so it proves symlink safety
    // and nothing about URL encoding. A hard link is not canonicalized: the
    // path with the space is the one that gets encoded, which is the case the
    // old string comparison fails.
    it(
      "runs main() through a hard link inside a directory whose name has a space",
      async () => {
        const dir = scratchDir();
        const link = join(dir, file);
        try {
          for (const sibling of siblings) {
            linkSync(join(SCRIPTS_DIR, sibling), join(dir, sibling));
          }
          linkSync(scriptPath, link);
          const result = await runUnderTsx(link);
          expect(result.stderr).toContain(failureLine);
          expect(result.code).not.toBe(0);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      SPAWN_TIMEOUT_MS
    );

    it(
      "does not run main() when imported as a module",
      async () => {
        const dir = scratchDir();
        const entry = join(dir, "entry.ts");
        try {
          writeFileSync(
            entry,
            `import ${JSON.stringify(scriptPath)};\nconsole.log(${JSON.stringify(IMPORT_SENTINEL)});\n`
          );
          const result = await runUnderTsx(entry);
          expect(result.stderr).not.toContain(failureLine);
          expect(result.stdout).toContain(IMPORT_SENTINEL);
          expect(result.code).toBe(0);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
      SPAWN_TIMEOUT_MS
    );
  }
);
