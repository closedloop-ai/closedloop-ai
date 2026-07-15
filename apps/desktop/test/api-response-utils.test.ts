import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  fetchSessionJson,
  unwrapApiEnvelope,
  unwrapApiResultData,
} from "../src/main/api-response-utils.js";
import { sessionFetchStub } from "./session-fetch-test-utils.js";

test("unwrapApiEnvelope returns the raw data payload for an object envelope", () => {
  const data = { userId: "user-1", email: "kris@closedloop.ai" };
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
