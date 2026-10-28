import assert from "node:assert/strict";
import { test } from "vitest";
import {
  API_ORIGIN,
  createHarness,
  NOT_ALLOWLISTED_ERROR,
} from "./cloud-api-fetch-ipc-test-harness.js";

test("forwards organization invitations with main-held authentication and the existing body", async () => {
  const { invoke, fetchCalls } = createHarness();
  const body = JSON.stringify({
    emailAddresses: ["teammate@example.com"],
    role: "org:member",
  });
  const result = await invoke({
    path: "/organizations/invitations",
    method: "POST",
    body,
  });
  assert.equal(result.kind, "response");
  assert.equal(fetchCalls.length, 1);
  assert.equal(
    fetchCalls[0].url.toString(),
    `${API_ORIGIN}/organizations/invitations`
  );
  assert.equal(fetchCalls[0].init.body, body);
  assert.equal(
    (fetchCalls[0].init.headers as Headers).get("authorization"),
    "Bearer real-access-token"
  );
  assert.equal(
    (fetchCalls[0].init.headers as Headers).get("x-organization-id"),
    "org-1"
  );
});

test("does not open sibling invitation endpoints or other write methods", async () => {
  for (const [path, method] of [
    ["/organizations/invitations/", "POST"],
    ["/organizations/invitations/invite-1", "POST"],
    ["/organizations/invitations-admin", "POST"],
    ["/organizations", "POST"],
    ["/organizations/invitations", "PATCH"],
    ["/organizations/invitations", "PUT"],
    ["/organizations/invitations", "DELETE"],
  ]) {
    const { invoke, fetchCalls } = createHarness();
    const result = await invoke({ path, method, body: "{}" });
    assert.equal(result.kind, "network-error", `${method} ${path}`);
    if (result.kind === "network-error") {
      assert.match(result.message, NOT_ALLOWLISTED_ERROR);
    }
    assert.equal(fetchCalls.length, 0);
  }
});
