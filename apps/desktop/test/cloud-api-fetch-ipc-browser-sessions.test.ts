import assert from "node:assert/strict";
import { test } from "vitest";
import {
  API_ORIGIN,
  createHarness,
  NOT_ALLOWLISTED_ERROR,
} from "./cloud-api-fetch-ipc-test-harness.js";

/**
 * The one entry PLN-1915 adds to the bridge's non-GET allowlist (D7): revoking
 * ONE of the caller's own browser sign-ins from the Desktop renderer.
 *
 * The refusals below are the point of this file. The credential is main-held,
 * so every path this allowlist opens is a path a compromised renderer can
 * mutate with the org's authority — an entry that accidentally matched the
 * collection, a nested path, or the compute-target routes would hand it far
 * more than one sign-out.
 */

const BROWSER_SESSION_PATH = "/settings/browser-sessions/sess_2fabc";

test("allows DELETE of a single browser session by id", async () => {
  const { invoke, fetchCalls } = createHarness();

  const result = await invoke({
    path: BROWSER_SESSION_PATH,
    method: "DELETE",
    headers: {
      // A compromised renderer's spoofed credential must still be dropped.
      Authorization: "Bearer sentinel-from-renderer",
      "X-Organization-Id": "org-spoofed",
    },
  });

  assert.equal(result.kind, "response");
  assert.equal(fetchCalls.length, 1);
  const call = fetchCalls[0];
  assert.equal(call.url.toString(), `${API_ORIGIN}${BROWSER_SESSION_PATH}`);
  assert.equal(call.init.method, "DELETE");
  const headers = call.init.headers as Headers;
  assert.equal(headers.get("authorization"), "Bearer real-access-token");
  assert.equal(headers.get("x-organization-id"), "org-1");
});

test("refuses every browser-session path that is not exactly one session", async () => {
  for (const { path, method } of [
    // The collection itself: a DELETE here would be "revoke everything".
    { path: "/settings/browser-sessions", method: "DELETE" },
    { path: "/settings/browser-sessions/", method: "DELETE" },
    // Nested under a session id.
    { path: `${BROWSER_SESSION_PATH}/tokens`, method: "DELETE" },
    { path: `${BROWSER_SESSION_PATH}/tokens/t-1`, method: "DELETE" },
    // A sibling settings collection reached through the same prefix.
    { path: "/settings/browser-sessions-admin/s-1", method: "DELETE" },
    // The entry opens DELETE only — not the other mutating methods.
    { path: BROWSER_SESSION_PATH, method: "POST" },
    { path: BROWSER_SESSION_PATH, method: "PATCH" },
    // A query suffix must not widen the entry.
    {
      path: "/settings/compute-mode?x=/settings/browser-sessions/s-1",
      method: "DELETE",
    },
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
      `${method} ${path} must be rejected`
    );
    if (result.kind === "network-error") {
      assert.match(result.message, NOT_ALLOWLISTED_ERROR);
    }
    assert.equal(fetchCalls.length, 0, `${method} ${path} must not fetch`);
  }
});

test("still refuses every compute-target mutation", async () => {
  // D1: the panel that manages compute targets is web-only precisely because
  // none of these is reachable from the renderer. Opening the browser-session
  // revoke must not have changed that.
  for (const { path, method } of [
    { path: "/compute-targets/target-1", method: "DELETE" },
    { path: "/compute-targets/target-1", method: "PUT" },
    { path: "/compute-targets/target-1/sharing", method: "PATCH" },
    { path: "/compute-targets/target-1/commands", method: "POST" },
    {
      path: "/compute-targets/target-1/security-upgrade-attempt",
      method: "POST",
    },
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
      `${method} ${path} must be rejected`
    );
    assert.equal(fetchCalls.length, 0, `${method} ${path} must not fetch`);
  }
});
