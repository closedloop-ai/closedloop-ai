/**
 * @file reconciliation-worker.test.ts
 * @description Unit tests for the nightly cost-reconciliation worker
 * (FEA-1435/1436), src/main/reconciliation-worker.ts.
 *
 * Reviewed invariants:
 *   (1) the local genai-prices estimate is aggregated per (day × vendor × model)
 *       and differenced against the vendor-billed amount; expected local values
 *       are computed by calling the SAME engine (token-cost.ts) so the test is
 *       not pinned to a hard-coded rate;
 *   (2) Anthropic reconciles PER MODEL while OpenAI collapses to a single
 *       day-grain cell summed across all OpenAI models (the vendor has no
 *       per-model dimension);
 *   (3) Anthropic server-side tool costs (model:null) land under a sentinel and
 *       read as an under-estimate explained by the server_side_tool_use hint;
 *   (4) drift direction drives the cause hint: an under-estimate with cache
 *       writes → the permanent 1h cache-write gap; an over-estimate vs a
 *       non-zero bill → batch discount; a $0 bill → trial/credit (driftPct null);
 *   (5) only metered API usage is reconciled — subscription rows and unpriced
 *       models contribute nothing (no silent $0), and a vendor with no fetch
 *       function (no Admin key) is skipped rather than compared to a $0 bill;
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { usdToMicroCents } from "../src/main/cost-math.js";
import {
  type ReconciliationRow,
  ReconciliationStore,
} from "../src/main/reconciliation-store.js";
import {
  ANTHROPIC_TOOLS_MODEL,
  type MeteredUsageRow,
  OPENAI_DAY_GRAIN_MODEL,
  runReconciliation,
} from "../src/main/reconciliation-worker.js";
import { computeTokenCost } from "../src/shared/token-cost.js";

const FIXED_NOW = () => new Date("2026-05-28T00:00:00Z");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
function makeTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "reconciliation-worker-test-")
  );
  tempDirs.push(dir);
  return dir;
}

/** A fake store that records the rows handed to upsert. */
function makeStore(): {
  store: Pick<ReconciliationStore, "upsert">;
  last: () => ReconciliationRow[];
} {
  const captured: ReconciliationRow[][] = [];
  return {
    store: {
      upsert(rows: readonly ReconciliationRow[]): number {
        captured.push([...rows]);
        return rows.length;
      },
    },
    last: () => captured.at(-1) ?? [],
  };
}

