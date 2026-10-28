import assert from "node:assert/strict";
import { DesktopClientAttributionHeader } from "@repo/api/src/types/desktop-client-attribution";
import { test } from "vitest";
import { z } from "zod";
import {
  fetchSessionJson,
  postSessionJson,
  SessionRequestCredentialKind,
  sendSessionClApiRequest,
  unwrapApiEnvelope,
  unwrapApiResultData,
} from "../src/main/util/api-response-utils.js";
import {
  resetDesktopClientAttribution,
  setDesktopClientAttributionResolver,
} from "../src/main/util/desktop-client-attribution-provider.js";
import { sessionFetchStub } from "./session-fetch-test-utils.js";

test("unwrapApiEnvelope returns the raw data payload for an object envelope", () => {
  const data = { userId: "user-1", email: "kerensa@closedloop.ai" };
  assert.deepEqual(unwrapApiEnvelope({ success: true, data }), data);
});

test("unwrapApiEnvelope preserves an array data payload", () => {
  // The distinguishing property from unwrapApiResultData: array/primitive data
  // survives so a downstream `z.array(...)` schema sees the real shape. The
  // desktop GitHub cloud-hydration client relies on this for /repositories.
  const data = [{ id: "1" }, { id: "2" }];
  assert.deepEqual(unwrapApiEnvelope({ success: true, data }), data);
  // Contrast: the record-returning helper coerces the array to {}.
  assert.deepEqual(unwrapApiResultData({ success: true, data }), {});
});

test("unwrapApiEnvelope returns the body unchanged when it is not an envelope", () => {
  const notEnvelope = { connected: false };
  assert.equal(unwrapApiEnvelope(notEnvelope), notEnvelope);
  // `success` present but not literal true ⇒ not an envelope, body passes through.
  const failureBody = { success: false, data: 1 };
  assert.equal(unwrapApiEnvelope(failureBody), failureBody);
});

test("unwrapApiEnvelope passes through non-object bodies", () => {
  const arrayBody = [1, 2, 3];
  assert.equal(unwrapApiEnvelope(arrayBody), arrayBody);
  assert.equal(unwrapApiEnvelope(null), null);
  assert.equal(unwrapApiEnvelope("plain"), "plain");
});

test("unwrapApiEnvelope yields undefined for a success envelope with no data", () => {
  assert.equal(unwrapApiEnvelope({ success: true }), undefined);
});

const payloadSchema = z.object({ value: z.string() }).passthrough();

test("fetchSessionJson resolves the path, unwraps the envelope, and merges caller headers", async () => {
  const { fetchImpl, calls } = sessionFetchStub(
    new Response(JSON.stringify({ success: true, data: { value: "ok" } }), {
      status: 200,
    })
  );

  const result = await fetchSessionJson(
    {
      fetch: fetchImpl,
      getAccessToken: () => Promise.resolve("access-token"),
      getApiOrigin: () => "https://api.closedloop.test",
    },
    "/desktop/thing",
    payloadSchema,
    { headers: { Accept: "application/json" } }
  );

  assert.deepEqual(result, { value: "ok" });
  assert.equal(calls[0].url, "https://api.closedloop.test/desktop/thing");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Accept, "application/json");
  assert.equal(headers.Authorization, "Bearer access-token");
});

test("fetchSessionJson never lets a caller header override the session Authorization", async () => {
  const { fetchImpl, calls } = sessionFetchStub(
    new Response(JSON.stringify({ success: true, data: { value: "ok" } }), {
      status: 200,
    })
  );

  await fetchSessionJson(
    {
      fetch: fetchImpl,
      getAccessToken: () => Promise.resolve("real-token"),
      getApiOrigin: () => "https://api.closedloop.test",
    },
    "/desktop/thing",
    payloadSchema,
    { headers: { Authorization: "Bearer spoofed" } }
  );

  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer real-token");
});

