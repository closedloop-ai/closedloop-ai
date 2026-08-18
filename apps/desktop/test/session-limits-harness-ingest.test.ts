import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ingestHarnessSessionLimits } from "../src/main/session-limits/harness-ingest.js";
import { SessionLimitsSnapshotStore } from "../src/main/session-limits/snapshot-store.js";

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-ingest-test-"));
  tempDirs.push(dir);
  return dir;
}
function writeJsonl(dir: string, lines: unknown[]): void {
  const content = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
  fs.writeFileSync(path.join(dir, "claude-output.jsonl"), content, "utf-8");
}

const NOW = 1_784_646_000_000;

test("ingest: a rejected rate_limit_event flows producer→store→resolver (was null before)", () => {
  const dir = makeTempDir();
  writeJsonl(dir, [
    {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        rateLimitType: "five_hour",
        resetsAt: 1_784_505_600, // epoch seconds
      },
    },
  ]);
  const store = new SessionLimitsSnapshotStore();
  // Before ingest the store is empty → resolver returns null.
  assert.equal(store.resolve(NOW), null);

  ingestHarnessSessionLimits(dir, { store, now: () => NOW });

  const resolved = store.resolve(NOW);
  assert.ok(resolved, "expected a non-null snapshot after ingest");
  assert.equal(resolved.fiveHour?.utilization, 100);
  assert.equal(resolved.fiveHour?.resetsAt, "2026-07-20T00:00:00.000Z");
});

test("ingest: a non-exhausted event records an all-null snapshot (UI stays hidden)", () => {
  const dir = makeTempDir();
  writeJsonl(dir, [
    {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed_warning", utilization: 80 },
    },
  ]);
  const store = new SessionLimitsSnapshotStore();
  ingestHarnessSessionLimits(dir, { store, now: () => NOW });
  // A snapshot is recorded, but with NO drawable window: every rate-limit
  // window is null, so the renderer draws no bars (it hides per-window on null).
  const resolved = store.resolve(NOW);
  assert.ok(resolved, "a fresh coarse sample still resolves to a snapshot");
  assert.equal(resolved.fiveHour, null);
  assert.equal(resolved.sevenDay, null);
  assert.equal(resolved.sevenDayOpus, null);
  assert.equal(resolved.sevenDaySonnet, null);
});

test("ingest: no rate_limit_event → store untouched (no double/spurious record)", () => {
  const dir = makeTempDir();
  writeJsonl(dir, [
    { type: "assistant", message: { model: "claude-opus-4-8", usage: {} } },
  ]);
  const store = new SessionLimitsSnapshotStore();
  ingestHarnessSessionLimits(dir, { store, now: () => NOW });
  assert.equal(store.resolve(NOW), null);
});

test("ingest: only the LATEST event is recorded once per run (no double-count)", () => {
  const dir = makeTempDir();
  let records = 0;
  const store = new SessionLimitsSnapshotStore();
  const spy = new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "record") {
        return (snap: Parameters<typeof store.record>[0]) => {
          records += 1;
          return target.record(snap);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  writeJsonl(dir, [
    { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
    {
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "seven_day" },
    },
  ]);
  ingestHarnessSessionLimits(dir, { store: spy, now: () => NOW });
  // One ingest call records at most one snapshot (the latest usable event).
  assert.equal(records, 1);
  assert.equal(store.resolve(NOW)?.sevenDay?.utilization, 100);
});

test("ingest: missing capture never throws and records nothing (fail-closed)", () => {
  const dir = makeTempDir(); // no claude-output.jsonl written
  const store = new SessionLimitsSnapshotStore();
  assert.doesNotThrow(() =>
    ingestHarnessSessionLimits(dir, { store, now: () => NOW })
  );
  assert.equal(store.resolve(NOW), null);
});

test("ingest: a store.record that throws is swallowed (never breaks finalize)", () => {
  const dir = makeTempDir();
  writeJsonl(dir, [
    { type: "rate_limit_event", rate_limit_info: { status: "rejected" } },
  ]);
  const throwingStore = new SessionLimitsSnapshotStore();
  Object.defineProperty(throwingStore, "record", {
    value: () => {
      throw new Error("store blew up");
    },
  });
  assert.doesNotThrow(() =>
    ingestHarnessSessionLimits(dir, {
      store: throwingStore,
      now: () => NOW,
    })
  );
});

test.after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