/** Build a metered usage row with sensible defaults. */
function usage(partial: Partial<MeteredUsageRow>): MeteredUsageRow {
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

/** Compute the exact micro-cents the worker will derive for a row (same engine). */
function expectMicroCents(row: MeteredUsageRow): number {
  const result = computeTokenCost({
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    timestamp: new Date(row.startedAt),
  });
  assert.ok(
    result.priced && result.costUsd != null,
    `${row.model} should be priced`
  );
  return usdToMicroCents(result.costUsd);
}

const UNIX = (iso: string) => Math.floor(Date.parse(iso) / 1000);

test("reconciles each vendor at its grain with zero drift when the bill matches", async () => {
  const a1 = usage({
    sessionId: "a1",
    model: "claude-opus-4-5",
    inputTokens: 10_000,
    outputTokens: 2000,
    cacheWriteTokens: 500,
  });
  const a2 = usage({
    sessionId: "a2",
    model: "claude-opus-4-5",
    inputTokens: 5000,
    outputTokens: 1000,
  });
  const o1 = usage({
    sessionId: "o1",
    model: "gpt-4.1",
    inputTokens: 8000,
    outputTokens: 3000,
  });
  const localAnthropic = expectMicroCents(a1) + expectMicroCents(a2);
  const localOpenAi = expectMicroCents(o1);

  const anthropicCalls: Array<{ startingAt: string; endingAt: string }> = [];
  const openAiCalls: Array<{ startTime: number; endTime: number }> = [];
  const { store, last } = makeStore();

  const result = await runReconciliation({
    loadUsageRows: () => [a1, a2, o1],
    fetchAnthropicBilled: async (q) => {
      anthropicCalls.push(q);
      return [
        {
          day: "2026-05-20",
          model: "claude-opus-4-5",
          amountMicroCents: localAnthropic,
          label: "tokens",
        },
      ];
    },
    fetchOpenAiBilled: async (q) => {
      openAiCalls.push(q);
      return [
        {
          day: "2026-05-20",
          model: null,
          amountMicroCents: localOpenAi,
          label: null,
        },
      ];
    },
    store,
    now: FIXED_NOW,
  });

  assert.equal(result.rowsWritten, 2);
  assert.equal(result.notices.length, 0);
  // Both vendors had a usage window and were actually queried.
  assert.deepEqual([...result.queriedVendors].sort(), ["anthropic", "openai"]);

  const rows = last();
  const aRow = rows.find((r) => r.vendor === "anthropic");
  assert.ok(aRow);
  assert.equal(aRow.model, "claude-opus-4-5");
  assert.equal(aRow.localEstimateMicroCents, localAnthropic);
  assert.equal(aRow.vendorBilledMicroCents, localAnthropic);
  assert.equal(aRow.driftMicroCents, 0);
  assert.equal(aRow.driftPct, 0);

  const oRow = rows.find((r) => r.vendor === "openai");
  assert.ok(oRow);
  assert.equal(oRow.model, OPENAI_DAY_GRAIN_MODEL);
  assert.equal(oRow.driftMicroCents, 0);

  // The window is derived from the local usage days and passed to both vendors.
  assert.deepEqual(anthropicCalls[0], {
    startingAt: "2026-05-20T00:00:00Z",
    endingAt: "2026-05-21T00:00:00Z",
  });
  assert.deepEqual(openAiCalls[0], {
    startTime: UNIX("2026-05-20T00:00:00Z"),
    endTime: UNIX("2026-05-21T00:00:00Z"),
  });
});

test("a ~1% drift is recorded but stays under the notice threshold", async () => {
  const a1 = usage({
    model: "claude-opus-4-5",
    inputTokens: 50_000,
    outputTokens: 10_000,
    cacheWriteTokens: 2000,
  });
  const local = expectMicroCents(a1);
  const vendor = Math.round(local * 1.01);
  const { store, last } = makeStore();

  const result = await runReconciliation({
    loadUsageRows: () => [a1],
    fetchAnthropicBilled: async () => [
      {
        day: "2026-05-20",
        model: "claude-opus-4-5",
        amountMicroCents: vendor,
        label: "tokens",
      },
    ],
    store,
    now: FIXED_NOW,
  });

  const row = last()[0];
  assert.ok(row.driftPct !== null);
  assert.ok(Math.abs(row.driftPct) < 2, `drift ${row.driftPct} should be < 2%`);
  assert.equal(result.notices.length, 0);
});

test("OpenAI reconciles at day grain, summing across all models", async () => {
  const o1 = usage({
    sessionId: "o1",
    model: "gpt-4.1",
    inputTokens: 8000,
    outputTokens: 3000,
  });
  const o2 = usage({
    sessionId: "o2",
    model: "gpt-4o",
    inputTokens: 4000,
    outputTokens: 1000,
  });
  const localTotal = expectMicroCents(o1) + expectMicroCents(o2);
  const { store, last } = makeStore();

  const result = await runReconciliation({
    loadUsageRows: () => [o1, o2],
    fetchOpenAiBilled: async () => [
      {
        day: "2026-05-20",
        model: null,
        amountMicroCents: localTotal,
        label: "line",
      },
    ],
    store,
    now: FIXED_NOW,
  });

  const rows = last();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, OPENAI_DAY_GRAIN_MODEL);
  assert.equal(rows[0].vendor, "openai");
  assert.equal(rows[0].localEstimateMicroCents, localTotal);
  assert.equal(rows[0].driftMicroCents, 0);
  assert.equal(result.notices.length, 0);
});

