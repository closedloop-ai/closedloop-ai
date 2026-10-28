import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { test } from "vitest";
import type { MockCloudServer } from "./soak/mock-cloud-server";
import { launchSoakApp } from "./soak/soak-app";
import { type CyclePhases, runCycle } from "./soak/soak-cycle";
import { statsFixture } from "./soak/soak-oracle-test-support";
import type { LaunchedSoakApp, SoakOptions } from "./soak/soak-types";

for (const initialFailure of [true, false]) {
  test(`cycle preserves evidence before removing a profile after ${initialFailure ? "initial launch" : "drain relaunch"} failure`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "soak-cycle-failure-"));
    const userDataDir = path.join(root, "profile");
    fs.mkdirSync(path.join(userDataDir, "logs"), { recursive: true });
    fs.writeFileSync(
      path.join(userDataDir, "logs", "main.log"),
      "failure evidence"
    );
    const dbPath = path.join(userDataDir, "depth-fixture");
    fs.writeFileSync(dbPath, "7");
    const failure = new Error("first window rejected");
    const child = new ChildProcess();
    const failedApp = {
      process: () => child,
      firstWindow: () => Promise.reject(failure),
      close: () => {
        Object.defineProperty(child, "exitCode", { value: 1 });
        child.emit("exit", 1, null);
        child.emit("close", 1, null);
        return Promise.resolve();
      },
    } as unknown as ElectronApplication;
    const failLaunch = () =>
      launchSoakApp(
        userDataDir,
        { apiOrigin: "", relayOrigin: "" },
        {},
        path.join(root, "stdio.log"),
        { launchElectron: () => Promise.resolve(failedApp) }
      );
    const options: SoakOptions = {
      cycles: 1,
      mode: "appkill",
      out: root,
      snapshot: root,
      drainBudgetMs: 1,
      workRoot: root,
      loadGateMax: 25,
    };
    let finalRead = false;
    const phases: CyclePhases = {
      loadGate: () => Promise.resolve(1),
      prepareWorkspace: () =>
        Promise.resolve({
          userDataDir,
          dbPath,
          artifactsDir: root,
          stdioLogPath: path.join(root, "stdio.log"),
          baseline: [],
          localSessionIds: [],
          localSessionsWithEvents: [],
          startDepths: { pending: 7, deadLettered: 0, invocationPending: 0 },
        }),
      launch: () => {
        assert.equal(fs.existsSync(userDataDir), true);
        return initialFailure
          ? failLaunch()
          : Promise.resolve({ oomHits: new Set() } as LaunchedSoakApp);
      },
      drain: async (_context, state) => {
        // runDrainPhase records a relaunch rejection and continues the cycle.
        await assert.rejects(failLaunch(), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.cause, failure);
          state.failReasons.push(`harness_error: ${failure.message}`);
          return true;
        });
      },
      settle: () => Promise.resolve(),
      readFinalDepths: () => {
        finalRead = true;
        return Promise.resolve({
          pending: Number(fs.readFileSync(dbPath, "utf8")),
          deadLettered: 0,
          invocationPending: 0,
        });
      },
      shutdown: () => Promise.resolve(),
      readBack: () => Promise.resolve(null),
    };
    try {
      const cycle = runCycle(
        1,
        options,
        { stats: statsFixture } as MockCloudServer,
        { sessionFile: "", signingKeysFile: "" },
        {},
        phases
      );
      if (initialFailure) {
        await assert.rejects(cycle, (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.cause, failure);
          return true;
        });
        assert.equal(finalRead, false);
      } else {
        const record = await cycle;
        assert.equal(record.outboxEnd, 7);
        assert.equal(finalRead, true);
        assert.ok(
          record.failReasons.includes("harness_error: first window rejected")
        );
      }
      assert.equal(
        fs.readFileSync(path.join(root, "cycle-1-appkill-main.log"), "utf8"),
        "failure evidence"
      );
      assert.equal(fs.existsSync(userDataDir), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
