/**
 * ISS-5303 — behaviour coverage for the Agent Dashboard storage measurement.
 *
 * Two layers, deliberately. The lib cases drive the extracted functions against
 * real temp-directory fixtures, because the recursion and the absent-path
 * branch are the logic worth pinning. The subprocess cases then run the actual
 * `measure-agent-dashboard-storage.mjs` entrypoint, which is the only way to
 * prove the shell still wires those functions to the JSON an operator reads —
 * a lib test alone stays green while the entrypoint imports the wrong helper.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  AGENT_DASHBOARD_STORAGE_DIRNAME,
  AGENT_DASHBOARD_STORAGE_MODE,
  measureExistingDirectory,
  measurePath,
  parseUserDataArg,
  USER_DATA_FLAG,
} from "../scripts/measure-agent-dashboard-storage-lib.mjs";
import { defaultSourceUserDataDir } from "../scripts/perf-prepare-dataset.mjs";

/** Hoisted per Ultracite's `useTopLevelRegex` rule. */
const MISSING_VALUE_MESSAGE = /--user-data requires a path value/;

const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(
  DESKTOP_DIR,
  "scripts",
  "measure-agent-dashboard-storage.mjs"
);

/**
 * The child prints and exits; anything approaching this is a hang, not a slow
 * machine. node:test's own `timeout` cannot interrupt `spawnSync` (it blocks
 * this worker's event loop), so the child needs its own deadline.
 */
const SPAWN_TIMEOUT_MS = 30_000;
const CASE_TIMEOUT_MS = 60_000;

const measurementSchema = z.object({
  mode: z.string(),
  path: z.string(),
  exists: z.boolean(),
  bytes: z.number(),
  files: z.number(),
  directories: z.number(),
});

const reportSchema = z.object({
  userDataPath: z.string(),
  measurements: z.array(measurementSchema),
});

type StorageReport = z.infer<typeof reportSchema>;

