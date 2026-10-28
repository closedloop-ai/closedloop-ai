/**
 * ISS-6929 — a desktop-e2e launch that comes up but never produces a window
 * must not leave the Electron process or its temp profile behind.
 *
 * Both launchers `await` the launch and then `await app.firstWindow()`. Between
 * those two lines a real OS process exists, and `launchDesktopApp` has also
 * `mkdtemp`'d a profile for it — so before this fix a `firstWindow()` rejection
 * orphaned both for the rest of the run, on a suite that runs `workers: 2`.
 *
 * The launch here is FAKE in exactly one respect and real in every other: the
 * injected launcher spawns a genuine child process instead of Electron, so the
 * production `closeElectronApp` does a genuine `SIGKILL` against a genuine
 * process handle and the production `fs.rmSync` removes a genuine directory.
 * That is what lets these cases assert an EXITED HANDLE and an ABSENT DIRECTORY
 * rather than the absence of a warning, which is what the ticket asks for.
 *
 * The whole of each launcher runs — the `mkdtemp`, settings seeding, teardown
 * closure and re-throw — so a case cannot pass against a re-implementation.
 *
 * BOTH launchers are driven here. `launchAuthenticatedDesktopApp` used to be
 * unreachable from this lane, because the module holding it also reaches the
 * repo-root `e2e/helpers/` fixtures and their `@repo/api` subpaths, which
 * resolve only under the Playwright runner (the import hazard in
 * `test/AGENTS.md`, in the other direction). It now lives in
 * `e2e/helpers/authenticated-desktop-app.ts`, which imports none of that — so
 * its lifecycle is covered by behavior rather than by a structural claim about
 * where a `try` sits.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { afterAll, describe, test } from "vitest";
import { launchAuthenticatedDesktopApp } from "./e2e/helpers/authenticated-desktop-app.js";
import {
  discardPartialLaunch,
  type ElectronLauncher,
  hasProcessExited,
  launchDesktopApp,
  USER_DATA_DIR_ARG,
} from "./e2e/helpers/desktop-app.js";

/**
 * The failure the launchers must hand back untouched.
 *
 * ISS-6875 (PR #5232) decorates a launch failure with a `harness_launch_failure`
 * marker over the original rejection as `cause`. That PR is not on `main` yet,
 * so this is not a second definition of its constant and nothing here produces
 * the marker — it is seeded as OPAQUE PAYLOAD, and what the cases assert is that
 * the teardown returns the very same error object with its message and `cause`
 * intact. Identity is the marker-agnostic form of "the cleanup must not swallow
 * the diagnosis": whatever decoration that PR lands, a re-thrown identical
 * object carries it by construction.
 */
const SEEDED_LAUNCH_FAILURE_MESSAGE =
  "harness_launch_failure: the Electron app did not come up";
/** Playwright's verbatim text for the underlying rejection. */
const PLAYWRIGHT_CAUSE_MESSAGE = "Process failed to launch!";

/** What the injected launcher saw at the moment it induced the rejection. */
type LaunchObservation = {
  child: ChildProcess;
  processAliveAtRejection: boolean;
  userDataDirAtRejection: string | undefined;
};

const spawnedChildren: ChildProcess[] = [];

afterAll(() => {
  for (const child of spawnedChildren) {
    if (!hasProcessExited(child)) {
      child.kill("SIGKILL");
    }
  }
});

/** A real, idle, long-lived OS process standing in for the Electron child. */
async function spawnRealChild(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  spawnedChildren.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return child;
}

/** True while the OS still knows this pid — the positive control's evidence. */
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

/**
 * An `ElectronApplication` whose launch genuinely spawns and whose
 * `firstWindow()` genuinely rejects.
 *
 * `close()` resolves WITHOUT killing the child, which is Playwright's documented
 * hazard and the reason `closeElectronApp` exists — so the child only dies if
 * the production kill path actually runs.
 */
