/**
 * ISS-5303 — `scripts/reset-dashboard-db-lib.mjs`.
 *
 * `reset-dashboard-db.mjs` is a destructive FTUE tool: it resolves the Agent
 * Dashboard database directory and deletes it recursively. It calls `main()` at
 * module scope, so it can never be imported here — and driving it as a
 * subprocess would either wipe the operator's real database or trip its
 * app-is-running interlock, depending on whether the desktop app happens to be
 * open. So the two pure halves are tested directly, and the shell's wiring
 * (including that the interlock is still there) is pinned structurally.
 *
 * Every filesystem assertion runs inside a `mkdtemp` sandbox. Nothing in this
 * file resolves, reads, or removes anything under the real `~/.config`,
 * `~/Library/Application Support`, or `%APPDATA%`.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  APP_NAME,
  DB_DIR,
  dashboardDbPath,
  removeAll,
} from "../scripts/reset-dashboard-db-lib.mjs";
import {
  calledIdentifiers,
  declaredFunctionNames,
  namedImportsFrom,
  parseDesktopScript,
} from "./helpers/entrypoint-wiring.js";

const FAKE_HOME = path.join(path.sep, "synthetic-home", "tester");

describe("ISS-5303: dashboardDbPath mirrors app.getPath('userData')", () => {
  test("darwin resolves under Library/Application Support", () => {
    assert.equal(
      dashboardDbPath("darwin", {}, FAKE_HOME),
      path.join(FAKE_HOME, "Library", "Application Support", APP_NAME, DB_DIR)
    );
  });

  test("win32 honours APPDATA", () => {
    const appData = path.join(path.sep, "roaming-elsewhere");

    assert.equal(
      dashboardDbPath("win32", { APPDATA: appData }, FAKE_HOME),
      path.join(appData, APP_NAME, DB_DIR)
    );
  });

  test("win32 falls back to AppData/Roaming when APPDATA is unset", () => {
    assert.equal(
      dashboardDbPath("win32", {}, FAKE_HOME),
      path.join(FAKE_HOME, "AppData", "Roaming", APP_NAME, DB_DIR)
    );
  });

  test("win32 treats an empty APPDATA as unset", () => {
    // An empty string would otherwise join to a relative path and the script
    // would delete a directory under the CWD.
    assert.equal(
      dashboardDbPath("win32", { APPDATA: "" }, FAKE_HOME),
      path.join(FAKE_HOME, "AppData", "Roaming", APP_NAME, DB_DIR)
    );
  });

  test("linux resolves under ~/.config", () => {
    assert.equal(
      dashboardDbPath("linux", {}, FAKE_HOME),
      path.join(FAKE_HOME, ".config", APP_NAME, DB_DIR)
    );
  });

  test("an unrecognised platform takes the linux layout", () => {
    assert.equal(
      dashboardDbPath("freebsd", {}, FAKE_HOME),
      path.join(FAKE_HOME, ".config", APP_NAME, DB_DIR)
    );
  });

  test("XDG_CONFIG_HOME is IGNORED — the documented divergence", () => {
    // Electron honours XDG_CONFIG_HOME, and so does
    // `perf-prepare-dataset.mjs`'s `defaultSourceUserDataDir`. This script does
    // not, so on a box that sets it the reset targets a directory the app never
    // used and reports "nothing to do". ISS-5303 is a behaviour-preserving
    // extraction, so the gap is pinned here rather than quietly closed:
    // changing which directory a destructive script deletes needs its own
    // ticket, and this assertion is what makes that change visible.
    assert.equal(
      dashboardDbPath(
        "linux",
        { XDG_CONFIG_HOME: path.join(path.sep, "xdg-config") },
        FAKE_HOME
      ),
      path.join(FAKE_HOME, ".config", APP_NAME, DB_DIR)
    );
  });
});

describe("ISS-5303: removeAll wipes the database directory", () => {
  let sandbox = "";
  let userData = "";
  let dbPath = "";
  let logged: string[] = [];

  beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), "iss5303-reset-db-"));
    userData = path.join(sandbox, APP_NAME);
    dbPath = path.join(userData, DB_DIR);
    logged = [];
  });

  afterEach(() => {
    const created = sandbox;
    sandbox = "";
    if (created) {
      rmSync(created, { recursive: true, force: true });
    }
  });

  function seedDatabase(): string[] {
    mkdirSync(path.join(dbPath, "base"), { recursive: true });
    // The store leaves SQLite sidecars beside its main file; a non-recursive
    // unlink would strip the database and leave a -wal that the next launch
    // replays into a half-restored state.
    const files = [
      path.join(dbPath, "agent-dashboard.db"),
      path.join(dbPath, "agent-dashboard.db-wal"),
      path.join(dbPath, "agent-dashboard.db-shm"),
      path.join(dbPath, "base", "1"),
    ];
    for (const file of files) {
      writeFileSync(file, "x");
    }
    return files;
  }

  test("removes the tree, its sidecars, and reports the path", () => {
    const seeded = seedDatabase();

    removeAll(dbPath, (message) => logged.push(message));

    assert.equal(existsSync(dbPath), false);
    for (const file of seeded) {
      assert.equal(existsSync(file), false, `${file} survived the wipe`);
    }
    assert.deepEqual(logged, [`[reset-dashboard-db] removed ${dbPath}`]);
  });

  test("leaves the rest of userData alone", () => {
    // The wipe is scoped to the database directory. Settings, the gateway
    // keypair and the log directory are siblings, and losing them would turn a
    // data reset into a full re-onboarding.
    seedDatabase();
    const settings = path.join(userData, "settings.json");
    writeFileSync(settings, "{}");

    removeAll(dbPath, (message) => logged.push(message));

    assert.equal(existsSync(settings), true);
    assert.equal(existsSync(userData), true);
  });

  test("a missing path is a no-op, not an error", () => {
    // A machine that has never launched the app has nothing to wipe, and the
    // reset has to stay idempotent.
    const absent = path.join(sandbox, "never-launched", DB_DIR);

    removeAll(absent, (message) => logged.push(message));

    assert.deepEqual(logged, []);
    assert.equal(existsSync(sandbox), true);
  });
});

describe("ISS-5303: reset-dashboard-db.mjs is wired to the lib", () => {
  test("imports both helpers and redeclares neither", () => {
    const entrypoint = parseDesktopScript("reset-dashboard-db.mjs");

    assert.deepEqual(
      namedImportsFrom(entrypoint, "./reset-dashboard-db-lib.mjs"),
      ["dashboardDbPath", "removeAll"]
    );

    const declared = declaredFunctionNames(entrypoint);
    assert.equal(declared.includes("dashboardDbPath"), false);
    assert.equal(declared.includes("removeAll"), false);
  });

  test("still resolves the path and performs the removal", () => {
    const called = calledIdentifiers(
      parseDesktopScript("reset-dashboard-db.mjs")
    );

    assert.equal(called.includes("dashboardDbPath"), true);
    assert.equal(called.includes("removeAll"), true);
  });

  test("keeps the app-is-running interlock in the entrypoint", () => {
    // The script refuses to run while the desktop app holds 127.0.0.1:4820,
    // because SQLite owns the data directory it is about to delete. That guard
    // is deliberately NOT part of the extracted lib, and nothing in ISS-5303
    // may weaken it — deleting it would make an extraction that was supposed to
    // be behaviour-preserving into a data-corruption bug.
    const entrypoint = parseDesktopScript("reset-dashboard-db.mjs");

    assert.equal(
      declaredFunctionNames(entrypoint).includes("appIsRunning"),
      true
    );
    assert.equal(calledIdentifiers(entrypoint).includes("appIsRunning"), true);
  });
});
