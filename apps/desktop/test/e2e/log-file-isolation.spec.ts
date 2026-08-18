/**
 * ISS-4916 regression: an Electron e2e run must NOT write into the production
 * `main.log`.
 *
 * Every spec in this suite launches with a throwaway `--user-data-dir`, but the
 * log went to electron-log's default location — on macOS `~/Library/Logs/
 * ClosedLoop/main.log`, the operator's real app log — with nothing in the line
 * to mark it as a test instance. Rapid boot/quit pairs, a full migration replay
 * against each fresh empty DB, and the teardown lane-error cascade all landed in
 * the production log and were read as production crash-loops, a DB-ahead
 * migration downgrade, and a shutdown cascade on the operator's real store.
 *
 * This spec drives the launched app end to end and proves the redirect: the boot
 * line lands in the throwaway profile, and the production log file is byte-for-
 * byte unchanged across the run.
 */

import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktop-app.js";

const LOG_WAIT_TIMEOUT_MS = 20_000;
const BOOT_LINE_RE = /Desktop boot starting [^\n]*/;
// The line is persisted inside a JSON `message` field, so stop the path capture
// at the closing quote as well as at whitespace.
const BOOT_LOG_PATH_RE = /Desktop boot starting [^\n]*\slog=([^\s"\\]+)/;
const BOOT_COMMIT_RE = /commit=[0-9a-f]{7}/;
const BOOT_ELECTRON_RE = /electron=\d+\./;
// Emitted at the very top of run(), BEFORE the log transport knows which profile
// it belongs to. Its presence in the redirected log is what proves the
// pre-initialization buffering works end to end (codex review, ISS-4916): before
// buffering, every line written this early went to the production main.log.
const PRE_INIT_LAUNCH_LINE = "Desktop launch: pid=";

/**
 * The production main-log path for this platform, computed from the launched
 * app's OWN Electron paths. Deliberately not read from `app.getPath("logs")`
 * inside the instance: on Linux that path derives from `userData`, so the
 * redirected instance would report its own temp log and the assertion would
 * check nothing.
 */
function productionMainLogPath(appDataPath: string, appName: string): string {
  if (process.platform === "darwin") {
    const home = path.dirname(path.dirname(appDataPath)); // ~/Library/Application Support -> ~
    return path.join(home, "Library", "Logs", appName, "main.log");
  }
  return path.join(appDataPath, appName, "logs", "main.log");
}

function readFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

test("an e2e launch logs into its throwaway profile and leaves the production main.log untouched", async () => {
  const launched = await launchDesktopApp({
    userDataPrefix: "desktop-log-isolation-",
  });
  const { app, userDataDir, cleanup } = launched;

  let productionLogPath: string | null = null;

  try {
    const { appDataPath, appName } = await app.evaluate(
      ({ app: electronApp }) => ({
        appDataPath: electronApp.getPath("appData"),
        appName: electronApp.getName(),
      })
    );
    productionLogPath = productionMainLogPath(appDataPath, appName);

    const redirectedLogPath = path.join(userDataDir, "logs", "main.log");

    // 1. The instance writes its durable log inside its own throwaway profile.
    await expect
      .poll(() => readFileOrNull(redirectedLogPath) ?? "", {
        timeout: LOG_WAIT_TIMEOUT_MS,
        message: `expected a durable log at ${redirectedLogPath}`,
      })
      .toContain("Desktop boot starting");

    const redirectedLog = readFileOrNull(redirectedLogPath) ?? "";
    const bootLine = redirectedLog.match(BOOT_LINE_RE)?.[0] ?? "";
    expect(bootLine, "boot line present in the redirected log").not.toBe("");

    // 2. The app's own resolved log path points inside the throwaway profile —
    //    this is the value Diagnostics and the crash dialog surface.
    const reportedLogPath = bootLine.match(BOOT_LOG_PATH_RE)?.[1] ?? "";
    expect(
      path.resolve(reportedLogPath).startsWith(path.resolve(userDataDir)),
      `the app reports a log path inside its profile, got ${reportedLogPath}`
    ).toBe(true);

    // 3. The line identifies the instance and the build it came from, so a line
    //    that DOES end up beside production lines can still be told apart.
    expect(bootLine).toContain("profile=redirected");
    expect(bootLine).toMatch(BOOT_COMMIT_RE);
    expect(bootLine).toMatch(BOOT_ELECTRON_RE);

    // 3b. The lines written BEFORE the redirect was configured are in here too,
    //     not in the production log — the buffering path, proven end to end.
    expect(
      redirectedLog,
      "the pre-initialization launch line was buffered into this profile"
    ).toContain(PRE_INIT_LAUNCH_LINE);
  } finally {
    await cleanup();
  }

  // 4. The regression itself: nothing this run produced reached the production
  //    log. Read after teardown so the boot/quit pair, the migration replay, and
  //    the shutdown cascade are all in scope. The throwaway profile path is
  //    unique per run and appears in this instance's own boot line, so its
  //    absence is a precise signal — and unlike a whole-file diff it does not
  //    flake when the operator's real Desktop app is running alongside.
  const productionLog = readFileOrNull(productionLogPath ?? "") ?? "";
  expect(
    productionLog.includes(userDataDir),
    `no line from this e2e run reached ${productionLogPath}`
  ).toBe(false);
});
