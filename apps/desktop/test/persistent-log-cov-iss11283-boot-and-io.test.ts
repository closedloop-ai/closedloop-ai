/**
 * @file persistent-log-cov-iss11283-boot-and-io.test.ts
 * @description ISS-11283 lane F — branch coverage for `persistent-log.ts`'s
 * profile-redirect initialization, the already-initialized no-op guard,
 * `describeDesktopBootIdentity`'s non-Electron `electronVersion` fallback,
 * `openMainLogFile`'s success/failure mapping, the durable "debug" write
 * branch, the previous-session tail's non-ENOENT read failure and
 * empty-file paths, and the gateway-line generic-parsing fallback — none of
 * which the existing `persistent-log.test.ts` reaches.
 *
 * `persistent-log.ts` imports Electron's `app` and `shell` at module scope, so
 * the hoisted `vi.mock("electron")` below swaps in the shared main-process
 * recording double before the static import resolves.
 *
 * The module's `initialized` latch is set once per module instance and never
 * reset. `beforeAll` spends it on a redirect into a temp profile before any
 * case runs, so every case — in any order, or run alone with `-t` — writes and
 * reads that temp log and never electron-log's default path under `$HOME`.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, test, vi } from "vitest";
import { writePersistentLog } from "../src/main/logging/durable-log-sink.js";
import {
  describeDesktopBootIdentity,
  electronLog,
  getMainLogFilePath,
  initializePersistentLogging,
  openMainLogFile,
  parsePreviousSessionLogLine,
  readPreviousSessionLogTail,
} from "../src/main/logging/persistent-log.js";
import { shell } from "./helpers/electron-module-stub.js";

vi.mock("electron", async () => {
  const stub = await import("./helpers/electron-main-module-stub.js");
  return { ...stub, default: stub.default };
});

const DEBUG_MESSAGE_MARKER_RE = /cov-debug-message-marker/;
const BOOT_LINE_PREFIX_RE = /^Desktop boot starting version=/;
const ELECTRON_VERSION_UNKNOWN_RE = /electron=unknown\b/;
const UNABLE_TO_READ_TAIL_RE = /Unable to read previous log tail/;
const APP_NAME = "Closedloop";

const tempDirs: string[] = [];
let userDataRoot: string;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function readMainLogOrEmpty(): string {
  const logPath = getMainLogFilePath();
  return existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
}

beforeAll(() => {
  userDataRoot = makeTempDir("desktop-persistent-log-cov-profile-");
  initializePersistentLogging({
    userDataPath: userDataRoot,
    appDataPath: path.join(userDataRoot, "unrelated-appdata-root"),
    appName: APP_NAME,
  });
  // Every case below writes or reads the resolved log. If the redirect ever
  // failed to apply, fail the whole file here rather than let a case touch
  // the operator's real main.log.
  const logPath = getMainLogFilePath();
  if (!logPath.startsWith(path.resolve(userDataRoot) + path.sep)) {
    throw new Error(`main log escaped the temp profile: ${logPath}`);
  }
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("initializePersistentLogging profile redirection", () => {
  test("redirects the log file into a non-default profile's own directory", () => {
    const resolved = getMainLogFilePath();

    assert.equal(
      path.dirname(resolved),
      path.join(path.resolve(userDataRoot), "logs")
    );
    assert.equal(path.basename(resolved), "main.log");
  });

  test("is a no-op on a second call and keeps the first call's log location and transport config", () => {
    const logPathBefore = getMainLogFilePath();
    const archiveLogFnBefore = electronLog.transports.file.archiveLogFn;
    const resolvePathFnBefore = electronLog.transports.file.resolvePathFn;
    const secondRoot = makeTempDir("desktop-persistent-log-cov-second-");

    initializePersistentLogging({
      userDataPath: secondRoot,
      appDataPath: path.join(secondRoot, "unrelated-appdata-root"),
      appName: APP_NAME,
    });

    assert.equal(getMainLogFilePath(), logPathBefore);
    assert.equal(electronLog.transports.file.archiveLogFn, archiveLogFnBefore);
    assert.equal(
      electronLog.transports.file.resolvePathFn,
      resolvePathFnBefore
    );
  });

  test("writes a debug-level durable line through the redirected file transport", () => {
    writePersistentLog("debug", "cov-debug-tag", "cov-debug-message-marker");

    assert.match(readMainLogOrEmpty(), DEBUG_MESSAGE_MARKER_RE);
  });
});

describe("describeDesktopBootIdentity outside Electron", () => {
  test("falls back to 'unknown' for electronVersion when process.versions.electron is unset", () => {
    const line = describeDesktopBootIdentity();

    assert.match(line, BOOT_LINE_PREFIX_RE);
    assert.match(line, ELECTRON_VERSION_UNKNOWN_RE);
  });
});

describe("openMainLogFile", () => {
  const originalOpenPath = shell.openPath;

  afterEach(() => {
    shell.openPath = originalOpenPath;
  });

  test("reports ok when shell.openPath resolves to an empty string", async () => {
    let openedWith = "";
    shell.openPath = (target: string) => {
      openedWith = target;
      return Promise.resolve("");
    };

    const result = await openMainLogFile();

    assert.deepEqual(result, { ok: true });
    assert.equal(openedWith, getMainLogFilePath());
  });

  test("reports the platform error when shell.openPath resolves non-empty", async () => {
    shell.openPath = () => Promise.resolve("no handler for this file type");

    const result = await openMainLogFile();

    assert.deepEqual(result, {
      ok: false,
      error: "no handler for this file type",
    });
  });
});

describe("readPreviousSessionLogTail edge cases", () => {
  test("returns [] without reading anything when limit is not positive", async () => {
    // The file genuinely exists with real content: if the `limit <= 0` guard
    // were skipped, the read-and-parse path below would run and return
    // that content instead of [] by coincidence via an unrelated ENOENT.
    const dir = makeTempDir("desktop-persistent-log-cov-nonpositive-");
    const logPath = path.join(dir, "main.log");
    writeFileSync(logPath, "a-real-line-that-must-not-be-read\n");

    const entries = await readPreviousSessionLogTail(0, logPath);

    assert.deepEqual(entries, []);
  });

  test("returns [] and logs a warning for a non-ENOENT read failure", async () => {
    const dir = makeTempDir("desktop-persistent-log-cov-eisdir-");
    // Checked before the call so the match below can only come from it.
    assert.doesNotMatch(readMainLogOrEmpty(), UNABLE_TO_READ_TAIL_RE);

    // A directory handed to fs.promises.open("r") fails at read time with
    // EISDIR, not ENOENT, exercising the read_failed logging branch instead
    // of the silent missing-file branch.
    const entries = await readPreviousSessionLogTail(10, dir);

    assert.deepEqual(entries, []);
    assert.match(readMainLogOrEmpty(), UNABLE_TO_READ_TAIL_RE);
  });

  test("returns [] for a zero-byte log file", async () => {
    const dir = makeTempDir("desktop-persistent-log-cov-empty-");
    const logPath = path.join(dir, "main.log");
    writeFileSync(logPath, "");

    const entries = await readPreviousSessionLogTail(10, logPath);

    assert.deepEqual(entries, []);
  });

  test("actually reads and returns real entries for a positive limit", async () => {
    const dir = makeTempDir("desktop-persistent-log-cov-real-content-");
    const logPath = path.join(dir, "main.log");
    writeFileSync(logPath, "first-line\nsecond-line\n");

    const entries = await readPreviousSessionLogTail(10, logPath);

    assert.deepEqual(
      entries.map((entry) => entry.message),
      ["first-line", "second-line"]
    );
  });
});

describe("parsePreviousSessionLogLine gateway-prefixed but invalid JSON shape", () => {
  test("falls back to generic parsing when the JSON is well-formed but missing required fields", () => {
    const line =
      'closedloop-gateway-log {"level":"trace","message":"only a message"}';

    const parsed = parsePreviousSessionLogLine(line);

    assert.equal(parsed.level, "info");
    assert.equal(parsed.tag, "desktop");
    assert.equal(parsed.message, line);
    assert.equal(parsed.session, "previous");
  });
});
