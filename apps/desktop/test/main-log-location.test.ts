import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  DesktopProfileKind,
  formatDesktopBootLine,
  resolveDesktopProfileKind,
  resolveMainLogDirectory,
} from "../src/main/logging/main-log-location.js";

// ISS-4916. The production log lives at electron-log's default location; a
// throwaway profile (Electron e2e temp userData, golden mode, an operator
// `--user-data-dir`) must keep its log inside that profile so its boot,
// migration-replay, and teardown-cascade lines never interleave into the
// operator's real main.log.

const APP_DATA = "/Users/operator/Library/Application Support";
const APP_NAME = "Closedloop";
const DEFAULT_USER_DATA = path.join(APP_DATA, APP_NAME);
const E2E_USER_DATA =
  "/private/var/folders/ql/T/desktop-phase-label-udd-y6L8cq";
const COMMIT_HASH = "72ed3a2feafe5df6178806f997ad44eaf1441184";
// Hoisted to satisfy Biome useTopLevelRegex.
const BOOT_LINE_VERSION_RE = /^Desktop boot starting version=0\.16\.69 /;

test("the default profile keeps electron-log's own (production) log location", () => {
  const input = {
    userDataPath: DEFAULT_USER_DATA,
    appDataPath: APP_DATA,
    appName: APP_NAME,
  };

  assert.equal(
    resolveDesktopProfileKind(input),
    DesktopProfileKind.Default,
    "the operator's real profile is not a redirect"
  );
  assert.equal(
    resolveMainLogDirectory(input),
    null,
    "a null directory leaves the production log path untouched"
  );
});

test("a redirected profile writes its main log inside that profile, not the production log dir", () => {
  const input = {
    userDataPath: E2E_USER_DATA,
    appDataPath: APP_DATA,
    appName: APP_NAME,
  };

  assert.equal(
    resolveDesktopProfileKind(input),
    DesktopProfileKind.Redirected,
    "an e2e temp userData is a redirected profile"
  );
  const logDir = resolveMainLogDirectory(input);
  assert.equal(logDir, path.join(E2E_USER_DATA, "logs"));
  // The regression itself: on macOS the production log dir sits outside
  // userData, so a redirect that resolved back into it would reintroduce the
  // interleaving this ticket fixes.
  assert.equal(
    logDir?.startsWith(`${E2E_USER_DATA}${path.sep}`),
    true,
    "the redirected log stays inside the throwaway profile"
  );
  assert.equal(
    logDir?.startsWith(DEFAULT_USER_DATA),
    false,
    "the redirected log never lands under the default profile"
  );
});

test("a non-normalized spelling of the default profile is not mistaken for a redirect", () => {
  // Guards the inverse failure: a trailing separator or a `.` segment moving the
  // PRODUCTION log to a new path would silently orphan the operator's history.
  for (const spelling of [
    `${DEFAULT_USER_DATA}${path.sep}`,
    `${APP_DATA}${path.sep}.${path.sep}${APP_NAME}`,
    `${APP_DATA}${path.sep}other${path.sep}..${path.sep}${APP_NAME}`,
  ]) {
    assert.equal(
      resolveMainLogDirectory({
        userDataPath: spelling,
        appDataPath: APP_DATA,
        appName: APP_NAME,
      }),
      null,
      `${spelling} is still the default profile`
    );
  }
});

test("the boot line reports the baked build identity and profile marker, not app.getVersion()", () => {
  const line = formatDesktopBootLine({
    userDataPath: E2E_USER_DATA,
    appDataPath: APP_DATA,
    appName: APP_NAME,
    buildAppVersion: "0.16.69",
    buildCommitHash: COMMIT_HASH,
    // The launch-mode-dependent value the old line reported as `version=`.
    electronVersion: "43.0.0",
    logFilePath: path.join(E2E_USER_DATA, "logs", "main.log"),
  });

  assert.match(line, BOOT_LINE_VERSION_RE);
  assert.ok(
    line.includes(`commit=${COMMIT_HASH.slice(0, 7)}`),
    `boot line carries the build commit: ${line}`
  );
  assert.ok(
    line.includes("electron=43.0.0"),
    `the Electron version is labelled as such: ${line}`
  );
  assert.ok(
    line.includes(`profile=${DesktopProfileKind.Redirected}`),
    `a throwaway instance is marked in the line itself: ${line}`
  );
  assert.equal(
    line.includes("version=43.0.0"),
    false,
    "the Electron version can never be read as the app build again"
  );
});

test("the boot line marks a default-profile launch and degrades on missing build info", () => {
  const line = formatDesktopBootLine({
    userDataPath: DEFAULT_USER_DATA,
    appDataPath: APP_DATA,
    appName: APP_NAME,
    // write-build-info.mjs emits "" when package.json carries no version.
    buildAppVersion: "",
    buildCommitHash: "",
    electronVersion: "43.0.0",
    logFilePath: path.join(DEFAULT_USER_DATA, "main.log"),
  });

  assert.ok(
    line.includes(`profile=${DesktopProfileKind.Default}`),
    `the operator's real instance is marked too: ${line}`
  );
  assert.ok(
    line.includes("version=unknown") && line.includes("commit=unknown"),
    `absent build info reads as unknown rather than empty: ${line}`
  );
});
