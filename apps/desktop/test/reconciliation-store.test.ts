/**
 * @file reconciliation-store.test.ts
 * @description Unit tests for the main-owned reconciliation persistence
 * (FEA-1435/1436), src/main/reconciliation-store.ts.
 *
 * Reviewed invariants: (1) upsert is keyed on (day, vendor, model) so re-running
 * a day REPLACES rather than duplicates; (2) range/vendor queries return the
 * right subset newest-first; (3) retention pruning drops rows older than the
 * window using an injectable clock; (4) corrupt/malformed persisted rows are
 * dropped on load instead of poisoning the data; (5) rows round-trip through the
 * electron-store file. Each test isolates an electron-store in a temp dir.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  type ReconciliationRow,
  ReconciliationStore,
} from "../src/main/reconciliation-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeStore(overrides?: {
  now?: () => Date;
  retentionDays?: number;
  maxEntries?: number;
}): { store: ReconciliationStore; dir: string; name: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recon-store-test-"));
  tempDirs.push(dir);
  const name = "recon-test";
  const store = new ReconciliationStore({
    cwd: dir,
    name,
    now: overrides?.now,
    retentionDays: overrides?.retentionDays,
    maxEntries: overrides?.maxEntries,
  });
  return { store, dir, name };
}

function row(overrides: Partial<ReconciliationRow>): ReconciliationRow {
  return {
    day: "2026-05-20",
    vendor: "anthropic",
    model: "claude-sonnet-4",
    localEstimateMicroCents: 1_000_000,
    vendorBilledMicroCents: 1_050_000,
    driftMicroCents: -50_000,
    driftPct: -4.7619,
    computedAt: "2026-05-21T00:00:00.000Z",
    ...overrides,
  };
}

test("upsert replaces by (day, vendor, model) instead of duplicating", () => {
  const { store } = makeStore({ now: () => new Date("2026-05-28T00:00:00Z") });
  const written = store.upsert([
    row({ model: "claude-sonnet-4", localEstimateMicroCents: 100 }),
    row({ model: "claude-opus-4", localEstimateMicroCents: 200 }),
  ]);
  assert.equal(written, 2);
  assert.equal(store.list().length, 2);

  // Re-run the same day×vendor×model with a new value → one row, updated.
  store.upsert([
    row({ model: "claude-sonnet-4", localEstimateMicroCents: 999 }),
  ]);
  const all = store.list();
  assert.equal(all.length, 2);
  const sonnet = all.find((r) => r.model === "claude-sonnet-4");
  assert.equal(sonnet?.localEstimateMicroCents, 999);

  // Different day → distinct row, not a replacement.
  store.upsert([row({ day: "2026-05-21", model: "claude-sonnet-4" })]);
  assert.equal(store.list().length, 3);
});

test("list filters by day range and vendor, newest day first", () => {
  const { store } = makeStore({ now: () => new Date("2026-05-28T00:00:00Z") });
  store.upsert([
    row({ day: "2026-05-18", vendor: "anthropic" }),
    row({ day: "2026-05-20", vendor: "anthropic" }),
    row({ day: "2026-05-22", vendor: "openai", model: "gpt-5" }),
  ]);

  const inRange = store.list({ from: "2026-05-19", to: "2026-05-21" });
  assert.deepEqual(
    inRange.map((r) => r.day),
    ["2026-05-20"]
  );

  const openaiOnly = store.list({ vendor: "openai" });
  assert.equal(openaiOnly.length, 1);
  assert.equal(openaiOnly[0].vendor, "openai");

  // Default order is newest day first.
  const all = store.list();
  assert.deepEqual(
    all.map((r) => r.day),
    ["2026-05-22", "2026-05-20", "2026-05-18"]
  );
});

test("retention pruning drops rows older than the window", () => {
  // Pin "now" so the cutoff is deterministic: keep the last 7 days.
  const now = () => new Date("2026-05-28T12:00:00Z");
  const { store } = makeStore({ now, retentionDays: 7 });
  store.upsert([
    row({ day: "2026-05-28" }), // today — kept
    row({ day: "2026-05-21" }), // exactly 7 days ago — kept (>= cutoff)
    row({ day: "2026-05-20" }), // 8 days ago — pruned
    row({ day: "2026-05-01" }), // way old — pruned
  ]);
  assert.deepEqual(
    store.list().map((r) => r.day),
    ["2026-05-28", "2026-05-21"]
  );
});

test("corrupt persisted rows are dropped on load; valid rows survive", () => {
  const { dir, name } = makeStore({
    now: () => new Date("2026-05-28T00:00:00Z"),
  });
  // Write a file with a mix of valid and malformed rows directly.
  const file = path.join(dir, `${name}.json`);
  const good = row({ day: "2026-05-25" });
  fs.writeFileSync(
    file,
    JSON.stringify({
      rows: [
        good,
        { day: "not-a-date", vendor: "anthropic", model: "x" }, // bad day
        { ...good, localEstimateMicroCents: 1.5 }, // non-integer money
        { ...good, model: "y", driftPct: "nope" }, // bad driftPct type
        42, // not an object
      ],
    })
  );

  const reopened = new ReconciliationStore({
    cwd: dir,
    name,
    now: () => new Date("2026-05-28T00:00:00Z"),
  });
  const rows = reopened.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].day, "2026-05-25");
  assert.equal(rows[0].localEstimateMicroCents, good.localEstimateMicroCents);
});

test("rows round-trip through the persisted file", () => {
  const { dir, name } = makeStore({
    now: () => new Date("2026-05-28T00:00:00Z"),
  });
  const first = new ReconciliationStore({
    cwd: dir,
    name,
    now: () => new Date("2026-05-28T00:00:00Z"),
  });
  first.upsert([
    row({ day: "2026-05-26", driftPct: null, vendorBilledMicroCents: 0 }),
  ]);

  // A fresh instance reads what the first persisted.
  const second = new ReconciliationStore({
    cwd: dir,
    name,
    now: () => new Date("2026-05-28T00:00:00Z"),
  });
  const rows = second.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].day, "2026-05-26");
  assert.equal(rows[0].driftPct, null);
  assert.equal(rows[0].vendorBilledMicroCents, 0);
});

test("clear empties the store", () => {
  const { store } = makeStore({ now: () => new Date("2026-05-28T00:00:00Z") });
  store.upsert([row({}), row({ model: "claude-opus-4" })]);
  assert.equal(store.list().length, 2);
  store.clear();
  assert.equal(store.list().length, 0);
});
