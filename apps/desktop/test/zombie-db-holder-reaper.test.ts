/**
 * @file zombie-db-holder-reaper.test.ts
 * @description FEA-3625 — startup auto-cleanup of zombie/suspended Electron
 * processes holding the desktop SQLite DB (`agent-dashboard.sqlite`) open.
 *
 * The reaper must be SURGICAL: it may only kill a DIFFERENT process, in a
 * non-runnable state (`T` suspended / `Z` zombie), whose command line is one of
 * THIS app's own — never a live/running instance, never itself, never an
 * unrelated program that happens to hold the file open. These tests pin exactly
 * that scoping (which is the whole safety story), plus the boot-resilience
 * contract that the reaper never throws even when the OS primitives fail.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type DbHolder,
  isClosedloopDesktopCommand,
  isReapableHolder,
  makeOwnProcessMatcher,
  reapZombieDatabaseHolders,
  selectZombieDbHolders,
} from "../src/main/database/database-integrity/zombie-db-holder-reaper.js";

const OWN = "/Applications/Closedloop.app/Contents/MacOS/Closedloop";
const OWN_DB_HOST =
  "/Applications/Closedloop.app/Contents/MacOS/Closedloop --type=utility closedloop-db-host";
const UNRELATED = "/usr/bin/some-backup-tool --watch";
const isOwn = isClosedloopDesktopCommand;

// ---------------------------------------------------------------------------
// isClosedloopDesktopCommand — own-process scoping
// ---------------------------------------------------------------------------

test("isClosedloopDesktopCommand matches our app + db-host, not unrelated programs", () => {
  assert.equal(isClosedloopDesktopCommand(OWN), true);
  assert.equal(isClosedloopDesktopCommand(OWN_DB_HOST), true);
  assert.equal(
    isClosedloopDesktopCommand("node foo agent-dashboard.sqlite"),
    true
  );
  // Dev-mode db-host utilityProcess: Electron binary under node_modules with no
  // product name in the path, but the worker entry is db-host-worker.js.
  assert.equal(
    isClosedloopDesktopCommand(
      "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --type=utility /repo/apps/desktop/dist/main/database/db-host/db-host-worker.js"
    ),
    true,
    "dev-mode db-host-worker is recognized"
  );
  assert.equal(
    isClosedloopDesktopCommand("CLOSEDLOOP"),
    true,
    "case-insensitive"
  );
  assert.equal(isClosedloopDesktopCommand(UNRELATED), false);
  assert.equal(isClosedloopDesktopCommand(""), false);
});

test("makeOwnProcessMatcher additionally scopes to the DB directory (dev bare-Electron holder)", () => {
  const matcher = makeOwnProcessMatcher(
    "/Users/me/Library/Application Support/Closedloop/agent-dashboard.sqlite"
  );
  // A dev holder whose executable path has no product name still matches because
  // its command references our exact userData directory.
  assert.equal(
    matcher(
      "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --user-data-dir=/Users/me/Library/Application Support/Closedloop"
    ),
    true
  );
  // Product-name / db-host-worker signals still work.
  assert.equal(matcher(OWN), true);
  // A truly unrelated program in an unrelated directory does not match.
  assert.equal(matcher(UNRELATED), false);
});

// ---------------------------------------------------------------------------
// isReapableHolder — the core safety predicate
// ---------------------------------------------------------------------------

test("suspended (T) own-holder is reapable", () => {
  const h: DbHolder = { pid: 111, stat: "T", command: OWN };
  assert.equal(isReapableHolder(h, 999, isOwn), true);
});

test("zombie (Z) own-holder is reapable", () => {
  const h: DbHolder = { pid: 222, stat: "Z", command: OWN_DB_HOST };
  assert.equal(isReapableHolder(h, 999, isOwn), true);
});

test("running (R/S) own-holder is NOT reapable — a live instance is left alone", () => {
  assert.equal(
    isReapableHolder({ pid: 333, stat: "R", command: OWN }, 999, isOwn),
    false
  );
  assert.equal(
    isReapableHolder({ pid: 334, stat: "S", command: OWN }, 999, isOwn),
    false
  );
  // Real macOS composite stat like "T+" (suspended, foreground) still reaps;
  // "S+" (sleeping, foreground) does not.
  assert.equal(
    isReapableHolder({ pid: 335, stat: "S+", command: OWN }, 999, isOwn),
    false
  );
  assert.equal(
    isReapableHolder({ pid: 336, stat: "T+", command: OWN }, 999, isOwn),
    true
  );
});

test("the current process is NEVER reapable, even when suspended + own", () => {
  const h: DbHolder = { pid: 500, stat: "T", command: OWN };
  assert.equal(isReapableHolder(h, 500, isOwn), false);
});

test("an unrelated suspended program holding the DB is NEVER reapable (no broad kill)", () => {
  const h: DbHolder = { pid: 600, stat: "T", command: UNRELATED };
  assert.equal(isReapableHolder(h, 999, isOwn), false);
});

test("non-positive / non-integer pids are rejected", () => {
  assert.equal(
    isReapableHolder({ pid: 0, stat: "T", command: OWN }, 999, isOwn),
    false
  );
  assert.equal(
    isReapableHolder({ pid: -1, stat: "T", command: OWN }, 999, isOwn),
    false
  );
});

// ---------------------------------------------------------------------------
// selectZombieDbHolders — pure selection, sorted + deduped
// ---------------------------------------------------------------------------

test("selectZombieDbHolders returns only suspended/zombie own-holders, sorted + unique", () => {
  const holders: DbHolder[] = [
    { pid: 300, stat: "R", command: OWN }, // running → skip
    { pid: 100, stat: "T", command: OWN }, // suspended own → reap
    { pid: 200, stat: "Z", command: OWN_DB_HOST }, // zombie own → reap
    { pid: 100, stat: "T", command: OWN_DB_HOST }, // dup pid (wal+shm) → deduped
    { pid: 400, stat: "T", command: UNRELATED }, // unrelated → skip
    { pid: 999, stat: "T", command: OWN }, // self → skip
  ];
  assert.deepEqual(selectZombieDbHolders(holders, 999, isOwn), [100, 200]);
});

// ---------------------------------------------------------------------------
// reapZombieDatabaseHolders — async orchestration with injected primitives
// ---------------------------------------------------------------------------

function makeDeps(
  overrides: Partial<Parameters<typeof reapZombieDatabaseHolders>[1]>
): Parameters<typeof reapZombieDatabaseHolders>[1] {
  return {
    listHolderPids: () => Promise.resolve([]),
    describeProcess: () => Promise.resolve(null),
    killProcess: () => Promise.resolve(true),
    currentPid: 999,
    ...overrides,
  };
}

test("looks up the DB file plus its -wal and -shm sidecars", async () => {
  let queried: string[] = [];
  await reapZombieDatabaseHolders("/data/agent-dashboard.sqlite", {
    ...makeDeps({}),
    listHolderPids: (paths) => {
      queried = paths;
      return Promise.resolve([]);
    },
  });
  assert.deepEqual(queried, [
    "/data/agent-dashboard.sqlite",
    "/data/agent-dashboard.sqlite-wal",
    "/data/agent-dashboard.sqlite-shm",
  ]);
});

test("reaps a suspended own-holder and reports it", async () => {
  const killed: number[] = [];
  const result = await reapZombieDatabaseHolders("/db.sqlite", {
    ...makeDeps({}),
    listHolderPids: () => Promise.resolve([111]),
    describeProcess: (pid) =>
      Promise.resolve(pid === 111 ? { stat: "T", command: OWN } : null),
    killProcess: (pid) => {
      killed.push(pid);
      return Promise.resolve(true);
    },
  });
  assert.deepEqual(killed, [111]);
  assert.deepEqual(result.reaped, [111]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.skippedRunning, []);
});

test("does NOT kill a live/running own-holder — reports it as skippedRunning", async () => {
  const killed: number[] = [];
  const result = await reapZombieDatabaseHolders("/db.sqlite", {
    ...makeDeps({}),
    listHolderPids: () => Promise.resolve([222]),
    describeProcess: () => Promise.resolve({ stat: "S", command: OWN }),
    killProcess: (pid) => {
      killed.push(pid);
      return Promise.resolve(true);
    },
  });
  assert.deepEqual(killed, [], "a running instance must never be killed");
  assert.deepEqual(result.reaped, []);
  assert.deepEqual(result.skippedRunning, [222]);
});

test("does NOT kill an unrelated suspended holder of the same file", async () => {
  const killed: number[] = [];
  const result = await reapZombieDatabaseHolders("/db.sqlite", {
    ...makeDeps({}),
    listHolderPids: () => Promise.resolve([333]),
    describeProcess: () => Promise.resolve({ stat: "T", command: UNRELATED }),
    killProcess: (pid) => {
      killed.push(pid);
      return Promise.resolve(true);
    },
  });
  assert.deepEqual(killed, []);
  assert.deepEqual(result.reaped, []);
  assert.deepEqual(result.skippedRunning, []);
});

test("excludes the current pid even if lsof lists it", async () => {
  const killed: number[] = [];
  await reapZombieDatabaseHolders("/db.sqlite", {
    ...makeDeps({}),
    currentPid: 42,
    listHolderPids: () => Promise.resolve([42]),
    describeProcess: () => Promise.resolve({ stat: "T", command: OWN }),
    killProcess: (pid) => {
      killed.push(pid);
      return Promise.resolve(true);
    },
  });
  assert.deepEqual(killed, [], "must never target its own pid");
});

test("a process that exits between lsof and ps (null describe) is skipped", async () => {
  const result = await reapZombieDatabaseHolders("/db.sqlite", {
    ...makeDeps({}),
    listHolderPids: () => Promise.resolve([444]),
    describeProcess: () => Promise.resolve(null),
  });
  assert.deepEqual(result.reaped, []);
  assert.deepEqual(result.failed, []);
});

test("a failed kill is reported in `failed`, not `reaped`", async () => {
  const result = await reapZombieDatabaseHolders("/db.sqlite", {
    ...makeDeps({}),
    listHolderPids: () => Promise.resolve([555]),
    describeProcess: () => Promise.resolve({ stat: "T", command: OWN }),
    killProcess: () => Promise.resolve(false),
  });
  assert.deepEqual(result.reaped, []);
  assert.deepEqual(result.failed, [555]);
});

test("never throws when the holder lookup fails (unsupported platform / no lsof)", async () => {
  const logs: string[] = [];
  const result = await reapZombieDatabaseHolders("/db.sqlite", {
    ...makeDeps({}),
    listHolderPids: () => Promise.reject(new Error("lsof: command not found")),
    log: (m) => logs.push(m),
  });
  assert.deepEqual(result, { reaped: [], failed: [], skippedRunning: [] });
  assert.ok(
    logs.some((l) => l.includes("holder lookup failed")),
    "logs the skipped-cleanup reason"
  );
});

test("absorbs a per-pid describe error and continues with the rest", async () => {
  const killed: number[] = [];
  const result = await reapZombieDatabaseHolders("/db.sqlite", {
    ...makeDeps({}),
    listHolderPids: () => Promise.resolve([1, 2]),
    describeProcess: (pid) =>
      pid === 1
        ? Promise.reject(new Error("ps blew up"))
        : Promise.resolve({ stat: "T", command: OWN }),
    killProcess: (pid) => {
      killed.push(pid);
      return Promise.resolve(true);
    },
  });
  assert.deepEqual(
    killed,
    [2],
    "pid 1's describe error is absorbed; pid 2 reaped"
  );
  assert.deepEqual(result.reaped, [2]);
});

test("absorbs a thrown kill and records the pid as failed", async () => {
  const result = await reapZombieDatabaseHolders("/db.sqlite", {
    ...makeDeps({}),
    listHolderPids: () => Promise.resolve([777]),
    describeProcess: () => Promise.resolve({ stat: "T", command: OWN }),
    killProcess: () => Promise.reject(new Error("EPERM")),
  });
  assert.deepEqual(result.reaped, []);
  assert.deepEqual(result.failed, [777]);
});

test("no holders → clean empty result, no describe/kill calls", async () => {
  let describeCalls = 0;
  const result = await reapZombieDatabaseHolders("/db.sqlite", {
    ...makeDeps({}),
    listHolderPids: () => Promise.resolve([]),
    describeProcess: () => {
      describeCalls++;
      return Promise.resolve(null);
    },
  });
  assert.equal(describeCalls, 0);
  assert.deepEqual(result, { reaped: [], failed: [], skippedRunning: [] });
});

// ---------------------------------------------------------------------------
// post-reap settle: wait for the kernel to release the lock before returning
// ---------------------------------------------------------------------------

test("after a reap, polls until the reaped pid is gone before resolving", async () => {
  const delays: number[] = [];
  // pid 111 is still visible for the first two describe polls, then gone.
  let describeCount = 0;
  const result = await reapZombieDatabaseHolders("/db.sqlite", {
    ...makeDeps({}),
    listHolderPids: () => Promise.resolve([111]),
    describeProcess: () => {
      // The first describe is the pre-kill classify (pid still up). Subsequent
      // describes are the settle poll: alive for a few polls, then gone.
      describeCount++;
      return Promise.resolve(
        describeCount <= 3 ? { stat: "T", command: OWN } : null
      );
    },
    killProcess: () => Promise.resolve(true),
    delay: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  });
  assert.deepEqual(result.reaped, [111]);
  assert.ok(delays.length >= 1, "waited at least once for the lock to release");
});

test("settle wait is bounded — gives up after the budget and still resolves", async () => {
  let delayCount = 0;
  const result = await reapZombieDatabaseHolders("/db.sqlite", {
    ...makeDeps({}),
    listHolderPids: () => Promise.resolve([222]),
    // Always visible: the reaped pid never disappears (kernel wedged).
    describeProcess: () => Promise.resolve({ stat: "T", command: OWN }),
    killProcess: () => Promise.resolve(true),
    delay: () => {
      delayCount++;
      return Promise.resolve();
    },
  });
  assert.deepEqual(result.reaped, [222]);
  // 2000ms budget / 100ms step → ~20 waits, then gives up (never infinite).
  assert.ok(delayCount > 0 && delayCount <= 20, `bounded waits: ${delayCount}`);
});

test("no settle wait when delay dep is omitted (skips the poll)", async () => {
  let describeCount = 0;
  const result = await reapZombieDatabaseHolders("/db.sqlite", {
    ...makeDeps({}),
    listHolderPids: () => Promise.resolve([333]),
    describeProcess: () => {
      describeCount++;
      return Promise.resolve({ stat: "T", command: OWN });
    },
    killProcess: () => Promise.resolve(true),
    // no delay dep
  });
  assert.deepEqual(result.reaped, [333]);
  // Exactly one describe (the pre-kill classify) — no settle polling without delay.
  assert.equal(describeCount, 1);
});
