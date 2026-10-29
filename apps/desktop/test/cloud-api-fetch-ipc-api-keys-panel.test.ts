import assert from "node:assert/strict";
import { test } from "vitest";
import {
  API_ORIGIN,
  createHarness,
  NOT_ALLOWLISTED_ERROR,
} from "./cloud-api-fetch-ipc-test-harness.js";

/**
 * The three routes ISS-10316 adds to the bridge's non-GET allowlist: the
 * Settings v2 API Keys panel's BYO Anthropic org/user credential cards and
 * the Pensero credential card, each saved with PUT and removed with DELETE.
 *
 * The refusals below are the point of this file. Opening PUT for these three
 * exact paths must not open PUT (or DELETE) for anything else, including a
 * near-miss on the same prefix.
 */

const ALLOWED_ROUTES = [
  "/settings/api-keys/org",
  "/settings/api-keys/user",
  "/settings/pensero",
];

test("PUT saves each API Keys panel credential route", async () => {
  for (const path of ALLOWED_ROUTES) {
    const { invoke, fetchCalls } = createHarness();
    const body = JSON.stringify({ apiKey: "sk-ant-test" });

    const result = await invoke({
      path,
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        // A compromised renderer's spoofed credential must still be dropped.
        Authorization: "Bearer sentinel-from-renderer",
        "X-Organization-Id": "org-spoofed",
      },
      body,
    });

    assert.equal(result.kind, "response", `PUT ${path} must fetch`);
    assert.equal(fetchCalls.length, 1, `PUT ${path} must fetch exactly once`);
    const call = fetchCalls[0];
    assert.equal(call.url.toString(), `${API_ORIGIN}${path}`);
    assert.equal(call.init.method, "PUT");
    assert.equal(call.init.body, body);
    const headers = call.init.headers as Headers;
    assert.equal(headers.get("authorization"), "Bearer real-access-token");
    assert.equal(headers.get("x-organization-id"), "org-1");
  }
});

test("DELETE removes each API Keys panel credential route", async () => {
  for (const path of ALLOWED_ROUTES) {
    const { invoke, fetchCalls } = createHarness();

    const result = await invoke({ path, method: "DELETE" });

    assert.equal(result.kind, "response", `DELETE ${path} must fetch`);
    assert.equal(
      fetchCalls.length,
      1,
      `DELETE ${path} must fetch exactly once`
    );
    assert.equal(fetchCalls[0].init.method, "DELETE");
    assert.equal(fetchCalls[0].url.toString(), `${API_ORIGIN}${path}`);
  }
});

test("refuses PUT and DELETE to a path that is not exactly one of the three routes", async () => {
  for (const path of [
    // Unrelated settings path on the same prefix.
    "/settings/frustration",
    // Nested under an allowed route.
    "/settings/api-keys/org/extra",
    // Prefix match without the separator, not the same path.
    "/settings/api-keys/orgx",
    "/settings/penserox",
    // The collection above the two allowed api-keys members.
    "/settings/api-keys",
    // A query suffix must not smuggle an allowed path onto an unrelated one.
    "/settings/frustration?x=/settings/pensero",
  ]) {
    for (const method of ["PUT", "DELETE"]) {
      const { invoke, fetchCalls } = createHarness();

      const result = await invoke({
        path,
        method,
        ...(method === "DELETE" ? {} : { body: "{}" }),
      });

      assert.equal(
        result.kind,
        "network-error",
        `${method} ${path} must be rejected`
      );
      if (result.kind === "network-error") {
        assert.match(result.message, NOT_ALLOWLISTED_ERROR);
      }
      assert.equal(fetchCalls.length, 0, `${method} ${path} must not fetch`);
    }
  }
});

test("does not open the pre-existing platform API key gap", async () => {
  // POST /api-keys and DELETE /api-keys/{id} are a known, pre-existing
  // allowlist gap this change deliberately leaves closed.
  for (const { path, method } of [
    { path: "/api-keys", method: "POST" },
    { path: "/api-keys/key-1", method: "DELETE" },
  ]) {
    const { invoke, fetchCalls } = createHarness();

    const result = await invoke({
      path,
      method,
      ...(method === "DELETE" ? {} : { body: "{}" }),
    });

    assert.equal(
      result.kind,
      "network-error",
      `${method} ${path} must still be rejected`
    );
    assert.equal(fetchCalls.length, 0, `${method} ${path} must not fetch`);
  }
});

test("does not open PUT for allowlisted GET or other-method routes", async () => {
  // These paths are allowlisted for other methods (or are GET-only reads);
  // PUT against them must still be refused.
  for (const path of ["/agent-sessions/sess-1/trace-comments/comment-1"]) {
    const { invoke, fetchCalls } = createHarness();

    const result = await invoke({ path, method: "PUT", body: "{}" });

    assert.equal(result.kind, "network-error", `PUT ${path} must be rejected`);
    assert.equal(fetchCalls.length, 0, `PUT ${path} must not fetch`);
  }
});
