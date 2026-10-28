/**
 * ISS-12394 — branch coverage for `scripts/perf-prepare-dataset.mjs`: the
 * platform paths of `defaultSourceUserDataDir`, the default arguments, and the
 * entrypoint gate that keeps `main()` from running when the module is imported
 * rather than executed.
 *
 * Everything runs in a plain Node child, because the node lane's c8 only
 * credits code that runs outside a Vite-transformed worker.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CHILD_CASE_TIMEOUT_MS,
  CHILD_SPAWN_TIMEOUT_MS,
  runModuleInChild,
  spawnModuleChild,
} from "./support/module-child";

const MODULE_URL = new URL(
  "../scripts/perf-prepare-dataset.mjs",
  import.meta.url
).href;
const DESKTOP_DIR = fileURLToPath(new URL("..", import.meta.url));
const STAMP_PATTERN = /^\d{8}T\d{6}Z$/;

/** `--no-warnings` keeps node:sqlite's ExperimentalWarning off stderr. */
const CHILD = {
  cwd: DESKTOP_DIR,
  moduleUrl: MODULE_URL,
  nodeArgs: ["--no-warnings"],
} as const;

function spawnChild(body: string, argv: readonly string[] = []) {
  return spawnModuleChild({ ...CHILD, body, scriptArgs: argv });
}

function runInChild<T>(body: string): T {
  return runModuleInChild<T>({ ...CHILD, body });
}

describe("defaultSourceUserDataDir", () => {
  it(
    "resolves each platform, treating an empty APPDATA or XDG_CONFIG_HOME as unset",
    () => {
      const dirs = runInChild<string[]>(`out([
        m.defaultSourceUserDataDir("darwin", {}, "/Users/x"),
        m.defaultSourceUserDataDir("win32", { APPDATA: "C:\\\\Roaming" }, "C:\\\\Users\\\\x"),
        m.defaultSourceUserDataDir("win32", { APPDATA: "" }, "C:\\\\Users\\\\x"),
        m.defaultSourceUserDataDir("linux", { XDG_CONFIG_HOME: "/cfg" }, "/home/x"),
        m.defaultSourceUserDataDir("linux", { XDG_CONFIG_HOME: "" }, "/home/x"),
      ]);`);
      expect(dirs).toEqual([
        path.join("/Users/x", "Library", "Application Support", "Closedloop"),
        path.join("C:\\Roaming", "Closedloop"),
        path.join("C:\\Users\\x", "AppData", "Roaming", "Closedloop"),
        path.join("/cfg", "Closedloop"),
        path.join("/home/x", ".config", "Closedloop"),
      ]);
    },
    CHILD_CASE_TIMEOUT_MS
  );

  it(
    "uses the running platform, env and home directory by default",
    () => {
      const [implicit, explicit] = runInChild<[string, string]>(
        `const os = await import("node:os");
        out([m.defaultSourceUserDataDir(), m.defaultSourceUserDataDir(process.platform, process.env, os.homedir())]);`
      );
      expect(implicit).toBe(explicit);
    },
    CHILD_CASE_TIMEOUT_MS
  );
});

describe("utcStamp", () => {
  it(
    "formats a given date, and stamps the current clock when none is passed",
    () => {
      const [given, before, now, after] = runInChild<string[]>(
        `out([
          m.utcStamp(new Date("2026-08-04T15:12:33.456Z")),
          m.utcStamp(new Date()),
          m.utcStamp(),
          m.utcStamp(new Date()),
        ]);`
      );
      expect(given).toBe("20260804T151233Z");
      expect(now).toMatch(STAMP_PATTERN);
      expect(now >= before && now <= after).toBe(true);
    },
    CHILD_CASE_TIMEOUT_MS
  );
});

describe("the entrypoint gate", () => {
  it(
    "does not run main() when the module is imported with no script argv",
    () => {
      // `-e` leaves process.argv[1] undefined, so the gate's first operand is
      // false. A main() that ran would print its plan or a
      // "perf-prepare-dataset:" error; the import must print only this line.
      const result = spawnChild(
        'out(["loaded", typeof m.prepareDataset, process.argv[1] === undefined]);'
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(["loaded", "function", true]);
      expect(result.stderr).toBe("");
    },
    CHILD_CASE_TIMEOUT_MS
  );

  it(
    "does not run main() when argv[1] names a different script",
    () => {
      const other = path.join(DESKTOP_DIR, "scripts", "not-this-script.mjs");
      const result = spawnChild('out(["loaded", process.argv[1]]);', [other]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(["loaded", other]);
      expect(result.stderr).toBe("");
    },
    CHILD_CASE_TIMEOUT_MS
  );

  it(
    "runs main() when executed directly, and exits 1 with the refusal for an unignored target",
    () => {
      const scratch = mkdtempSync(
        path.join(tmpdir(), "perf-prepare-iss12394-")
      );
      try {
        const target = path.join(scratch, "dataset");
        const result = spawnSync(
          process.execPath,
          [
            "--no-warnings",
            fileURLToPath(MODULE_URL),
            "--source",
            path.join(scratch, "no-such-profile"),
            "--target",
            target,
          ],
          {
            cwd: DESKTOP_DIR,
            encoding: "utf8",
            timeout: CHILD_SPAWN_TIMEOUT_MS,
          }
        );
        if (result.error) {
          throw new Error(`script did not run: ${result.error.message}`);
        }
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          `perf-prepare-dataset: Refusing to write ${target}: git does not report it as ignored.`
        );
        expect(existsSync(target)).toBe(false);
      } finally {
        rmSync(scratch, { force: true, recursive: true });
      }
    },
    CHILD_CASE_TIMEOUT_MS
  );
});
