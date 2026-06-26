/**
 * @file claude-code-analytics-service.test.ts
 * @description Unit tests for src/main/claude-code-analytics-service.ts (FEA-1436),
 * the desktop-main seam that turns the Anthropic Admin key into a per-user Claude
 * Code usage view for the renderer.
 *
 * Reviewed invariants:
 *   (1) with no Admin key, no fetch is attempted and the result is
 *       `available: false` (the renderer shows a "configure a key" hint);
 *   (2) with a key, the trailing window is computed from the injected clock
 *       (endDay = today UTC, startDay = today − (windowDays−1)) and the client's
 *       records are returned verbatim;
 *   (3) a renderer-supplied windowDays is clamped to [1, MAX] (and a non-number
 *       falls back to the default) before it can drive the day loop;
 *   (4) a client failure is surfaced as a key-free `error` with empty records and
 *       `available: true` (it never throws across IPC), and the thrown message is
 *       never allowed to leak the key.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdminKeyStatus } from "../src/main/admin-key-store.js";
import type { ClaudeCodeUsageRecord } from "../src/main/claude-code-analytics-client.js";
import {
  type AnthropicKeyReader,
  type ClaudeCodeAnalyticsClientLike,
  ClaudeCodeAnalyticsService,
  DEFAULT_ANALYTICS_WINDOW_DAYS,
  MAX_ANALYTICS_WINDOW_DAYS,
} from "../src/main/claude-code-analytics-service.js";

/** A key reader fake with a settable key. */
function keyReader(key: string | null): AnthropicKeyReader {
  return {
    getKey: () => key,
    getStatus: (): AdminKeyStatus => ({
      vendor: "anthropic",
      hasKey: key !== null,
    }),
  };
}

/** A client fake that records the query and returns canned records. */
function clientFake(records: ClaudeCodeUsageRecord[]): {
  client: ClaudeCodeAnalyticsClientLike;
  queries: Array<{ startDay: string; endDay: string }>;
} {
  const queries: Array<{ startDay: string; endDay: string }> = [];
  const client: ClaudeCodeAnalyticsClientLike = {
    fetchUsage: async (query) => {
      queries.push(query);
      return records;
    },
  };
  return { client, queries };
}

const FIXED_NOW = new Date("2026-05-28T15:30:00Z");

function sampleRecord(): ClaudeCodeUsageRecord {
  return {
    day: "2026-05-28",
    actor: "dev@example.com",
    actorType: "user",
    model: "claude-sonnet-4",
    estimatedCostMicroCents: 2_500_000,
    inputTokens: 1,
    outputTokens: 1,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
}

test("with no Admin key, no fetch runs and the result is unavailable", async () => {
  let built = 0;
  const service = new ClaudeCodeAnalyticsService({
    anthropicKeyStore: keyReader(null),
    createClient: () => {
      built += 1;
      return clientFake([]).client;
    },
    now: () => FIXED_NOW,
  });

  const result = await service.fetchAnalytics();

  assert.equal(result.available, false);
  assert.deepEqual(result.records, []);
  assert.equal(result.window, null);
  assert.equal(result.error, null);
  assert.equal(result.computedAt, null);
  assert.equal(built, 0, "no client should be built without a key");
});

test("with a key, computes the trailing window from the clock and returns records", async () => {
  const { client, queries } = clientFake([sampleRecord()]);
  const service = new ClaudeCodeAnalyticsService({
    anthropicKeyStore: keyReader("sk-ant-admin-TEST"),
    createClient: () => client,
    now: () => FIXED_NOW,
  });

  const result = await service.fetchAnalytics();

  assert.equal(result.available, true);
  assert.equal(result.error, null);
  assert.equal(result.records.length, 1);
  // Default 7-day window inclusive of today (2026-05-28): 05-22 … 05-28.
  assert.deepEqual(result.window, {
    startDay: "2026-05-22",
    endDay: "2026-05-28",
  });
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0], {
    startDay: "2026-05-22",
    endDay: "2026-05-28",
  });
  assert.equal(result.computedAt, FIXED_NOW.toISOString());
  // Default sanity.
  assert.equal(DEFAULT_ANALYTICS_WINDOW_DAYS, 7);
});

test("clamps windowDays to [1, MAX] and falls back to default for non-numbers", async () => {
  const make = () => {
    const { client, queries } = clientFake([]);
    const service = new ClaudeCodeAnalyticsService({
      anthropicKeyStore: keyReader("sk-ant-admin-TEST"),
      createClient: () => client,
      now: () => FIXED_NOW,
    });
    return { service, queries };
  };

  // 1-day window → start === end === today.
  const a = make();
  await a.service.fetchAnalytics({ windowDays: 1 });
  assert.deepEqual(a.queries[0], {
    startDay: "2026-05-28",
    endDay: "2026-05-28",
  });

  // 0 clamps up to 1.
  const b = make();
  await b.service.fetchAnalytics({ windowDays: 0 });
  assert.deepEqual(b.queries[0], {
    startDay: "2026-05-28",
    endDay: "2026-05-28",
  });

  // Huge clamps down to MAX (window spans MAX days inclusive).
  const c = make();
  await c.service.fetchAnalytics({ windowDays: 10_000 });
  const expectedStart = new Date(
    FIXED_NOW.getTime() - (MAX_ANALYTICS_WINDOW_DAYS - 1) * 86_400_000
  )
    .toISOString()
    .slice(0, 10);
  assert.deepEqual(c.queries[0], {
    startDay: expectedStart,
    endDay: "2026-05-28",
  });

  // Non-number falls back to the default 7-day window.
  const d = make();
  await d.service.fetchAnalytics({ windowDays: Number.NaN });
  assert.deepEqual(d.queries[0], {
    startDay: "2026-05-22",
    endDay: "2026-05-28",
  });
});

test("a client failure surfaces as a key-free error, not a throw", async () => {
  const service = new ClaudeCodeAnalyticsService({
    anthropicKeyStore: keyReader("sk-ant-admin-SECRET"),
    createClient: () => ({
      fetchUsage: async () => {
        throw new Error("Anthropic Claude Code analytics admin API HTTP 403");
      },
    }),
    now: () => FIXED_NOW,
  });

  const result = await service.fetchAnalytics();

  assert.equal(result.available, true);
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.window, {
    startDay: "2026-05-22",
    endDay: "2026-05-28",
  });
  assert.match(result.error ?? "", /HTTP 403/);
  assert.ok(!(result.error ?? "").includes("sk-ant-admin-SECRET"));
  assert.equal(result.computedAt, FIXED_NOW.toISOString());
});

test("getKeyStatus reflects the underlying store", () => {
  const present = new ClaudeCodeAnalyticsService({
    anthropicKeyStore: keyReader("sk-ant-admin-TEST"),
  });
  assert.deepEqual(present.getKeyStatus(), {
    vendor: "anthropic",
    hasKey: true,
  });

  const absent = new ClaudeCodeAnalyticsService({
    anthropicKeyStore: keyReader(null),
  });
  assert.deepEqual(absent.getKeyStatus(), {
    vendor: "anthropic",
    hasKey: false,
  });
});