function rejectingLauncher(
  observations: LaunchObservation[]
): ElectronLauncher {
  return async (launchOptions) => {
    const child = await spawnRealChild();
    const userDataDir = userDataDirFromArgs(launchOptions?.args);
    return {
      close: async () => {},
      process: () => child,
      firstWindow: () => {
        // Recorded, never asserted here: an assertion inside an injected double
        // is one that can silently never run. The test body asserts these.
        observations.push({
          child,
          processAliveAtRejection: isProcessAlive(child),
          userDataDirAtRejection:
            userDataDir !== undefined && fs.existsSync(userDataDir)
              ? userDataDir
              : undefined,
        });
        return Promise.reject(
          new Error(SEEDED_LAUNCH_FAILURE_MESSAGE, {
            cause: new Error(PLAYWRIGHT_CAUSE_MESSAGE),
          })
        );
      },
    } as ElectronApplication;
  };
}

/**
 * A launcher whose first window resolves — the no-regression control.
 *
 * Records only the child: the failure-path observations do not apply here, and
 * a field named for a rejection that never happened would mislead.
 */
function succeedingLauncher(spawned: ChildProcess[]): ElectronLauncher {
  return async () => {
    const child = await spawnRealChild();
    spawned.push(child);
    return {
      close: async () => {},
      process: () => child,
      firstWindow: async () =>
        ({
          evaluate: async () => undefined,
          on: () => {},
          waitForLoadState: async () => {},
        }) as unknown as Page,
    } as ElectronApplication;
  };
}

/** The profile the launcher actually pointed the app at. */
function userDataDirFromArgs(args: string[] | undefined): string | undefined {
  const flag = args?.find((arg) => arg.startsWith(USER_DATA_DIR_ARG));
  return flag?.slice(USER_DATA_DIR_ARG.length);
}

/**
 * The single launch each case makes.
 *
 * A precondition rather than an assertion: reaching the injected launcher
 * exactly once is what makes the observations below meaningful, and if it did
 * not happen the case has not tested what it claims to.
 */
function onlyObservation(observations: LaunchObservation[]): LaunchObservation {
  const observation = observations[0];
  if (observations.length !== 1 || !observation) {
    throw new Error(
      `the injected launcher should have been reached exactly once, saw ${observations.length}`
    );
  }
  return observation;
}

