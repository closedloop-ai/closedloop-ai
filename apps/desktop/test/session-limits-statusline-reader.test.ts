import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SessionLimitsSnapshotStore } from "../src/main/session-limits/snapshot-store.js";
import { createStatuslineReader } from "../src/main/session-limits/statusline-reader.js";
import { deferred } from "./deferred.js";

const tempDirs: string[] = [];
function makeSnapshotFile(contents: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-reader-test-"));
  tempDirs.push(dir);
  const file = path.join(dir, "statusline-snapshot.json");
  if (contents !== null) {
    fs.writeFileSync(file, contents, "utf-8");
  }
  return file;
}
function setMtime(file: string, epochMs: number): void {
  const when = new Date(epochMs);
  fs.utimesSync(file, when, when);
}

const NOW = 1_784_646_000_000;
const CORRUPT_LOG_RE = /corrupt/i;
const silent = () => {
  /* swallow warn logs in tests */
};

test("reader: a valid snapshot file flows file→store→resolver (was null before)", async () => {
  const file = makeSnapshotFile(
    JSON.stringify({
      fiveHour: { utilization: 42, resetsAt: "2026-07-21T15:00:00.000Z" },
      sevenDay: { utilization: 7, resetsAt: null },
      totalCostUsd: 3.2,
      // fresh relative to NOW
      fetchedAt: new Date(NOW - 1000).toISOString(),
    })
  );
  const store = new SessionLimitsSnapshotStore();
  assert.equal(store.resolve(NOW), null);

  const reader = createStatuslineReader({
    snapshotPath: () => file,
    store,
    now: () => NOW,
    log: silent,
  });
  await reader.readOnce();

  const resolved = store.resolve(NOW);
  assert.ok(resolved, "expected a non-null snapshot after reading");
  assert.equal(resolved.fiveHour?.utilization, 42);
  assert.equal(resolved.fiveHour?.resetsAt, "2026-07-21T15:00:00.000Z");
  assert.equal(resolved.sevenDay?.utilization, 7);
});

test("reader: a stale file's fetchedAt ages it out of the store (fail-closed on staleness)", async () => {
  const file = makeSnapshotFile(
    JSON.stringify({
      fiveHour: { utilization: 55, resetsAt: null },
      // 1 hour old → beyond the 15-min staleness window.
      fetchedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    })
  );
  const store = new SessionLimitsSnapshotStore();
  const reader = createStatuslineReader({
    snapshotPath: () => file,
    store,
    now: () => NOW,
    log: silent,
  });
  await reader.readOnce();
  // Recorded, but resolver drops it as stale.
  assert.equal(store.resolve(NOW), null);
});

test("reader: an all-null statusline file is skipped (never suppresses a coarse bar)", async () => {
  // Valid JSON but no usable rate_limits (an older payload / malformed stdin the
  // capture script still turns into fiveHour:null/sevenDay:null).
  const file = makeSnapshotFile(
    JSON.stringify({
      fiveHour: null,
      sevenDay: null,
      totalCostUsd: 1.1,
      fetchedAt: new Date(NOW - 1000).toISOString(),
    })
  );
  const store = new SessionLimitsSnapshotStore();
  // A valid COARSE rejected-event bar is already in the store.
  store.record({
    source: "rate_limit_event",
    fetchedAtMs: NOW - 2000,
    limits: {
      fiveHour: { utilization: 100, resetsAt: "2026-07-21T15:00:00.000Z" },
      sevenDay: null,
      sevenDayOpus: null,
      sevenDaySonnet: null,
      extraUsage: null,
      fetchedAt: new Date(NOW - 2000).toISOString(),
    },
  });

  const reader = createStatuslineReader({
    snapshotPath: () => file,
    store,
    now: () => NOW,
    log: silent,
  });
  await reader.readOnce();

  // The empty statusline snapshot was NOT recorded, so the resolver still
  // surfaces the coarse bar instead of an all-null (hidden) statusline sample.
  const resolved = store.resolve(NOW);
  assert.ok(resolved, "expected the coarse bar to remain visible");
  assert.equal(resolved.fiveHour?.utilization, 100);
});

test("reader: missing file is a no-op (never throws, records nothing)", async () => {
  const file = makeSnapshotFile(null); // file not written
  const store = new SessionLimitsSnapshotStore();
  const reader = createStatuslineReader({
    snapshotPath: () => file,
    store,
    now: () => NOW,
    log: silent,
  });
  await assert.doesNotReject(() => reader.readOnce());
  assert.equal(store.resolve(NOW), null);
});

test("reader: corrupt JSON is ignored (fail-closed)", async () => {
  const file = makeSnapshotFile("{ this is not json ");
  const store = new SessionLimitsSnapshotStore();
  let logged = "";
  const reader = createStatuslineReader({
    snapshotPath: () => file,
    store,
    now: () => NOW,
    log: (m) => {
      logged = m;
    },
  });
  await reader.readOnce();
  assert.equal(store.resolve(NOW), null);
  assert.match(logged, CORRUPT_LOG_RE);
});

test("reader: falls back to file mtime when fetchedAt is invalid", async () => {
  const file = makeSnapshotFile(
    JSON.stringify({
      fiveHour: { utilization: 12, resetsAt: null },
      fetchedAt: "not-a-date",
    })
  );
  // Pin mtime fresh relative to the mocked NOW so the mtime fallback resolves.
  setMtime(file, NOW - 1000);
  const store = new SessionLimitsSnapshotStore();
  const reader = createStatuslineReader({
    snapshotPath: () => file,
    store,
    now: () => NOW,
    log: silent,
  });
  await reader.readOnce();
  // mtime is ~now (just written), so it resolves fresh.
  const resolved = store.resolve(NOW);
  assert.ok(resolved, "expected mtime-fresh fallback to resolve");
  assert.equal(resolved.fiveHour?.utilization, 12);
});

test("reader: start()/stop() are idempotent and read once immediately", async () => {
  const file = makeSnapshotFile(
    JSON.stringify({
      fiveHour: { utilization: 33, resetsAt: null },
      fetchedAt: new Date(NOW - 1000).toISOString(),
    })
  );
  const store = new SessionLimitsSnapshotStore();
  // `record` is the reader's real completion signal — await it instead of a
  // fixed sleep, which raced the fs read on a loaded runner (FEA-2399).
  const recorded = deferred();
  const recordSnapshot = store.record.bind(store);
  store.record = (snapshot) => {
    recordSnapshot(snapshot);
    recorded.resolve();
  };
  // `snapshotPath` is invoked synchronously at the top of every read, so this
  // counter proves the second start() did not schedule a second read.
  let reads = 0;
  const reader = createStatuslineReader({
    snapshotPath: () => {
      reads += 1;
      return file;
    },
    store,
    now: () => NOW,
    pollMs: 60 * 60 * 1000,
    log: silent,
  });
  reader.start();
  reader.start(); // idempotent
  assert.equal(reads, 1, "expected start() to read exactly once");
  await recorded.promise;
  reader.stop();
  reader.stop(); // idempotent
  assert.equal(store.resolve(NOW)?.fiveHour?.utilization, 33);
});

test.after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
