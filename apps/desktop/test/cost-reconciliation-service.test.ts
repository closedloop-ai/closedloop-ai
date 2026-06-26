/**
 * @file cost-reconciliation-service.test.ts
 * @description Unit tests for the production wiring of nightly cost
 * reconciliation (FEA-1435/1436), src/main/cost-reconciliation-service.ts.
 *
 * Reviewed invariants:
 *   (1) getAdminKeyStatuses exposes ONLY existence (vendor + hasKey), never the
 *       key material, for both vendors; set/clear round-trip through the stores;
 *   (2) a run reconciles each configured vendor in its OWN worker pass, wired
 *       with only that vendor's fetch function, summing rowsWritten and notices;
 *   (3) per-vendor isolation: one vendor throwing (bad key / 401 / network) is
 *       recorded as that vendor's error and does NOT abort the other vendor's
 *       pass — the healthy vendor still reconciles;
 *   (4) a vendor with no configured key is never queried (no client built, no
 *       false $0 bill); with no keys at all the run is a no-op (computedAt null);
 *   (5) the metered usage rows are loaded exactly ONCE per run and reused across
 *       vendor passes;
 *   (6) a manual run that races an in-flight run is a no-op (skippedBusy);
 *   (7) start() schedules an initial delayed run plus the nightly interval via
 *       the injected timer seams, a scheduled tick with no keys does nothing, and
 *       stop() clears both timers.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { VendorBilledEntry } from "../src/main/admin-billing.js";
import type { AdminKeyVendor } from "../src/main/admin-key-store.js";
import {
  type AdminKeyStoreLike,
  type AnthropicCostClient,
  CostReconciliationService,
  INITIAL_RECONCILIATION_DELAY_MS,
  type OpenAiCostClient,
  RECONCILIATION_INTERVAL_MS,
} from "../src/main/cost-reconciliation-service.js";
import type { ReconciliationRow } from "../src/main/reconciliation-store.js";
import type { MeteredUsageRow } from "../src/main/reconciliation-worker.js";

const FIXED_NOW = () => new Date("2026-05-28T00:00:00Z");

/** An in-memory Admin key store fake (mirrors AdminKeyStore's contract). */
function makeKeyStore(
  vendor: AdminKeyVendor,
  initialKey: string | null = null
): AdminKeyStoreLike {
  let key = initialKey;
  return {
    getKey: () => key,
    getStatus: () => ({ vendor, hasKey: key !== null }),
    setKey: (k: string) => {
      if (k.trim().length === 0) {
        throw new Error("Admin API key must not be empty");
      }
      key = k;
    },
    clearKey: () => {
      key = null;
    },
  };
}

/** A reconciliation store fake that records upsert/list calls. */
function makeStore(): {
  store: {
    upsert: (rows: readonly ReconciliationRow[]) => number;
    list: () => ReconciliationRow[];
  };
  rows: ReconciliationRow[];
  upsertCalls: number;
} {
  const rows: ReconciliationRow[] = [];
  const state = { upsertCalls: 0 };
  return {
    rows,
    get upsertCalls() {
      return state.upsertCalls;
    },
    store: {
      upsert(incoming: readonly ReconciliationRow[]): number {
        state.upsertCalls += 1;
        rows.push(...incoming);
        return incoming.length;
      },
      list(): ReconciliationRow[] {
        return rows;
      },
    },
  };
}

function makeUsage(partial: Partial<MeteredUsageRow>): MeteredUsageRow {
  return {
    sessionId: "s1",
    model: "claude-opus-4-5",
    startedAt: "2026-05-20T10:00:00Z",
    billingMode: "api",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...partial,
  };
}

/** A controllable Anthropic client; records queries, returns the given entries. */
function makeAnthropicClient(
  entries: VendorBilledEntry[]
): AnthropicCostClient & {
  calls: Array<{ startingAt: string; endingAt: string }>;
} {
  const calls: Array<{ startingAt: string; endingAt: string }> = [];
  return {
    calls,
    fetchCostReport: async (query) => {
      calls.push(query);
      return entries;
    },
  };
}

function makeOpenAiClient(
  entries: VendorBilledEntry[]
): OpenAiCostClient & { calls: Array<{ startTime: number; endTime: number }> } {
  const calls: Array<{ startTime: number; endTime: number }> = [];
  return {
    calls,
    fetchCosts: async (query) => {
      calls.push(query);
      return entries;
    },
  };
}

