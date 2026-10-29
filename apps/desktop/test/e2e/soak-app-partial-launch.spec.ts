/**
 * ISS-6945: a soak launch that spawns Electron but receives no first window
 * must leave no OS process behind and retain the cycle owner's evidence.
 *
 * This fixture launches a minimal real Electron main with a small real profile
 * and no BrowserWindow. It keeps the lifecycle boundary real without requiring
 * the built desktop app or the multi-gigabyte soak snapshot.
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  test,
} from "@playwright/test";
import { launchSoakApp, type SoakElectronLauncher } from "../soak/soak-app.js";
import { hasProcessExited } from "./helpers/desktop-app.js";
import {
  firstWindowOrExplainExit,
  launchElectronOrExplain,
} from "./helpers/electron-launch-attribution.js";

const FIRST_WINDOW_TIMEOUT_MS = 1000;
const STDOUT_OOM_SIGNATURE = "Reached heap limit";
const STDERR_OOM_SIGNATURE = "FATAL ERROR";
const FIRST_WINDOW_TIMEOUT_PATTERN = /firstWindow.*Timeout 1000ms exceeded/is;

type LaunchObservation = {
  child: ChildProcess;
  processAliveAtFirstWindow: boolean;
  profileExistedAtFirstWindow: boolean;
};

const launchedApps: ElectronApplication[] = [];
const tempRoots: string[] = [];

test.afterAll(async () => {
  for (const app of launchedApps) {
    await app.close().catch(() => undefined);
  }
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function isProcessAlive(child: ChildProcess): boolean {
  if (child.pid === undefined) {
    return false;
  }
  try {
    process.kill(child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function minimalElectronLauncher(
  mainPath: string,
  emitDiagnosticsPath: string,
  userDataDir: string,
  observations: LaunchObservation[]
): SoakElectronLauncher {
  return async (launchOptions) => {
    const args = launchOptions?.args ?? [];
    const app = await launchElectronOrExplain(
      {
        ...(launchOptions ?? {}),
        args: [mainPath, ...args.slice(1)],
      },
      (prepared) => electron.launch(prepared)
    );
    launchedApps.push(app);
    const child = app.process();

    return {
      close: () => app.close(),
      process: () => child,
      firstWindow: async (options) => {
        observations.push({
          child,
          processAliveAtFirstWindow: isProcessAlive(child),
          profileExistedAtFirstWindow: fs.existsSync(userDataDir),
        });
        const stdout = once(child.stdout!, "data");
        const stderr = once(child.stderr!, "data");
        fs.writeFileSync(emitDiagnosticsPath, "emit");
        await Promise.all([stdout, stderr]);
        return firstWindowOrExplainExit(app.firstWindow(options), child);
      },
    } as ElectronApplication;
  };
}

test("a rejected first window kills Electron and preserves cycle-owned evidence", async () => {
  test.setTimeout(20_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iss-6945-soak-launch-"));
  tempRoots.push(root);
  const userDataDir = path.join(root, "cycle-profile");
  fs.mkdirSync(userDataDir);
  fs.writeFileSync(path.join(userDataDir, "small-fixture"), "profile exists");
  const stdioLogPath = path.join(root, "stdio.log");
  const emitDiagnosticsPath = path.join(root, "emit-diagnostics");
  const mainPath = path.join(root, "minimal-electron.cjs");
  fs.writeFileSync(
    mainPath,
    `const { app } = require("electron");
const fs = require("node:fs");
const signalPath = ${JSON.stringify(emitDiagnosticsPath)};
const poll = setInterval(() => {
  if (!fs.existsSync(signalPath)) return;
  clearInterval(poll);
  process.stdout.write(${JSON.stringify(STDOUT_OOM_SIGNATURE)});
  process.stderr.write(${JSON.stringify(STDERR_OOM_SIGNATURE)});
}, 10);
app.whenReady().then(() => {});
`
  );
  const observations: LaunchObservation[] = [];
  const mock = {
    apiOrigin: "http://127.0.0.1:1",
    relayOrigin: "http://127.0.0.1:2",
  };

  const thrown = await launchSoakApp(userDataDir, mock, {}, stdioLogPath, {
    launchElectron: minimalElectronLauncher(
      mainPath,
      emitDiagnosticsPath,
      userDataDir,
      observations
    ),
    firstWindowTimeoutMs: FIRST_WINDOW_TIMEOUT_MS,
  }).then(
    () => undefined,
    (error: unknown) => error
  );

  assert.equal(observations.length, 1, "Electron must launch exactly once");
  const observed = observations[0];
  assert.ok(observed);
  assert.ok(observed.child.pid, "the Electron launch must expose an OS pid");
  assert.equal(
    observed.processAliveAtFirstWindow,
    true,
    "no live Electron process reached firstWindow, so cleanup proved nothing"
  );
  assert.equal(
    observed.profileExistedAtFirstWindow,
    true,
    "the profile never existed, so removal proved nothing"
  );
  assert.deepEqual(
    {
      processExited: hasProcessExited(observed.child),
      processStillAlive: isProcessAlive(observed.child),
      profileRetained: fs.existsSync(userDataDir),
    },
    { processExited: true, processStillAlive: false, profileRetained: true }
  );

  assert.ok(thrown instanceof Error);
  assert.ok(thrown.message.includes(userDataDir));
  assert.match(thrown.message, FIRST_WINDOW_TIMEOUT_PATTERN);
  assert.match(thrown.message, new RegExp(STDOUT_OOM_SIGNATURE));
  assert.match(thrown.message, new RegExp(STDERR_OOM_SIGNATURE));
  assert.ok(thrown.cause instanceof Error);
  assert.match(thrown.cause.message, FIRST_WINDOW_TIMEOUT_PATTERN);
});