function withTempDir<T>(prefix: string, run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

/**
 * A store with a known shape: two files totalling 67 bytes across two
 * directories (the store root plus `base/`).
 */
function seedStore(userDataDir: string): string {
  const store = join(userDataDir, AGENT_DASHBOARD_STORAGE_DIRNAME);
  mkdirSync(join(store, "base"), { recursive: true });
  writeFileSync(join(store, "PG_VERSION"), "16\n");
  writeFileSync(join(store, "base", "1259"), "x".repeat(64));
  return store;
}

function runEntrypoint(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): StorageReport {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    cwd: DESKTOP_DIR,
    encoding: "utf8",
    env,
    timeout: SPAWN_TIMEOUT_MS,
  });

  // Preconditions, not assertions: without a clean exit there is no JSON to
  // check, and a raw parse error would hide why.
  if (result.error) {
    throw new Error(`the measure script did not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `the measure script exited ${result.status}\n${result.stdout}\n${result.stderr}`
    );
  }

  const parsed: unknown = JSON.parse(result.stdout);
  return reportSchema.parse(parsed);
}

describe("ISS-5303: parsing the --user-data override", () => {
  test("resolves the value that follows the flag", () => {
    const parsed = parseUserDataArg([
      process.execPath,
      SCRIPT_PATH,
      USER_DATA_FLAG,
      join("some", "relative", "profile"),
    ]);

    // Resolved, not passed through: every downstream path is joined onto this
    // and then printed for a human to act on.
    assert.equal(parsed, resolve(join("some", "relative", "profile")));
  });

  test("returns null when the flag is absent", () => {
    assert.equal(parseUserDataArg([process.execPath, SCRIPT_PATH]), null);
  });

  test("throws when the flag is the last argument", () => {
    // Silently falling back to the platform default here would answer a
    // question the caller did not ask, about a directory they did not name.
    assert.throws(
      () => parseUserDataArg([process.execPath, SCRIPT_PATH, USER_DATA_FLAG]),
      MISSING_VALUE_MESSAGE
    );
  });

  test("throws when the flag is given an empty value", () => {
    assert.throws(
      () =>
        parseUserDataArg([process.execPath, SCRIPT_PATH, USER_DATA_FLAG, ""]),
      MISSING_VALUE_MESSAGE
    );
  });
});

describe("ISS-5303: totalling a path on disk", () => {
  test("a single file is its own size and one file", () => {
    withTempDir("measure-storage-file-", (dir) => {
      const file = join(dir, "PG_VERSION");
      writeFileSync(file, "16\n");

      assert.deepEqual(measurePath(file), {
        bytes: 3,
        files: 1,
        directories: 0,
      });
    });
  });

  test("an empty directory counts itself and nothing else", () => {
    withTempDir("measure-storage-empty-", (dir) => {
      const empty = join(dir, "pg_notify");
      mkdirSync(empty);

      assert.deepEqual(measurePath(empty), {
        bytes: 0,
        files: 0,
        directories: 1,
      });
    });
  });

  test("a nested tree sums every level, not just the top one", () => {
    withTempDir("measure-storage-tree-", (dir) => {
      // 3 + 5 + 7 bytes across three levels, plus an empty leaf directory that
      // contributes a directory and nothing else. A walk that stopped at the
      // first level would report 3 bytes / 1 file / 2 directories.
      const root = join(dir, "agent-dashboard.pgdata");
      mkdirSync(join(root, "base", "deep"), { recursive: true });
      mkdirSync(join(root, "base", "pg_wal"));
      writeFileSync(join(root, "a.txt"), "aaa");
      writeFileSync(join(root, "base", "b.txt"), "bbbbb");
      writeFileSync(join(root, "base", "deep", "c.txt"), "ccccccc");

      assert.deepEqual(measurePath(root), {
        bytes: 15,
        files: 3,
        directories: 4,
      });
    });
  });
});

describe("ISS-5303: measuring a store that may not exist", () => {
  test("an absent store reports zeros and is not created", () => {
    withTempDir("measure-storage-absent-", (dir) => {
      const target = {
        mode: AGENT_DASHBOARD_STORAGE_MODE,
        path: join(dir, AGENT_DASHBOARD_STORAGE_DIRNAME),
      };

      assert.deepEqual(measureExistingDirectory(target), {
        mode: AGENT_DASHBOARD_STORAGE_MODE,
        path: target.path,
        exists: false,
        bytes: 0,
        files: 0,
        directories: 0,
      });
      // The reason this function exists: measuring a machine that has never
      // launched the app must not leave a store behind on it.
      assert.equal(
        existsSync(target.path),
        false,
        "measuring an absent store created it"
      );
    });
  });

  test("an existing store reports its totals alongside the target", () => {
    withTempDir("measure-storage-present-", (dir) => {
      const store = seedStore(dir);

      assert.deepEqual(
        measureExistingDirectory({
          mode: AGENT_DASHBOARD_STORAGE_MODE,
          path: store,
        }),
        {
          mode: AGENT_DASHBOARD_STORAGE_MODE,
          path: store,
          exists: true,
          bytes: 67,
          files: 2,
          directories: 2,
        }
      );
    });
  });
});

describe("ISS-5303: the measure-agent-dashboard-storage entrypoint", () => {
  test("prints the measured store for the directory it was pointed at", {
    timeout: CASE_TIMEOUT_MS,
  }, () => {
    withTempDir("measure-storage-cli-", (dir) => {
      const store = seedStore(dir);

      const report = runEntrypoint([USER_DATA_FLAG, dir]);

      assert.equal(report.userDataPath, dir);
      assert.deepEqual(report.measurements, [
        {
          mode: AGENT_DASHBOARD_STORAGE_MODE,
          path: store,
          exists: true,
          bytes: 67,
          files: 2,
          directories: 2,
        },
      ]);
    });
  });

  test("reports an absent store without creating it", {
    timeout: CASE_TIMEOUT_MS,
  }, () => {
    withTempDir("measure-storage-cli-absent-", (dir) => {
      const report = runEntrypoint([USER_DATA_FLAG, dir]);

      assert.deepEqual(report.measurements, [
        {
          mode: AGENT_DASHBOARD_STORAGE_MODE,
          path: join(dir, AGENT_DASHBOARD_STORAGE_DIRNAME),
          exists: false,
          bytes: 0,
          files: 0,
          directories: 0,
        },
      ]);
      assert.equal(
        existsSync(join(dir, AGENT_DASHBOARD_STORAGE_DIRNAME)),
        false,
        "the entrypoint created the store it was asked to measure"
      );
    });
  });

  test("falls back to the canonical Electron userData directory", {
    timeout: CASE_TIMEOUT_MS,
  }, () => {
    withTempDir("measure-storage-cli-default-", (dir) => {
      // XDG_CONFIG_HOME points somewhere OTHER than `$HOME/.config` on
      // purpose. That is the one place `defaultSourceUserDataDir` and the
      // local copy this script used to carry disagree, so on Linux this
      // assertion fails the moment the shared helper is swapped back out for
      // a private reimplementation. On darwin/win32 the two agree and this
      // degrades to a smoke check of the no-flag path.
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        APPDATA: join(dir, "Roaming"),
        HOME: dir,
        USERPROFILE: dir,
        XDG_CONFIG_HOME: join(dir, "xdg"),
      };

      const report = runEntrypoint([], env);

      assert.equal(
        report.userDataPath,
        defaultSourceUserDataDir(process.platform, env, dir)
      );
      assert.deepEqual(report.measurements, [
        {
          mode: AGENT_DASHBOARD_STORAGE_MODE,
          path: join(report.userDataPath, AGENT_DASHBOARD_STORAGE_DIRNAME),
          exists: false,
          bytes: 0,
          files: 0,
          directories: 0,
        },
      ]);
    });
  });
});
