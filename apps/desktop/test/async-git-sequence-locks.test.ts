/**
 * ISS-11414: git and config sequences that ran through `execFileSync` held the
 * Electron main thread for the whole sequence, so no other gateway request
 * could interleave. They now run asynchronously and take an explicit lock
 * instead. This file proves the lock primitive (`withKeyedLock`) and the
 * `repos.json` lock (`withReposConfigLock`): each case queues a competing
 * operation mid-sequence and checks that neither loses the other's work.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";
import { withKeyedLock } from "../src/server/keyed-lock.js";
import {
  addRepo,
  loadReposConfig,
} from "../src/server/operations/repos-config-utils.js";
import { createGitOpTempDirs } from "./helpers/git-gateway-op-harness.js";

const { makeTempDir } = createGitOpTempDirs("async-git-locks-");

describe("withKeyedLock", () => {
  test("a holder can take its own key again without waiting on itself", async () => {
    const locks = new Map<string, Promise<void>>();
    const order: string[] = [];

    await withKeyedLock(locks, "k", async () => {
      order.push("outer");
      await withKeyedLock(locks, "k", () => {
        order.push("inner");
        return Promise.resolve();
      });
    });

    assert.deepEqual(order, ["outer", "inner"]);
    assert.equal(locks.size, 0);
  });

  test("work a holder leaves running queues once the holder has returned", async () => {
    const locks = new Map<string, Promise<void>>();
    const order: string[] = [];
    let leftRunning: Promise<void> | undefined;
    let releaseSecond: () => void = () => undefined;
    const secondHolds = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    await withKeyedLock(locks, "k", () => {
      leftRunning = secondHolds.then(() =>
        withKeyedLock(locks, "k", () => {
          order.push("left-running");
          return Promise.resolve();
        })
      );
      return Promise.resolve();
    });
    const second = withKeyedLock(locks, "k", async () => {
      order.push("second start");
      releaseSecond();
      await new Promise((resolve) => setImmediate(resolve));
      order.push("second end");
    });
    await Promise.all([second, leftRunning]);

    assert.deepEqual(order, ["second start", "second end", "left-running"]);
  });
});

describe("withReposConfigLock", () => {
  test("two repositories added at once are both saved to repos.json", async () => {
    const root = makeTempDir();
    const configDir = path.join(root, "config");
    const first = path.join(root, "repo-a");
    const second = path.join(root, "repo-b");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });

    // `addRepo` awaits deployment detection between reading repos.json and
    // writing it back, so without the lock each save would drop the other's
    // entry.
    const results = await Promise.all([
      addRepo(first, "first", configDir),
      addRepo(second, "second", configDir),
    ]);

    assert.deepEqual(
      results.map((result) => result.success),
      [true, true]
    );
    const saved = await loadReposConfig(configDir);
    assert.deepEqual(saved.repos.map((repo) => repo.path).sort(), [
      first,
      second,
    ]);
  });
});
