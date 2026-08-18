import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { ElectronApplication } from "@playwright/test";
import { closeElectronApp } from "./e2e/helpers/desktop-app";

// `ChildProcess` declares `exitCode`/`signalCode` readonly — the real ones are
// owned by Node and only move when the process actually exits. This fake drives
// them by hand, so it needs its own mutable view of those two fields rather than
// pretending to be a `ChildProcess` and then writing through the readonly names.
type FakeChildProcess = EventEmitter &
  Pick<ChildProcess, "kill"> & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };

test("kills a live Electron child after Playwright close resolves", async () => {
  const child = new EventEmitter() as FakeChildProcess;
  child.exitCode = null;
  child.signalCode = null;
  let killSignal: NodeJS.Signals | number | undefined;
  child.kill = (signal) => {
    killSignal = signal;
    child.signalCode = "SIGKILL";
    child.emit("exit", null, "SIGKILL");
    return true;
  };
  const app = {
    close: async () => {},
    process: () => child,
  } as ElectronApplication;

  await closeElectronApp(app);

  assert.equal(killSignal, "SIGKILL");
});
