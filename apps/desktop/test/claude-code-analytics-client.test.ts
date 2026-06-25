/**
 * @file claude-code-analytics-client.test.ts
 * @description Unit tests for src/main/claude-code-analytics-client.ts (FEA-1436),
 * the read-only client for Anthropic's Claude Code Analytics report.
 *
 * Reviewed invariants:
 *   (1) the Admin key travels ONLY in the x-api-key header, never the URL/query,
 *       and each request carries anthropic-version + the single-day starting_at;
 *   (2) records flatten to one row per actor×model×day, user_actor → email /
 *       api_actor → key name, and estimated_cost.amount (a NUMBER in cents) is
 *       converted to exact integer micro-cents;
 *   (3) the client loops ONE request per UTC day across the window;
 *   (4) within a day it follows next_page and concatenates pages;
 *   (5) a non-2xx throws with the status; malformed money throws rather than
 *       silently dropping spend; a negative token count throws; exceeding the
 *       per-day page cap throws rather than returning a partial usage picture;
 *   (6) an unknown/future actor shape is surfaced (not dropped) under a stable
 *       label, and an inverted/oversized/impossible-date window is rejected.
 *
 * The network is never touched: the shared recording fake fetch returns canned
 * bodies (see test/helpers/admin-fetch.ts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeCodeAnalyticsClient } from "../src/main/claude-code-analytics-client.js";
import { makeFetch } from "./helpers/admin-fetch.js";

/** A single-day page with one user actor and one api actor, two models. */
function oneDayPage() {
  return {
    data: [
      {
        actor: { type: "user_actor", email_address: "dev@example.com" },
        date: "2026-05-20",
        customer_type: "subscription",
        subscription_type: "enterprise",
        model_breakdown: [
          {
            model: "claude-sonnet-4",
            // 250 cents → $2.50 → 2_500_000 micro-cents.
            estimated_cost: { amount: 250, currency: "USD" },
            tokens: {
              input: 1000,
              output: 500,
              cache_creation: 200,
              cache_read: 800,
            },
          },
          {
            model: "claude-opus-4",
            estimated_cost: { amount: 75, currency: "USD" },
            tokens: { input: 10, output: 5 },
          },
        ],
      },
      {
        actor: { type: "api_actor", api_key_name: "ci-bot" },
        date: "2026-05-20",
        customer_type: "api",
        subscription_type: null,
        model_breakdown: [
          {
            model: "claude-haiku-4",
            estimated_cost: { amount: 10, currency: "USD" },
            tokens: { input: 100, output: 50 },
          },
        ],
      },
    ],
    has_more: false,
    next_page: null,
  };
}