test("fetchSessionJson returns null without fetching when the origin is missing", async () => {
  const { fetchImpl, calls } = sessionFetchStub(
    new Response("{}", { status: 200 })
  );

  const result = await fetchSessionJson(
    {
      fetch: fetchImpl,
      getAccessToken: () => Promise.resolve("access-token"),
      getApiOrigin: () => undefined,
    },
    "/desktop/thing",
    payloadSchema
  );

  assert.equal(result, null);
  assert.equal(calls.length, 0);
});

/**
 * ISS-8749: the shared session-fetch seam stamps the published attribution on
 * every first-party cloud read, and stamps nothing when nothing is published.
 * Both cases run through the same helper, so a client that always sent a
 * placeholder would fail the second.
 */
test("fetchSessionJson stamps the published Desktop attribution", async () => {
  resetDesktopClientAttribution();
  setDesktopClientAttributionResolver(() => ({
    installationId: "019c26aa-3c11-7bb2-8f04-1d7e5a9c3311",
    clientVersion: "1.24.3",
  }));
  const { fetchImpl, calls } = sessionFetchStub(
    new Response(JSON.stringify({ success: true, data: { value: "ok" } }), {
      status: 200,
    })
  );

  await fetchSessionJson(
    {
      fetch: fetchImpl,
      getAccessToken: () => Promise.resolve("access-token"),
      getApiOrigin: () => "https://api.closedloop.test",
    },
    "/desktop/thing",
    payloadSchema
  );

  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(
    headers[DesktopClientAttributionHeader.InstallationId],
    "019c26aa-3c11-7bb2-8f04-1d7e5a9c3311"
  );
  assert.equal(headers[DesktopClientAttributionHeader.ClientVersion], "1.24.3");
  resetDesktopClientAttribution();
});

test("fetchSessionJson sends no attribution headers before one is published", async () => {
  resetDesktopClientAttribution();
  const { fetchImpl, calls } = sessionFetchStub(
    new Response(JSON.stringify({ success: true, data: { value: "ok" } }), {
      status: 200,
    })
  );

  await fetchSessionJson(
    {
      fetch: fetchImpl,
      getAccessToken: () => Promise.resolve("access-token"),
      getApiOrigin: () => "https://api.closedloop.test",
    },
    "/desktop/thing",
    payloadSchema
  );

  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(
    Object.hasOwn(headers, DesktopClientAttributionHeader.InstallationId),
    false
  );
  assert.equal(
    Object.hasOwn(headers, DesktopClientAttributionHeader.ClientVersion),
    false
  );
});

test("postSessionJson stamps the published Desktop attribution", async () => {
  resetDesktopClientAttribution();
  setDesktopClientAttributionResolver(() => ({ clientVersion: "2.0.0" }));
  const { fetchImpl, calls } = sessionFetchStub(
    new Response(JSON.stringify({ success: true }), { status: 200 })
  );

  await postSessionJson(
    {
      fetch: fetchImpl,
      getAccessToken: () => Promise.resolve("access-token"),
      getApiOrigin: () => "https://api.closedloop.test",
    },
    "/desktop/telemetry",
    { ok: true }
  );

  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers[DesktopClientAttributionHeader.ClientVersion], "2.0.0");
  // Only what was published: a half-published attribution stays half-sent.
  assert.equal(
    Object.hasOwn(headers, DesktopClientAttributionHeader.InstallationId),
    false
  );
  resetDesktopClientAttribution();
});

test("postSessionJson never lets a caller header override the session Authorization", async () => {
  const { fetchImpl, calls } = sessionFetchStub(
    new Response(JSON.stringify({ success: true }), { status: 200 })
  );

  const outcome = await postSessionJson(
    {
      fetch: fetchImpl,
      getAccessToken: () => Promise.resolve("real-post-token"),
      getApiOrigin: () => "https://api.closedloop.test",
    },
    "/desktop/telemetry",
    { ok: true },
    { headers: { Authorization: "Bearer spoofed" } }
  );

  assert.equal(outcome.kind, "response");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer real-post-token");
});