test("getAdminKeyStatuses reports existence only for both vendors", () => {
  const service = new CostReconciliationService({
    anthropicKeyStore: makeKeyStore("anthropic", "sk-ant-admin-xxx"),
    openaiKeyStore: makeKeyStore("openai"),
    store: makeStore().store,
    loadUsageRows: () => [],
    now: FIXED_NOW,
  });

  const statuses = service.getAdminKeyStatuses();
  assert.deepEqual(statuses.anthropic, { vendor: "anthropic", hasKey: true });
  assert.deepEqual(statuses.openai, { vendor: "openai", hasKey: false });
  // The status objects carry no key material.
  assert.deepEqual(Object.keys(statuses.anthropic).sort(), [
    "hasKey",
    "vendor",
  ]);
});

test("setAdminKey and clearAdminKey round-trip through the store", () => {
  const openaiStore = makeKeyStore("openai");
  const service = new CostReconciliationService({
    anthropicKeyStore: makeKeyStore("anthropic"),
    openaiKeyStore: openaiStore,
    store: makeStore().store,
    loadUsageRows: () => [],
    now: FIXED_NOW,
  });

  let statuses = service.setAdminKey("openai", "sk-admin-yyy");
  assert.equal(statuses.openai.hasKey, true);
  assert.equal(openaiStore.getKey(), "sk-admin-yyy");

  statuses = service.clearAdminKey("openai");
  assert.equal(statuses.openai.hasKey, false);
  assert.equal(openaiStore.getKey(), null);

  assert.throws(
    () => service.setAdminKey("openai", "   "),
    /must not be empty/
  );
});

test("reconciles each configured vendor in its own pass, summing results", async () => {
  const usageRows = [
    makeUsage({
      sessionId: "a1",
      model: "claude-opus-4-5",
      inputTokens: 10_000,
      outputTokens: 2000,
    }),
    makeUsage({
      sessionId: "o1",
      model: "gpt-4.1",
      inputTokens: 8000,
      outputTokens: 1000,
    }),
  ];
  const store = makeStore();
  const anthropic = makeAnthropicClient([
    {
      day: "2026-05-20",
      model: "claude-opus-4-5",
      amountMicroCents: 5_000_000,
      label: null,
    },
  ]);
  const openai = makeOpenAiClient([
    {
      day: "2026-05-20",
      model: null,
      amountMicroCents: 3_000_000,
      label: null,
    },
  ]);

  const service = new CostReconciliationService({
    anthropicKeyStore: makeKeyStore("anthropic", "sk-ant-admin"),
    openaiKeyStore: makeKeyStore("openai", "sk-admin"),
    store: store.store,
    loadUsageRows: () => usageRows,
    createAnthropicClient: () => anthropic,
    createOpenAiClient: () => openai,
    now: FIXED_NOW,
  });

  const summary = await service.runReconciliationNow();

  assert.equal(summary.skippedBusy, false);
  assert.equal(summary.errors.length, 0);
  assert.deepEqual(summary.vendorsReconciled.sort(), ["anthropic", "openai"]);
  // Both vendors' billing APIs were actually called (usage window existed), so
  // both keys are genuinely verified.
  assert.deepEqual([...summary.vendorsQueried].sort(), ["anthropic", "openai"]);
  // One reconciliation row per vendor (one day, one cell each).
  assert.equal(summary.rowsWritten, 2);
  assert.equal(summary.computedAt, FIXED_NOW().toISOString());
  // Each vendor was queried over the local window derived from the usage rows.
  assert.equal(anthropic.calls.length, 1);
  assert.equal(anthropic.calls[0].startingAt, "2026-05-20T00:00:00Z");
  assert.equal(openai.calls.length, 1);
  assert.equal(
    openai.calls[0].startTime,
    Math.floor(Date.parse("2026-05-20T00:00:00Z") / 1000)
  );
});

test("one vendor failing does not abort the other (per-vendor isolation)", async () => {
  const usageRows = [
    makeUsage({
      sessionId: "a1",
      model: "claude-opus-4-5",
      inputTokens: 10_000,
      outputTokens: 2000,
    }),
    makeUsage({
      sessionId: "o1",
      model: "gpt-4.1",
      inputTokens: 8000,
      outputTokens: 1000,
    }),
  ];
  const store = makeStore();
  const openai = makeOpenAiClient([
    {
      day: "2026-05-20",
      model: null,
      amountMicroCents: 3_000_000,
      label: null,
    },
  ]);

  const service = new CostReconciliationService({
    anthropicKeyStore: makeKeyStore("anthropic", "sk-ant-admin-bad"),
    openaiKeyStore: makeKeyStore("openai", "sk-admin"),
    store: store.store,
    loadUsageRows: () => usageRows,
    createAnthropicClient: () => ({
      fetchCostReport: async () => {
        throw new Error("Anthropic admin API HTTP 401: invalid x-api-key");
      },
    }),
    createOpenAiClient: () => openai,
    now: FIXED_NOW,
  });

  const summary = await service.runReconciliationNow();

  assert.deepEqual(summary.vendorsReconciled, ["openai"]);
  assert.equal(summary.errors.length, 1);
  assert.equal(summary.errors[0].vendor, "anthropic");
  assert.match(summary.errors[0].message, /HTTP 401/);
  // The Admin key the service holds must never surface in the IPC-visible
  // summary (the real client redacts upstream in requestAdminJson; the service
  // must not reintroduce it). Guards the renderer-visible error path.
  assert.ok(
    !summary.errors[0].message.includes("sk-ant-admin-bad"),
    "summary error must not contain the Admin key"
  );
  // The healthy vendor still produced a row.
  assert.equal(summary.rowsWritten, 1);
});

