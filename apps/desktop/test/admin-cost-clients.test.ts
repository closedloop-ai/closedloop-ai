/**
 * @file admin-cost-clients.test.ts
 * @description Unit tests for the vendor billing clients (FEA-1435/1436):
 * src/main/anthropic-admin-client.ts, src/main/openai-admin-client.ts, and the
 * shared network-allowlist guard in src/main/admin-billing.ts.
 *
 * Reviewed invariants:
 *   (1) assertAllowedAdminHost only permits https to the exact vendor host —
 *       any other host, scheme, or junk URL throws (the Admin key can never be
 *       shipped elsewhere);
 *   (2) the Admin key travels ONLY in request headers, never in the URL/query;
 *   (3) Anthropic amounts (decimal-string cents) and OpenAI amounts (USD number)
 *       are converted to exact integer micro-cents, with the day taken from the
 *       time-bucket start;
 *   (4) pagination follows next_page and concatenates pages; exceeding the page
 *       cap throws rather than returning a partial (understated) bill; and a
 *       payload that claims has_more without a usable cursor throws rather than
 *       silently returning the partial pages fetched so far;
 *   (5) a non-2xx response throws with the status, and malformed money throws
 *       rather than silently dropping a charge;
 *   (6) the thrown non-2xx error is scrubbed of any key-shaped token the vendor
 *       echoes back in its error body, so the Admin key never lands in an error
 *       message (and from there an IPC reply or the log file);
 *   (7) an error thrown by the fetch CALL itself (e.g. an invalid header value,
 *       whose message echoes the raw header — the key) is likewise scrubbed
 *       before it can reach a thrown error, an IPC reply, or the log file.
 *
 * The network is never touched: a recording fake fetch returns canned bodies.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AdminFetchLike,
  assertAllowedAdminHost,
  redactKeyLikeTokens,
  requestAdminJson,
} from "../src/main/admin-billing.js";
import { AnthropicAdminClient } from "../src/main/anthropic-admin-client.js";
import { OpenAiAdminClient } from "../src/main/openai-admin-client.js";
import { makeFetch } from "./helpers/admin-fetch.js";

// ── assertAllowedAdminHost ────────────────────────────────────────────────────

test("assertAllowedAdminHost permits only https to the exact host", () => {
  assert.doesNotThrow(() =>
    assertAllowedAdminHost(
      "https://api.anthropic.com/v1/organizations/cost_report?x=1",
      "api.anthropic.com"
    )
  );
  // Wrong host (including a look-alike) is rejected.
  assert.throws(
    () =>
      assertAllowedAdminHost("https://evil.example.com/x", "api.anthropic.com"),
    /host not allowed/
  );
  assert.throws(
    () =>
      assertAllowedAdminHost(
        "https://api.anthropic.com.evil.com/x",
        "api.anthropic.com"
      ),
    /host not allowed/
  );
  // Non-https and junk are rejected.
  assert.throws(
    () =>
      assertAllowedAdminHost("http://api.anthropic.com/x", "api.anthropic.com"),
    /must use https/
  );
  assert.throws(
    () => assertAllowedAdminHost("not a url", "api.anthropic.com"),
    /not a valid URL/
  );
});

// ── Anthropic ─────────────────────────────────────────────────────────────────

test("Anthropic: parses decimal-string cents to micro-cents and tags day/model", async () => {
  const { fetch, calls } = makeFetch([
    {
      data: [
        {
          starting_at: "2026-05-20T00:00:00Z",
          ending_at: "2026-05-21T00:00:00Z",
          results: [
            {
              amount: "123.45", // cents → $1.2345 → 1_234_500 micro-cents
              currency: "USD",
              cost_type: "tokens",
              model: "claude-sonnet-4",
              token_type: "uncached_input_tokens",
            },
            {
              amount: "10", // 10 cents → 100_000 micro-cents
              currency: "USD",
              cost_type: "web_search",
              model: null, // server-side tool cost: no model
            },
          ],
        },
      ],
      has_more: false,
      next_page: null,
    },
  ]);

  const client = new AnthropicAdminClient({
    apiKey: "sk-ant-admin-TEST",
    fetch,
  });
  const entries = await client.fetchCostReport({
    startingAt: "2026-05-20T00:00:00Z",
  });

  assert.deepEqual(entries, [
    {
      day: "2026-05-20",
      model: "claude-sonnet-4",
      amountMicroCents: 1_234_500,
      label: "tokens",
    },
    {
      day: "2026-05-20",
      model: null,
      amountMicroCents: 100_000,
      label: "web_search",
    },
  ]);

  // Key is in the header, never in the URL.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["x-api-key"], "sk-ant-admin-TEST");
  assert.equal(calls[0].headers["anthropic-version"], "2023-06-01");
  assert.ok(!calls[0].url.includes("sk-ant-admin-TEST"));
  // Requests the day grain and per-model grouping.
  assert.ok(calls[0].url.includes("bucket_width=1d"));
  assert.ok(calls[0].url.includes("group_by%5B%5D=description"));
});

test("Anthropic: follows next_page pagination and concatenates results", async () => {
  const { fetch, calls } = makeFetch([
    {
      data: [
        {
          starting_at: "2026-05-19T00:00:00Z",
          results: [{ amount: "100", cost_type: "tokens", model: "m1" }],
        },
      ],
      has_more: true,
      next_page: "PAGE_2_TOKEN",
    },
    {
      data: [
        {
          starting_at: "2026-05-20T00:00:00Z",
          results: [{ amount: "200", cost_type: "tokens", model: "m1" }],
        },
      ],
      has_more: false,
      next_page: null,
    },
  ]);

  const client = new AnthropicAdminClient({
    apiKey: "sk-ant-admin-TEST",
    fetch,
  });
  const entries = await client.fetchCostReport({
    startingAt: "2026-05-19T00:00:00Z",
  });

  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((e) => e.day),
    ["2026-05-19", "2026-05-20"]
  );
  // Second request carries the page token from the first response.
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes("page=PAGE_2_TOKEN"));
});

test("Anthropic: has_more without a page cursor throws rather than understating", async () => {
  // The vendor says there are more pages but gives no cursor — we cannot fetch
  // the rest, so returning the first page as complete would understate the bill.
  const { fetch, calls } = makeFetch([
    {
      data: [
        {
          starting_at: "2026-05-20T00:00:00Z",
          results: [{ amount: "100", cost_type: "tokens", model: "m1" }],
        },
      ],
      has_more: true,
      next_page: null,
    },
  ]);
  const client = new AnthropicAdminClient({
    apiKey: "sk-ant-admin-TEST",
    fetch,
  });
  await assert.rejects(
    () => client.fetchCostReport({ startingAt: "2026-05-20T00:00:00Z" }),
    /claimed more pages .* no page cursor/
  );
  // It stopped after the first page; it did not loop to the page cap.
  assert.equal(calls.length, 1);
});

test("Anthropic: a non-2xx response throws with the status, key scrubbed from the body", async () => {
  // Model a vendor 401 body that echoes the key it received (OpenAI does this;
  // we treat any vendor body as untrusted and scrub it).
  const { fetch } = makeFetch([{ error: "nope" }], {
    status: 401,
    bodyText:
      '{"error":"Incorrect API key provided: sk-ant-admin-TEST. Check your key."}',
  });
  const client = new AnthropicAdminClient({
    apiKey: "sk-ant-admin-TEST",
    fetch,
  });
  await assert.rejects(
    () => client.fetchCostReport({ startingAt: "2026-05-20T00:00:00Z" }),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.match(message, /Anthropic admin API HTTP 401/);
      // The exact key string must NOT appear; it is redacted instead.
      assert.ok(
        !message.includes("sk-ant-admin-TEST"),
        "error message must not contain the Admin key"
      );
      assert.match(message, /sk-\[redacted\]/);
      return true;
    }
  );
});

test("redactKeyLikeTokens scrubs plain and masked keys but leaves prose intact", () => {
  // Plain key.
  assert.equal(
    redactKeyLikeTokens("Incorrect API key provided: sk-ant-admin-TEST."),
    "Incorrect API key provided: sk-[redacted]."
  );
  // OpenAI-style asterisk-masked key.
  assert.equal(
    redactKeyLikeTokens("provided: sk-admin-****************************tK8F."),
    "provided: sk-[redacted]."
  );
  // Both vendor prefixes in one body.
  assert.equal(
    redactKeyLikeTokens("sk-admin-AAAA and sk-ant-admin-BBBB"),
    "sk-[redacted] and sk-[redacted]"
  );
  // Non-key text is untouched (no false positives on ordinary words).
  assert.equal(
    redactKeyLikeTokens("rate limit exceeded for this organization"),
    "rate limit exceeded for this organization"
  );
});

test("Anthropic: malformed money throws rather than dropping a charge", async () => {
  const { fetch } = makeFetch([
    {
      data: [
        {
          starting_at: "2026-05-20T00:00:00Z",
          results: [{ amount: 12.34, cost_type: "tokens", model: "m1" }], // number, not decimal string
        },
      ],
      has_more: false,
      next_page: null,
    },
  ]);
  const client = new AnthropicAdminClient({
    apiKey: "sk-ant-admin-TEST",
    fetch,
  });
  await assert.rejects(
    () => client.fetchCostReport({ startingAt: "2026-05-20T00:00:00Z" }),
    /amount must be a decimal string/
  );
});

test("Anthropic: exceeding the page cap throws instead of returning a partial bill", async () => {
  // Every page says has_more:true, so the client would loop forever without the cap.
  const alwaysMore = {
    data: [
      {
        starting_at: "2026-05-20T00:00:00Z",
        results: [{ amount: "1", cost_type: "tokens", model: "m1" }],
      },
    ],
    has_more: true,
    next_page: "NEXT",
  };
  const { fetch, calls } = makeFetch([alwaysMore], {});
  const client = new AnthropicAdminClient({
    apiKey: "sk-ant-admin-TEST",
    fetch,
    maxPages: 3,
  });
  await assert.rejects(
    () => client.fetchCostReport({ startingAt: "2026-05-20T00:00:00Z" }),
    /exceeded the page cap/
  );
  assert.equal(calls.length, 3);
});

// ── OpenAI ────────────────────────────────────────────────────────────────────

test("OpenAI: converts USD-number amounts to micro-cents at day grain (model null)", async () => {
  // 2026-05-20T00:00:00Z = 1747699200 unix seconds.
  const startTime = Math.floor(Date.parse("2026-05-20T00:00:00Z") / 1000);
  const { fetch, calls } = makeFetch([
    {
      object: "page",
      data: [
        {
          object: "bucket",
          start_time: startTime,
          end_time: startTime + 86_400,
          results: [
            {
              object: "organization.costs.result",
              amount: { value: 1.23, currency: "usd" }, // $1.23 → 1_230_000 micro-cents
              line_item: null,
              project_id: null,
            },
          ],
        },
      ],
      has_more: false,
      next_page: null,
    },
  ]);

  const client = new OpenAiAdminClient({ apiKey: "sk-admin-TEST", fetch });
  const entries = await client.fetchCosts({ startTime });

  assert.deepEqual(entries, [
    {
      day: "2026-05-20",
      model: null,
      amountMicroCents: 1_230_000,
      label: null,
    },
  ]);
  // Key is a Bearer header, never in the URL.
  assert.equal(calls[0].headers.authorization, "Bearer sk-admin-TEST");
  assert.ok(!calls[0].url.includes("sk-admin-TEST"));
  assert.ok(calls[0].url.includes("bucket_width=1d"));
  // No group_by — OpenAI's costs endpoint has no per-model dimension.
  assert.ok(!calls[0].url.includes("group_by"));
});

test("OpenAI: follows next_page pagination", async () => {
  const t1 = Math.floor(Date.parse("2026-05-19T00:00:00Z") / 1000);
  const t2 = Math.floor(Date.parse("2026-05-20T00:00:00Z") / 1000);
  const { fetch, calls } = makeFetch([
    {
      data: [
        {
          start_time: t1,
          results: [{ amount: { value: 1, currency: "usd" } }],
        },
      ],
      has_more: true,
      next_page: "OPENAI_PAGE_2",
    },
    {
      data: [
        {
          start_time: t2,
          results: [{ amount: { value: 2, currency: "usd" } }],
        },
      ],
      has_more: false,
      next_page: null,
    },
  ]);

  const client = new OpenAiAdminClient({ apiKey: "sk-admin-TEST", fetch });
  const entries = await client.fetchCosts({ startTime: t1 });

  assert.deepEqual(
    entries.map((e) => e.amountMicroCents),
    [1_000_000, 2_000_000]
  );
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes("page=OPENAI_PAGE_2"));
});

test("OpenAI: has_more without a page cursor throws rather than understating", async () => {
  const t1 = Math.floor(Date.parse("2026-05-20T00:00:00Z") / 1000);
  const { fetch, calls } = makeFetch([
    {
      data: [
        {
          start_time: t1,
          results: [{ amount: { value: 1, currency: "usd" } }],
        },
      ],
      has_more: true,
      next_page: null,
    },
  ]);
  const client = new OpenAiAdminClient({ apiKey: "sk-admin-TEST", fetch });
  await assert.rejects(
    () => client.fetchCosts({ startTime: t1 }),
    /claimed more pages .* no page cursor/
  );
  assert.equal(calls.length, 1);
});

test("requestAdminJson scrubs a key echoed by a fetch-call (invalid header) error", async () => {
  // The fetch call can throw BEFORE any response — e.g. an invalid header value,
  // whose message echoes the raw header (the Admin key). That error must be
  // scrubbed before it can reach an IPC reply or the log.
  const throwingFetch: AdminFetchLike = async () => {
    throw new Error(
      'Headers.append: "sk-ant-admin-SECRET12345" is an invalid header value.'
    );
  };
  await assert.rejects(
    () =>
      requestAdminJson(
        "https://api.anthropic.com/v1/x",
        { "x-api-key": "sk-ant-admin-SECRET12345" },
        throwingFetch,
        "Anthropic"
      ),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.match(message, /Anthropic admin API request failed/);
      assert.ok(
        !message.includes("sk-ant-admin-SECRET12345"),
        "the fetch-call error must not echo the Admin key"
      );
      assert.match(message, /sk-\[redacted\]/);
      return true;
    }
  );
});

test("OpenAI: malformed amount throws rather than dropping a charge", async () => {
  const startTime = Math.floor(Date.parse("2026-05-20T00:00:00Z") / 1000);
  const { fetch } = makeFetch([
    {
      data: [
        {
          start_time: startTime,
          results: [{ amount: { value: "1.23", currency: "usd" } }], // string, not number
        },
      ],
      has_more: false,
      next_page: null,
    },
  ]);
  const client = new OpenAiAdminClient({ apiKey: "sk-admin-TEST", fetch });
  await assert.rejects(
    () => client.fetchCosts({ startTime }),
    /amount\.value must be a number/
  );
});

test("both clients reject an empty Admin key at construction", () => {
  assert.throws(
    () => new AnthropicAdminClient({ apiKey: "   " }),
    /Anthropic admin key is required/
  );
  assert.throws(
    () => new OpenAiAdminClient({ apiKey: "" }),
    /OpenAI admin key is required/
  );
});
