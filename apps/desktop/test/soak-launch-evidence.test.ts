import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ElectronApplication } from "@playwright/test";
import { test } from "vitest";
import { launchSoakApp } from "./soak/soak-app";

test("first-window cleanup records bytes delivered after exit and before close", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "soak-late-stdio-"));
  const profile = path.join(root, "profile");
  fs.mkdirSync(profile);
  const logPath = path.join(root, "stdio.log");
  const child = new ChildProcess();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const failure = new Error("first window rejected");
  let exitedBeforeTail = false;
  const app = {
    process: () => child,
    firstWindow: () => Promise.reject(failure),
    close: () => {
      Object.defineProperty(child, "exitCode", { value: 1 });
      child.emit("exit", 1, null);
      setImmediate(() => {
        exitedBeforeTail = child.exitCode === 1;
        child.stdout?.emit("data", Buffer.from("Reached heap limit"));
        child.stderr?.emit("data", Buffer.from("FATAL ERROR"));
        child.emit("close", 1, null);
      });
      return Promise.resolve();
    },
  } as unknown as ElectronApplication;
  try {
    await assert.rejects(
      launchSoakApp(profile, { apiOrigin: "", relayOrigin: "" }, {}, logPath, {
        launchElectron: () => Promise.resolve(app),
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.cause, failure);
        assert.ok(error.message.includes("Reached heap limit"));
        assert.ok(error.message.includes("FATAL ERROR"));
        return true;
      }
    );
    assert.equal(exitedBeforeTail, true);
    assert.equal(
      fs.readFileSync(logPath, "utf8"),
      "Reached heap limitFATAL ERROR"
    );
    assert.equal(child.stdout.listenerCount("data"), 0);
    assert.equal(child.stderr.listenerCount("data"), 0);
    assert.equal(fs.existsSync(profile), true);
  } finally {
    child.stdout.destroy();
    child.stderr.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