test("flattens actor×model×day, maps actor identity, converts cents→micro-cents", async () => {
  const { fetch, calls } = makeFetch([oneDayPage()]);
  const client = new ClaudeCodeAnalyticsClient({
    apiKey: "sk-ant-admin-TEST",
    fetch,
  });

  const records = await client.fetchUsage({
    startDay: "2026-05-20",
    endDay: "2026-05-20",
  });

  assert.deepEqual(records, [
    {
      day: "2026-05-20",
      actor: "dev@example.com",
      actorType: "user",
      model: "claude-sonnet-4",
      estimatedCostMicroCents: 2_500_000,
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 200,
      cacheReadTokens: 800,
    },
    {
      day: "2026-05-20",
      actor: "dev@example.com",
      actorType: "user",
      model: "claude-opus-4",
      estimatedCostMicroCents: 750_000,
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    {
      day: "2026-05-20",
      actor: "ci-bot",
      actorType: "api_key",
      model: "claude-haiku-4",
      estimatedCostMicroCents: 100_000,
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
  ]);

  // One day → one call; key in header, never URL; single-day starting_at.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["x-api-key"], "sk-ant-admin-TEST");
  assert.equal(calls[0].headers["anthropic-version"], "2023-06-01");
  assert.ok(!calls[0].url.includes("sk-ant-admin-TEST"));
  assert.ok(calls[0].url.includes("starting_at=2026-05-20"));
  assert.ok(calls[0].url.includes("limit=1000"));
});

test("loops one request per UTC day across the window", async () => {
  // Each day returns a single empty page; we assert one call per day, in order.
  const emptyDay = { data: [], has_more: false, next_page: null };
  const { fetch, calls } = makeFetch([emptyDay]);
  const client = new ClaudeCodeAnalyticsClient({
    apiKey: "sk-ant-admin-TEST",
    fetch,
  });

  const records = await client.fetchUsage({
    startDay: "2026-05-18",
    endDay: "2026-05-20",
  });

  assert.equal(records.length, 0);
  assert.equal(calls.length, 3);
  assert.ok(calls[0].url.includes("starting_at=2026-05-18"));
  assert.ok(calls[1].url.includes("starting_at=2026-05-19"));
  assert.ok(calls[2].url.includes("starting_at=2026-05-20"));
});

test("follows next_page within a single day and concatenates", async () => {
  const page1 = {
    data: [
      {
        actor: { type: "user_actor", email_address: "a@example.com" },
        model_breakdown: [
          {
            model: "m1",
            estimated_cost: { amount: 100, currency: "USD" },
            tokens: {},
          },
        ],
      },
    ],
    has_more: true,
    next_page: "PAGE_2",
  };
  const page2 = {
    data: [
      {
        actor: { type: "user_actor", email_address: "b@example.com" },
        model_breakdown: [
          {
            model: "m1",
            estimated_cost: { amount: 200, currency: "USD" },
            tokens: {},
          },
        ],
      },
    ],
    has_more: false,
    next_page: null,
  };
  const { fetch, calls } = makeFetch([page1, page2]);
  const client = new ClaudeCodeAnalyticsClient({
    apiKey: "sk-ant-admin-TEST",
    fetch,
  });

  const records = await client.fetchUsage({
    startDay: "2026-05-20",
    endDay: "2026-05-20",
  });

  assert.deepEqual(
    records.map((r) => r.actor),
    ["a@example.com", "b@example.com"]
  );
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes("page=PAGE_2"));
  assert.ok(calls[1].url.includes("starting_at=2026-05-20"));
});

test("a non-2xx response throws with the status", async () => {
  const { fetch } = makeFetch([{ error: "nope" }], {
    status: 403,
    bodyText: '{"error":"not a Team/Enterprise org"}',
  });
  const client = new ClaudeCodeAnalyticsClient({
    apiKey: "sk-ant-admin-TEST",
    fetch,
  });
  await assert.rejects(
    () => client.fetchUsage({ startDay: "2026-05-20", endDay: "2026-05-20" }),
    /Anthropic Claude Code analytics admin API HTTP 403/
  );
});

test("malformed estimated cost throws rather than dropping spend", async () => {
  const { fetch } = makeFetch([
    {
      data: [
        {
          actor: { type: "user_actor", email_address: "a@example.com" },
          model_breakdown: [
            // amount is a string, not a number.
            {
              model: "m1",
              estimated_cost: { amount: "250", currency: "USD" },
              tokens: {},
            },
          ],
        },
      ],
      has_more: false,
      next_page: null,
    },
  ]);
  const client = new ClaudeCodeAnalyticsClient({
    apiKey: "sk-ant-admin-TEST",
    fetch,
  });
  await assert.rejects(
    () => client.fetchUsage({ startDay: "2026-05-20", endDay: "2026-05-20" }),
    /estimated_cost\.amount must be a number/
  );
});

test("a negative token count throws rather than recording a nonsensical value", async () => {
  const { fetch } = makeFetch([
    {
      data: [
        {
          actor: { type: "user_actor", email_address: "a@example.com" },
          model_breakdown: [
            {
              model: "m1",
              estimated_cost: { amount: 100, currency: "USD" },
              tokens: { input: -5, output: 10 },
            },
          ],
        },
      ],
      has_more: false,
      next_page: null,
    },
  ]);
  const client = new ClaudeCodeAnalyticsClient({
    apiKey: "sk-ant-admin-TEST",
    fetch,
  });
  await assert.rejects(
    () => client.fetchUsage({ startDay: "2026-05-20", endDay: "2026-05-20" }),
    /token count must be non-negative/
  );
});

test("exceeding the per-day page cap throws instead of returning partial usage", async () => {
  const alwaysMore = {
    data: [
      {
        actor: { type: "user_actor", email_address: "a@example.com" },
        model_breakdown: [
          {
            model: "m1",
            estimated_cost: { amount: 1, currency: "USD" },
            tokens: {},
          },
        ],
      },
    ],
    has_more: true,
    next_page: "NEXT",
  };
  const { fetch, calls } = makeFetch([alwaysMore]);
  const client = new ClaudeCodeAnalyticsClient({
    apiKey: "sk-ant-admin-TEST",
    fetch,
    maxPagesPerDay: 3,
  });
  await assert.rejects(
    () => client.fetchUsage({ startDay: "2026-05-20", endDay: "2026-05-20" }),
    /exceeded the page cap/
  );
  assert.equal(calls.length, 3);
});

test("has_more without a page cursor throws rather than returning a partial day", async () => {
  // The day claims more pages but gives no cursor — we cannot fetch the rest, so
  // returning the first page as complete would understate the day's usage.
  const { fetch, calls } = makeFetch([
    {
      data: [
        {
          actor: { type: "user_actor", email_address: "a@example.com" },
          model_breakdown: [
            {
              model: "m1",
              estimated_cost: { amount: 1, currency: "USD" },
              tokens: {},
            },
          ],
        },
      ],
      has_more: true,
      next_page: null,
    },
  ]);
  const client = new ClaudeCodeAnalyticsClient({
    apiKey: "sk-ant-admin-TEST",
    fetch,
  });
  await assert.rejects(
    () => client.fetchUsage({ startDay: "2026-05-20", endDay: "2026-05-20" }),
    /claimed more pages .* no page cursor/
  );
  assert.equal(calls.length, 1);
});

test("an unknown actor shape is surfaced under a stable label, not dropped", async () => {
  const { fetch } = makeFetch([
    {
      data: [
        {
          actor: { type: "service_actor", service_name: "future" },
          model_breakdown: [
            {
              model: "m1",
              estimated_cost: { amount: 500, currency: "USD" },
              tokens: {},
            },
          ],
        },
      ],
      has_more: false,
      next_page: null,
    },
  ]);
  const client = new ClaudeCodeAnalyticsClient({
    apiKey: "sk-ant-admin-TEST",
    fetch,
  });
  const records = await client.fetchUsage({
    startDay: "2026-05-20",
    endDay: "2026-05-20",
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].actor, "(unknown actor)");
  assert.equal(records[0].actorType, "api_key");
  assert.equal(records[0].estimatedCostMicroCents, 5_000_000);
});

test("rejects an inverted window and a bad day string", async () => {
  const { fetch } = makeFetch([{ data: [], has_more: false, next_page: null }]);
  const client = new ClaudeCodeAnalyticsClient({
    apiKey: "sk-ant-admin-TEST",
    fetch,
  });
  await assert.rejects(
    () => client.fetchUsage({ startDay: "2026-05-20", endDay: "2026-05-18" }),
    /endDay is before startDay/
  );
  await assert.rejects(
    () => client.fetchUsage({ startDay: "2026/05/20", endDay: "2026-05-20" }),
    /startDay must be YYYY-MM-DD/
  );
  // A well-formed but impossible calendar day (Feb 30) must be rejected — JS
  // Date silently overflows it to March 1, so the shape check alone is not enough.
  await assert.rejects(
    () => client.fetchUsage({ startDay: "2026-02-30", endDay: "2026-02-30" }),
    /startDay is not a real date/
  );
});

test("rejects an empty Admin key at construction", () => {
  assert.throws(
    () => new ClaudeCodeAnalyticsClient({ apiKey: "   " }),
    /Anthropic admin key is required/
  );
});
