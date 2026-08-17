import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fetchUsageSnapshot,
  USAGE_API_URL,
  type UsageApiClientDeps,
  UsageFetchFailure,
  type UsageFetchLike,
} from "../src/main/session-limits/usage-api-client.js";

const TOKEN = "sk-ant-oat01-CANARY-TOKEN-DO-NOT-LEAK";
const FETCHED_AT = "2026-08-07T12:00:00.000Z";

/** A `/usage` body shaped like the real endpoint's. */
const USAGE_BODY = {
  five_hour: { utilization: 42.5, resets_at: "2026-08-07T15:00:00.000Z" },
  // Epoch SECONDS — the endpoint uses this form on some windows.
  seven_day: { utilization: 70, resets_at: 1_785_849_600 },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 0, resets_at: null },
  extra_usage: {
    is_enabled: true,
    monthly_limit: 2000,
    used_credits: 350,
    utilization: 17.5,
  },
};

function client(
  overrides: Partial<UsageApiClientDeps> & { fetchImpl?: UsageFetchLike }
): UsageApiClientDeps {
  return {
    readAccessToken: overrides.readAccessToken ?? (() => TOKEN),
    nowIso: overrides.nowIso ?? (() => FETCHED_AT),
    fetchImpl: overrides.fetchImpl,
    timeoutMs: overrides.timeoutMs,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

test("maps a real /usage body, including both reset-timestamp forms", async () => {
  const result = await fetchUsageSnapshot(
    client({ fetchImpl: () => jsonResponse(USAGE_BODY) })
  );
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  const s = result.snapshot;
  assert.equal(s.fiveHour?.utilization, 42.5);
  assert.equal(s.fiveHour?.resetsAt, "2026-08-07T15:00:00.000Z");
  // Epoch seconds normalized to ISO.
  assert.equal(s.sevenDay?.utilization, 70);
  assert.equal(
    s.sevenDay?.resetsAt,
    new Date(1_785_849_600 * 1000).toISOString()
  );
  assert.equal(s.sevenDayOpus, null);
  // A genuine 0% is a real value, NOT an absent window.
  assert.equal(s.sevenDaySonnet?.utilization, 0);
  assert.equal(s.extraUsage?.monthlyLimitUsd, 20);
  assert.equal(s.extraUsage?.usedCreditsUsd, 3.5);
  // The capture time is always stamped — this is what makes a stale snapshot
  // distinguishable from a fresh one.
  assert.equal(s.fetchedAt, FETCHED_AT);
});

test("sends the bearer token to the allowlisted URL and blocks redirects", async () => {
  let seenUrl: string | null = null;
  let seenInit: Record<string, unknown> | null = null;
  await fetchUsageSnapshot(
    client({
      fetchImpl: (url, init) => {
        seenUrl = url;
        seenInit = init as unknown as Record<string, unknown>;
        return jsonResponse(USAGE_BODY);
      },
    })
  );
  assert.equal(seenUrl, USAGE_API_URL);
  assert.ok(String(seenUrl).startsWith("https://api.anthropic.com/"));
  const init = seenInit as unknown as {
    method: string;
    headers: Record<string, string>;
    redirect: string;
  };
  assert.equal(init.method, "GET");
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(init.redirect, "error");
});

test("no credential → no_credential, and no request is ever issued", async () => {
  let called = 0;
  const result = await fetchUsageSnapshot(
    client({
      readAccessToken: () => null,
      fetchImpl: () => {
        called++;
        return jsonResponse(USAGE_BODY);
      },
    })
  );
  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.reason, UsageFetchFailure.NoCredential);
  assert.equal(called, 0);
});

test("401/403 report unauthorized, distinct from having no credential", async () => {
  for (const status of [401, 403]) {
    const result = await fetchUsageSnapshot(
      client({ fetchImpl: () => jsonResponse({ error: "nope" }, status) })
    );
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.reason, UsageFetchFailure.Unauthorized);
  }
});

test("other non-2xx statuses report http_error", async () => {
  const result = await fetchUsageSnapshot(
    client({ fetchImpl: () => jsonResponse({}, 500) })
  );
  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.reason, UsageFetchFailure.HttpError);
});

test("a 200 with no recognized window key is an in-band error, not 0% usage", async () => {
  // The shipped CLI applies the same test; rendering this as zeros would
  // fabricate a utilization the server never reported.
  for (const body of [
    { error: { type: "rate_limit_error" } },
    {},
    [1, 2, 3],
    null,
    "a string",
  ]) {
    const result = await fetchUsageSnapshot(
      client({ fetchImpl: () => jsonResponse(body) })
    );
    assert.equal(result.ok, false, `body: ${JSON.stringify(body)}`);
    if (result.ok) {
      return;
    }
    assert.equal(result.reason, UsageFetchFailure.UnrecognizedShape);
  }
});

test("an unknown/changed window shape degrades to unavailable rather than throwing", async () => {
  const result = await fetchUsageSnapshot(
    client({
      fetchImpl: () =>
        jsonResponse({ five_hour: { utilization: "not-a-number" } }),
    })
  );
  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.reason, UsageFetchFailure.UnrecognizedShape);
});

test("an added future window key does not invalidate the known ones (version skew)", async () => {
  const result = await fetchUsageSnapshot(
    client({
      fetchImpl: () =>
        jsonResponse({
          ...USAGE_BODY,
          some_future_window: { utilization: 5, resets_at: null },
          cinder_cove: { anything: true },
        }),
    })
  );
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.snapshot.fiveHour?.utilization, 42.5);
});

test("a transport throw becomes a network failure, never a rejection", async () => {
  const result = await fetchUsageSnapshot(
    client({
      fetchImpl: () =>
        Promise.reject(new Error(`connect ECONNREFUSED ${TOKEN}`)),
    })
  );
  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.reason, UsageFetchFailure.Network);
});

test("a body that fails to deserialize degrades to unrecognized_shape", async () => {
  const result = await fetchUsageSnapshot(
    client({
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new Error("Unexpected end of JSON input")),
        }),
    })
  );
  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.reason, UsageFetchFailure.UnrecognizedShape);
});