test("Anthropic server-side tool cost (model null) reconciles under a sentinel and explains as tool use", async () => {
  const a1 = usage({
    model: "claude-opus-4-5",
    inputTokens: 10_000,
    outputTokens: 2000,
  });
  const localA = expectMicroCents(a1);
  const toolCost = 500_000; // micro-cents the vendor billed for web_search
  const { store, last } = makeStore();

  const result = await runReconciliation({
    loadUsageRows: () => [a1],
    fetchAnthropicBilled: async () => [
      {
        day: "2026-05-20",
        model: "claude-opus-4-5",
        amountMicroCents: localA,
        label: "tokens",
      },
      {
        day: "2026-05-20",
        model: null,
        amountMicroCents: toolCost,
        label: "web_search",
      },
    ],
    store,
    now: FIXED_NOW,
  });

  const rows = last();
  assert.equal(rows.length, 2);
  const toolRow = rows.find((r) => r.model === ANTHROPIC_TOOLS_MODEL);
  assert.ok(toolRow);
  assert.equal(toolRow.localEstimateMicroCents, 0);
  assert.equal(toolRow.vendorBilledMicroCents, toolCost);
  assert.equal(toolRow.driftMicroCents, -toolCost);

  // The token-cost cell matched exactly → only the tool cell raises a notice.
  assert.equal(result.notices.length, 1);
  const notice = result.notices[0];
  assert.equal(notice.model, ANTHROPIC_TOOLS_MODEL);
  assert.equal(notice.causes[0].cause, "server_side_tool_use");
});

test("an under-estimate with cache writes is explained as the permanent 1h cache-write gap", async () => {
  const a1 = usage({
    model: "claude-opus-4-5",
    inputTokens: 20_000,
    outputTokens: 4000,
    cacheWriteTokens: 5000,
  });
  const local = expectMicroCents(a1);
  const vendor = Math.round(local * 1.2); // vendor billed 20% more than modeled
  const { store } = makeStore();

  const result = await runReconciliation({
    loadUsageRows: () => [a1],
    fetchAnthropicBilled: async () => [
      {
        day: "2026-05-20",
        model: "claude-opus-4-5",
        amountMicroCents: vendor,
        label: "tokens",
      },
    ],
    store,
    now: FIXED_NOW,
  });

  assert.equal(result.notices.length, 1);
  const notice = result.notices[0];
  assert.ok(notice.driftMicroCents < 0);
  assert.equal(notice.causes[0].cause, "cache_write_1h_unmodeled");
  assert.equal(notice.causes[0].permanent, true);
});

test("an over-estimate against a non-zero bill is explained as a batch discount", async () => {
  const a1 = usage({
    model: "claude-opus-4-5",
    inputTokens: 20_000,
    outputTokens: 4000,
  });
  const local = expectMicroCents(a1);
  const vendor = Math.round(local * 0.8); // vendor billed 20% less
  const { store } = makeStore();

  const result = await runReconciliation({
    loadUsageRows: () => [a1],
    fetchAnthropicBilled: async () => [
      {
        day: "2026-05-20",
        model: "claude-opus-4-5",
        amountMicroCents: vendor,
        label: "tokens",
      },
    ],
    store,
    now: FIXED_NOW,
  });

  assert.equal(result.notices.length, 1);
  assert.ok(result.notices[0].driftMicroCents > 0);
  assert.equal(result.notices[0].causes[0].cause, "batch_api_discount");
});

test("a $0 vendor bill for priced usage surfaces a trial/credit notice (driftPct null)", async () => {
  const a1 = usage({
    model: "claude-opus-4-5",
    inputTokens: 20_000,
    outputTokens: 4000,
  });
  const { store, last } = makeStore();

  const result = await runReconciliation({
    loadUsageRows: () => [a1],
    fetchAnthropicBilled: async () => [], // vendor reported nothing for the day
    store,
    now: FIXED_NOW,
  });

  const row = last()[0];
  assert.ok(row.localEstimateMicroCents > 0);
  assert.equal(row.vendorBilledMicroCents, 0);
  assert.equal(row.driftPct, null);
  assert.equal(result.notices.length, 1);
  assert.equal(result.notices[0].causes[0].cause, "trial_credit");
});

