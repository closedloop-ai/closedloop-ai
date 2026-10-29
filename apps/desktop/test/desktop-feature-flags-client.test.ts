import assert from "node:assert/strict";
import { test } from "vitest";
import { fetchDesktopFeatureFlags } from "../src/main/auth/desktop-feature-flags-client.js";
import { sessionFetchStub } from "./session-fetch-test-utils.js";

const API_ORIGIN = "https://api.closedloop.test";
const ASSIGNMENT = {
  userId: "user-1",
  resolved: true,
  flags: { "agents-nav": true, "branches-cohort-transparency": false },
};

const options = (overrides: {
  fetch: typeof fetch;
  token?: string | null;
  origin?: string;
}) => ({
  fetch: overrides.fetch,
  getAccessToken: () =>
    Promise.resolve<string | null>(
      "token" in overrides ? (overrides.token ?? null) : "access-token"
    ),
  getApiOrigin: () => overrides.origin ?? API_ORIGIN,
});

test("fetchDesktopFeatureFlags unwraps the success envelope and Bearer-auths", async () => {
  const { fetchImpl, calls } = sessionFetchStub(
    new Response(JSON.stringify({ success: true, data: ASSIGNMENT }), {
      status: 200,
    })
  );

  const result = await fetchDesktopFeatureFlags(options({ fetch: fetchImpl }));

  assert.deepEqual(result, ASSIGNMENT);
  assert.equal(calls[0].url, `${API_ORIGIN}/desktop/feature-flags`);
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer access-token");
});

test("fetchDesktopFeatureFlags returns null without an access token, and never asks", async () => {
  const { fetchImpl, calls } = sessionFetchStub(
    new Response("{}", { status: 200 })
  );

  const result = await fetchDesktopFeatureFlags(
    options({ fetch: fetchImpl, token: null })
  );

  assert.equal(result, null);
  assert.equal(calls.length, 0);
});

test("fetchDesktopFeatureFlags returns null on a non-2xx response", async () => {
  const { fetchImpl } = sessionFetchStub(new Response("nope", { status: 401 }));

  const result = await fetchDesktopFeatureFlags(options({ fetch: fetchImpl }));

  assert.equal(result, null);
});

// A malformed assignment is UNKNOWN, and unknown is closed. Coercing a
// non-boolean verdict here would hand the renderer a gate it never evaluated.
test("fetchDesktopFeatureFlags rejects a non-boolean flag verdict outright", async () => {
  const { fetchImpl } = sessionFetchStub(
    new Response(
      JSON.stringify({
        success: true,
        data: {
          userId: "user-1",
          resolved: true,
          flags: { "agents-nav": "true" },
        },
      }),
      { status: 200 }
    )
  );

  const result = await fetchDesktopFeatureFlags(options({ fetch: fetchImpl }));

  assert.equal(result, null);
});

// The parsed object is handed straight back over IPC, so anything this schema
// keeps reaches the renderer. An additive field on the API side must not ride
// along: the renderer's contract is exactly `{ userId, resolved, flags }`.
test("fetchDesktopFeatureFlags does not forward unknown fields across the IPC boundary", async () => {
  const { fetchImpl } = sessionFetchStub(
    new Response(
      JSON.stringify({
        success: true,
        data: {
          ...ASSIGNMENT,
          posthogApiKey: "phc_should_never_reach_the_renderer",
          distinctIds: ["clerk-1", "user-1"],
          provider: { name: "posthog" },
        },
      }),
      { status: 200 }
    )
  );

  const result = await fetchDesktopFeatureFlags(options({ fetch: fetchImpl }));

  // Stripped, not rejected: the assignment still resolves, so a newer API
  // adding a field cannot close every gate on an older desktop build.
  assert.deepEqual(result, ASSIGNMENT);
  assert.deepEqual(Object.keys(result ?? {}).sort(), [
    "flags",
    "resolved",
    "userId",
  ]);
});

test("fetchDesktopFeatureFlags preserves an UNAVAILABLE verdict rather than folding it to an empty assignment", async () => {
  const { fetchImpl } = sessionFetchStub(
    new Response(
      JSON.stringify({
        success: true,
        data: { userId: "user-1", resolved: false, flags: {} },
      }),
      { status: 200 }
    )
  );

  const result = await fetchDesktopFeatureFlags(options({ fetch: fetchImpl }));

  assert.deepEqual(result, { userId: "user-1", resolved: false, flags: {} });
});