test("a vendor with no key is never queried and no client is built", async () => {
  const usageRows = [
    makeUsage({
      sessionId: "a1",
      model: "claude-opus-4-5",
      inputTokens: 10_000,
      outputTokens: 2000,
    }),
  ];
  const store = makeStore();
  const anthropic = makeAnthropicClient([
    {
      day: "2026-05-20",
      model: "claude-opus-4-5",
      amountMicroCents: 5_000_000,
      label: null,
    },
  ]);
  let openAiBuilt = false;

  const service = new CostReconciliationService({
    anthropicKeyStore: makeKeyStore("anthropic", "sk-ant-admin"),
    openaiKeyStore: makeKeyStore("openai"), // no key
    store: store.store,
    loadUsageRows: () => usageRows,
    createAnthropicClient: () => anthropic,
    createOpenAiClient: () => {
      openAiBuilt = true;
      return makeOpenAiClient([]);
    },
    now: FIXED_NOW,
  });

  const summary = await service.runReconciliationNow();

  assert.deepEqual(summary.vendorsReconciled, ["anthropic"]);
  assert.equal(
    openAiBuilt,
    false,
    "OpenAI client must not be built without a key"
  );
});

test("with no keys configured a run is a no-op", async () => {
  const store = makeStore();
  let loaded = 0;
  const service = new CostReconciliationService({
    anthropicKeyStore: makeKeyStore("anthropic"),
    openaiKeyStore: makeKeyStore("openai"),
    store: store.store,
    loadUsageRows: () => {
      loaded += 1;
      return [];
    },
    now: FIXED_NOW,
  });

  const summary = await service.runReconciliationNow();

  assert.deepEqual(summary.vendorsReconciled, []);
  assert.equal(summary.rowsWritten, 0);
  assert.equal(summary.computedAt, null);
  assert.equal(
    loaded,
    0,
    "usage must not be loaded when there is nothing to reconcile"
  );
});

test("a key configured but no local usage: pass completes but no vendor is queried", async () => {
  // The fresh-install case: the user saves an Admin key before any metered
  // session exists. The pass completes without error, but with no usage window
  // the vendor API is never called — so vendorsQueried is empty and the UI must
  // NOT claim the key was "verified".
  const store = makeStore();
  const anthropic = makeAnthropicClient([
    {
      day: "2026-05-20",
      model: "claude-opus-4-5",
      amountMicroCents: 5_000_000,
      label: null,
    },
  ]);
  const service = new CostReconciliationService({
    anthropicKeyStore: makeKeyStore("anthropic", "sk-ant-admin"),
    openaiKeyStore: makeKeyStore("openai"),
    store: store.store,
    loadUsageRows: () => [], // no metered usage yet
    createAnthropicClient: () => anthropic,
    now: FIXED_NOW,
  });

  const summary = await service.runReconciliationNow();

  // The pass ran without error (so it is "reconciled")...
  assert.deepEqual(summary.vendorsReconciled, ["anthropic"]);
  // ...but no vendor request was made, so nothing was actually verified.
  assert.deepEqual(summary.vendorsQueried, []);
  assert.equal(
    anthropic.calls.length,
    0,
    "no usage window → vendor API not called"
  );
  assert.equal(summary.errors.length, 0);
  assert.equal(summary.rowsWritten, 0);
});