test("sendSessionClApiRequest builds a protected first-party Desktop request", async () => {
  resetDesktopClientAttribution();
  setDesktopClientAttributionResolver(() => ({
    installationId: "019c26aa-3c11-7bb2-8f04-1d7e5a9c3311",
    clientVersion: "1.24.3",
  }));
  const { fetchImpl, calls } = sessionFetchStub(
    new Response(JSON.stringify({ success: true }), { status: 200 })
  );

  const response = await sendSessionClApiRequest({
    fetch: fetchImpl,
    apiOrigin: "https://api.closedloop.test",
    path: "/desktop/sync?existing=1",
    query: { computeTargetId: "ct-1", omitted: undefined },
    method: "PUT",
    headers: {
      Accept: "application/json",
      Authorization: "Bearer spoofed",
    },
    body: "payload",
    cache: "no-store",
    timeoutMs: 12_345,
    credential: {
      token: "session-token",
      credentialKind: SessionRequestCredentialKind.AccessToken,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(
    calls[0].url,
    "https://api.closedloop.test/desktop/sync?existing=1&computeTargetId=ct-1"
  );
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[0].init.body, "payload");
  assert.equal(calls[0].init.cache, "no-store");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Accept, "application/json");
  assert.equal(headers.Authorization, "Bearer session-token");
  assert.equal(
    headers[DesktopClientAttributionHeader.InstallationId],
    "019c26aa-3c11-7bb2-8f04-1d7e5a9c3311"
  );
  assert.equal(headers[DesktopClientAttributionHeader.ClientVersion], "1.24.3");
  resetDesktopClientAttribution();
});

test("sendSessionClApiRequest invalidates only the rejected access token on 401", async () => {
  const accessInvalidations: string[] = [];
  const { fetchImpl } = sessionFetchStub(new Response("no", { status: 401 }));

  await sendSessionClApiRequest({
    fetch: fetchImpl,
    apiOrigin: "https://api.closedloop.test",
    path: "/desktop/sync",
    timeoutMs: 10_000,
    credential: {
      token: "session-token",
      credentialKind: SessionRequestCredentialKind.AccessToken,
    },
    onUnauthorized: (rejectedToken) => {
      accessInvalidations.push(rejectedToken);
    },
  });

  await sendSessionClApiRequest({
    fetch: fetchImpl,
    apiOrigin: "https://api.closedloop.test",
    path: "/desktop/sync",
    timeoutMs: 10_000,
    credential: {
      token: "api-key-token",
      credentialKind: SessionRequestCredentialKind.ApiKey,
    },
    onUnauthorized: (rejectedToken) => {
      accessInvalidations.push(rejectedToken);
    },
  });

  assert.deepEqual(accessInvalidations, ["session-token"]);
});

/**
 * The ISS-8749 boot regression, as behavior.
 *
 * The first cut published a VALUE, calling `host.getNodeUuidForTelemetry()`
 * during composition — but `nodeUuidStore` is assigned from that composition
 * function's own return value, so it threw `Cannot read properties of
 * undefined` and desktop startup died before any window appeared (12 e2e specs,
 * `desktop-build`, `desktop`, and `a11y` all red on one cause). Deferring the
 * read fixes the boot; making the resolver TOTAL is what keeps a later failure
 * — a disposed host during shutdown, a store not yet ready — from turning a
 * telemetry header into a failed cloud request.
 */
test("a resolver that throws degrades to no headers, not a failed request", async () => {
  resetDesktopClientAttribution();
  setDesktopClientAttributionResolver(() => {
    throw new TypeError("Cannot read properties of undefined");
  });
  const { fetchImpl, calls } = sessionFetchStub(
    new Response(JSON.stringify({ success: true, data: { value: "ok" } }), {
      status: 200,
    })
  );

  const result = await fetchSessionJson(
    {
      fetch: fetchImpl,
      getAccessToken: () => Promise.resolve("access-token"),
      getApiOrigin: () => "https://api.closedloop.test",
    },
    "/desktop/thing",
    payloadSchema
  );

  assert.deepEqual(result, { value: "ok" });
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(
    Object.hasOwn(headers, DesktopClientAttributionHeader.InstallationId),
    false
  );
  assert.equal(headers.Authorization, "Bearer access-token");
  resetDesktopClientAttribution();
});