test("subscription (non-metered) usage is excluded and no vendor call is made", async () => {
  const sub = usage({
    model: "claude-opus-4-5",
    billingMode: "subscription_unknown",
    inputTokens: 20_000,
    outputTokens: 4000,
  });
  let anthropicCalled = false;
  const { store } = makeStore();

  const result = await runReconciliation({
    loadUsageRows: () => [sub],
    fetchAnthropicBilled: async () => {
      anthropicCalled = true;
      return [];
    },
    store,
    now: FIXED_NOW,
  });

  assert.equal(result.rowsWritten, 0);
  assert.equal(result.notices.length, 0);
  // No metered usage → no window → the vendor API is never hit.
  assert.equal(anthropicCalled, false);
  // ...and the result reports that no vendor was actually queried, so callers
  // can avoid claiming the key was "verified" when no request was made.
  assert.deepEqual(result.queriedVendors, []);
});

test("an unpriced model contributes nothing (no silent $0)", async () => {
  const u = usage({
    model: "totally-made-up-model-xyz",
    inputTokens: 20_000,
    outputTokens: 4000,
  });
  let anthropicCalled = false;
  let openaiCalled = false;
  const { store } = makeStore();

  const result = await runReconciliation({
    loadUsageRows: () => [u],
    fetchAnthropicBilled: async () => {
      anthropicCalled = true;
      return [];
    },
    fetchOpenAiBilled: async () => {
      openaiCalled = true;
      return [];
    },
    store,
    now: FIXED_NOW,
  });

  // The unpriced model produces no local cells, but the vendor APIs are still
  // queried so vendor-billed costs can surface even when genai-prices doesn't
  // know the model yet. With no vendor-billed costs either, no rows are written.
  assert.equal(result.rowsWritten, 0);
  assert.equal(anthropicCalled, true);
  assert.equal(openaiCalled, true);
});

test("a vendor with no fetch function (no Admin key) is not reconciled against a $0 bill", async () => {
  const a1 = usage({
    sessionId: "a1",
    model: "claude-opus-4-5",
    inputTokens: 20_000,
    outputTokens: 4000,
  });
  const o1 = usage({
    sessionId: "o1",
    model: "gpt-4.1",
    inputTokens: 8000,
    outputTokens: 3000,
  });
  const localOpenAi = expectMicroCents(o1);
  const { store, last } = makeStore();

  // Only OpenAI is configured; Anthropic has no fetch function (no key).
  const result = await runReconciliation({
    loadUsageRows: () => [a1, o1],
    fetchOpenAiBilled: async () => [
      {
        day: "2026-05-20",
        model: null,
        amountMicroCents: localOpenAi,
        label: null,
      },
    ],
    store,
    now: FIXED_NOW,
  });

  const rows = last();
  // The Anthropic local cell must NOT appear — we never queried that vendor.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].vendor, "openai");
  assert.equal(result.notices.length, 0);
  // Only the vendor with a fetch function (and a usage window) was queried.
  assert.deepEqual(result.queriedVendors, ["openai"]);
});

test("persists reconciled rows into a real ReconciliationStore", async () => {
  const dir = makeTempDir();
  const store = new ReconciliationStore({ cwd: dir, now: FIXED_NOW });
  const a1 = usage({
    model: "claude-opus-4-5",
    inputTokens: 10_000,
    outputTokens: 2000,
  });
  const local = expectMicroCents(a1);

  await runReconciliation({
    loadUsageRows: () => [a1],
    fetchAnthropicBilled: async () => [
      {
        day: "2026-05-20",
        model: "claude-opus-4-5",
        amountMicroCents: Math.round(local * 1.5),
        label: "tokens",
      },
    ],
    store,
    now: FIXED_NOW,
  });

  const listed = store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].vendor, "anthropic");
  assert.equal(listed[0].model, "claude-opus-4-5");
  assert.equal(listed[0].localEstimateMicroCents, local);
});