test("usage rows are loaded exactly once per run across vendor passes", async () => {
  const usageRows = [
    makeUsage({
      sessionId: "a1",
      model: "claude-opus-4-5",
      inputTokens: 10_000,
      outputTokens: 2000,
    }),
    makeUsage({
      sessionId: "o1",
      model: "gpt-4.1",
      inputTokens: 8000,
      outputTokens: 1000,
    }),
  ];
  let loaded = 0;
  const service = new CostReconciliationService({
    anthropicKeyStore: makeKeyStore("anthropic", "sk-ant-admin"),
    openaiKeyStore: makeKeyStore("openai", "sk-admin"),
    store: makeStore().store,
    loadUsageRows: () => {
      loaded += 1;
      return usageRows;
    },
    createAnthropicClient: () => makeAnthropicClient([]),
    createOpenAiClient: () => makeOpenAiClient([]),
    now: FIXED_NOW,
  });

  await service.runReconciliationNow();
  assert.equal(loaded, 1);
});

test("listRows delegates to the store", () => {
  const store = makeStore();
  store.rows.push({
    day: "2026-05-20",
    vendor: "anthropic",
    model: "claude-opus-4-5",
    localEstimateMicroCents: 100,
    vendorBilledMicroCents: 90,
    driftMicroCents: 10,
    driftPct: 11.11,
    computedAt: "2026-05-28T00:00:00.000Z",
  });
  const service = new CostReconciliationService({
    anthropicKeyStore: makeKeyStore("anthropic"),
    openaiKeyStore: makeKeyStore("openai"),
    store: store.store,
    loadUsageRows: () => [],
    now: FIXED_NOW,
  });

  assert.equal(service.listRows().length, 1);
});

test("a manual run that races an in-flight run is a no-op (skippedBusy)", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new CostReconciliationService({
    anthropicKeyStore: makeKeyStore("anthropic", "sk-ant-admin"),
    openaiKeyStore: makeKeyStore("openai"),
    store: makeStore().store,
    loadUsageRows: () => [
      makeUsage({
        sessionId: "a1",
        model: "claude-opus-4-5",
        inputTokens: 10_000,
        outputTokens: 2000,
      }),
    ],
    createAnthropicClient: () => ({
      fetchCostReport: async () => {
        await gate; // hold the first run open
        return [];
      },
    }),
    now: FIXED_NOW,
  });

  const first = service.runReconciliationNow();
  const second = await service.runReconciliationNow();
  assert.equal(second.skippedBusy, true);
  assert.equal(second.computedAt, null);

  release?.();
  const firstSummary = await first;
  assert.equal(firstSummary.skippedBusy, false);
  assert.deepEqual(firstSummary.vendorsReconciled, ["anthropic"]);
});

test("start() schedules the initial and nightly runs; stop() clears them", async () => {
  const intervals: Array<{ handler: () => void; ms: number; id: number }> = [];
  const timeouts: Array<{ handler: () => void; ms: number; id: number }> = [];
  const clearedIntervals: number[] = [];
  const clearedTimeouts: number[] = [];
  let nextId = 1;
  let loaded = 0;

  const service = new CostReconciliationService({
    anthropicKeyStore: makeKeyStore("anthropic", "sk-ant-admin"),
    openaiKeyStore: makeKeyStore("openai"),
    store: makeStore().store,
    loadUsageRows: () => {
      loaded += 1;
      return [];
    },
    createAnthropicClient: () => makeAnthropicClient([]),
    now: FIXED_NOW,
    setInterval: (handler, ms) => {
      const id = nextId++;
      intervals.push({ handler, ms, id });
      return id as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: (handle) =>
      clearedIntervals.push(handle as unknown as number),
    setTimeout: (handler, ms) => {
      const id = nextId++;
      timeouts.push({ handler, ms, id });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => clearedTimeouts.push(handle as unknown as number),
  });

  service.start();
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].ms, INITIAL_RECONCILIATION_DELAY_MS);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, RECONCILIATION_INTERVAL_MS);

  // Calling start() again must not double-schedule.
  service.start();
  assert.equal(timeouts.length, 1);
  assert.equal(intervals.length, 1);

  // Firing the initial handler triggers a run (one key configured).
  timeouts[0].handler();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loaded, 1);

  service.stop();
  assert.deepEqual(clearedIntervals, [intervals[0].id]);
  // The initial handle was cleared to null after firing, so only the interval is cleared.
  assert.deepEqual(clearedTimeouts, []);
});

test("a scheduled tick with no keys does nothing", async () => {
  const timeouts: Array<{ handler: () => void }> = [];
  let loaded = 0;
  const service = new CostReconciliationService({
    anthropicKeyStore: makeKeyStore("anthropic"),
    openaiKeyStore: makeKeyStore("openai"),
    store: makeStore().store,
    loadUsageRows: () => {
      loaded += 1;
      return [];
    },
    now: FIXED_NOW,
    setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
    setTimeout: (handler) => {
      timeouts.push({ handler });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
  });

  service.start();
  timeouts[0].handler();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loaded, 0);
});