describe("launchDesktopApp partial launch", () => {
  test("kills the spawned process and removes the temp profile", async () => {
    const observations: LaunchObservation[] = [];

    await assert.rejects(() =>
      launchDesktopApp({
        userDataPrefix: "iss-6929-partial-",
        launchElectron: rejectingLauncher(observations),
      })
    );

    const observed = onlyObservation(observations);
    // Positive control: the launch genuinely succeeded before the induced
    // rejection. Without these two, every assertion below would also hold on a
    // path where nothing was ever spawned and no profile was ever created.
    assert.equal(
      observed.processAliveAtRejection,
      true,
      "no process was alive when firstWindow() rejected — nothing was leaked, so nothing was proven cleaned up"
    );
    assert.ok(
      observed.userDataDirAtRejection,
      "no temp profile existed when firstWindow() rejected"
    );

    // Both leaks in one assertion so a regression reports BOTH, rather than
    // stopping at the process and leaving the profile unexamined.
    assert.deepEqual(
      {
        processExited: hasProcessExited(observed.child),
        profileRemoved: !fs.existsSync(observed.userDataDirAtRejection),
      },
      { processExited: true, profileRemoved: true }
    );
  });

  test("re-throws the launch failure with its message and cause intact", async () => {
    const observations: LaunchObservation[] = [];
    const thrown = await launchDesktopApp({
      userDataPrefix: "iss-6929-diagnosis-",
      launchElectron: rejectingLauncher(observations),
    }).then(
      () => undefined,
      (error: unknown) => error
    );

    onlyObservation(observations);
    assert.ok(thrown instanceof Error);
    assert.equal(thrown.message, SEEDED_LAUNCH_FAILURE_MESSAGE);
    assert.ok(thrown.cause instanceof Error);
    assert.equal(thrown.cause.message, PLAYWRIGHT_CAUSE_MESSAGE);
  });

  test("keeps a caller-owned profile the caller asked to keep", async () => {
    const observations: LaunchObservation[] = [];
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "iss-6929-kept-")
    );

    try {
      await assert.rejects(() =>
        launchDesktopApp({
          userDataDir,
          keepUserDataDir: true,
          launchElectron: rejectingLauncher(observations),
        })
      );

      const observed = onlyObservation(observations);
      assert.equal(observed.processAliveAtRejection, true);
      assert.equal(
        hasProcessExited(observed.child),
        true,
        "the Electron process handle was left open"
      );
      // The dir is the caller's to remove; the teardown must not take a profile
      // the caller declared it owns.
      assert.equal(fs.existsSync(userDataDir), true);
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test("removes the temp profile when the launch itself never resolves", async () => {
    let profileAtLaunch: string | undefined;
    let profileExistedAtLaunch = false;

    await assert.rejects(() =>
      launchDesktopApp({
        userDataPrefix: "iss-6929-launch-fail-",
        beforeLaunch: (dir) => {
          profileAtLaunch = dir;
          profileExistedAtLaunch = fs.existsSync(dir);
        },
        launchElectron: () =>
          Promise.reject(new Error(PLAYWRIGHT_CAUSE_MESSAGE)),
      })
    );

    // Positive control: the profile really was created before the launch was
    // attempted, so its absence below is a removal and not a no-op.
    assert.ok(profileAtLaunch, "no profile was created before the launch");
    assert.equal(profileExistedAtLaunch, true);
    assert.equal(
      fs.existsSync(profileAtLaunch),
      false,
      "a launch that never resolved left its temp profile on disk"
    );
  });

  test("leaves a successful launch running with its profile in place", async () => {
    const spawned: ChildProcess[] = [];

    const launched = await launchDesktopApp({
      launchElectron: succeedingLauncher(spawned),
      // The only case here whose launch RESOLVES, so the only one that would
      // reach the launcher's returning-install seed and reload. This suite's
      // subject is the process and profile lifecycle, and its page and app are
      // stubs with no locators and no main-process `evaluate`, so the case opts
      // out of that step instead of teaching the stubs a renderer.
      keepFirstRunState: true,
      userDataPrefix: "iss-6929-success-",
    });

    try {
      const child = spawned[0];
      assert.equal(spawned.length, 1);
      assert.ok(child);
      // The guard must not fire on the happy path: an over-eager catch would
      // kill the app and delete the profile the caller is about to drive.
      assert.equal(
        hasProcessExited(child),
        false,
        "the teardown ran on a launch that succeeded"
      );
      assert.equal(fs.existsSync(launched.userDataDir), true);
    } finally {
      await launched.cleanup();
    }

    assert.equal(fs.existsSync(launched.userDataDir), false);
  });
});

describe("launchAuthenticatedDesktopApp partial launch", () => {
  test("kills the spawned process and hands back the launch failure", async () => {
    const observations: LaunchObservation[] = [];
    // This launcher never creates the profile — its callers make one and remove
    // it themselves — so the teardown owes the process and nothing else.
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "iss-6929-auth-")
    );

    try {
      const thrown = await launchAuthenticatedDesktopApp({
        userDataDir,
        launchElectron: rejectingLauncher(observations),
      }).then(
        () => undefined,
        (error: unknown) => error
      );

      const observed = onlyObservation(observations);
      assert.equal(
        observed.processAliveAtRejection,
        true,
        "no process was alive when firstWindow() rejected — nothing was leaked, so nothing was proven cleaned up"
      );
      assert.deepEqual(
        {
          processExited: hasProcessExited(observed.child),
          profileKept: fs.existsSync(userDataDir),
        },
        { processExited: true, profileKept: true }
      );
      assert.ok(thrown instanceof Error);
      assert.equal(thrown.message, SEEDED_LAUNCH_FAILURE_MESSAGE);
      assert.ok(thrown.cause instanceof Error);
      assert.equal(thrown.cause.message, PLAYWRIGHT_CAUSE_MESSAGE);
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});

describe("discardPartialLaunch", () => {
  test("reports a failed teardown instead of swallowing it", async () => {
    // The warning IS the contract here: the launch failure is what the caller
    // re-throws, so a teardown that failed has no other way to reach the run log,
    // and a surviving orphan is the one thing a reader needs told.
    const teardownError = new Error("close timed out");
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      // Resolving rather than rejecting is half the contract: the caller's own
      // `throw` must not be replaced by the teardown's failure.
      await discardPartialLaunch(() => Promise.reject(teardownError));
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]?.includes(teardownError));
  });
});
