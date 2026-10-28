import assert from "node:assert/strict";
import {
  canonicalBranchDetailResponseFixture,
  canonicalBranchListResponseFixture,
  canonicalBranchProjectionVariants,
} from "@repo/app/branches/test-fixtures/canonical-branch-projection";
import { test } from "vitest";
import {
  API_ORIGIN,
  createHarness,
} from "./cloud-api-fetch-ipc-test-harness.js";

test("round-trips the web canonical Branch fixture without field loss", async () => {
  const body = { success: true, data: canonicalBranchListResponseFixture };
  const { invoke, fetchCalls } = createHarness({}, jsonResponse(body));

  const result = await invoke({ path: "/branches?limit=1", method: "GET" });

  assert.equal(fetchCalls.length, 1);
  assert.equal(result.kind, "response");
  if (result.kind === "response") {
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.bodyText), body);
  }
});

test("round-trips alternate canonical states on list and detail paths", async () => {
  for (const canonicalProjection of canonicalBranchProjectionVariants) {
    const payloads = [
      {
        path: "/branches?limit=1",
        data: {
          ...canonicalBranchListResponseFixture,
          items: [
            {
              ...canonicalBranchListResponseFixture.items[0],
              canonicalProjection,
            },
          ],
        },
      },
      {
        path: "/branches/branch-artifact-1",
        data: {
          ...canonicalBranchDetailResponseFixture,
          canonicalProjection,
        },
      },
    ];
    for (const payload of payloads) {
      const body = { success: true, data: payload.data };
      const { invoke } = createHarness({}, jsonResponse(body));

      const result = await invoke({ path: payload.path, method: "GET" });

      assert.equal(result.kind, "response");
      if (result.kind === "response") {
        assert.deepEqual(JSON.parse(result.bodyText), body);
      }
    }
  }
});

test("preserves an unknown future Branch projection without coercion", async () => {
  const body = {
    success: true,
    data: {
      ...canonicalBranchListResponseFixture,
      items: [
        {
          ...canonicalBranchListResponseFixture.items[0],
          canonicalProjection: { version: "v2", opaque: { retained: true } },
        },
      ],
    },
  };
  const { invoke } = createHarness({}, jsonResponse(body));

  const result = await invoke({ path: "/branches?limit=1", method: "GET" });

  assert.equal(result.kind, "response");
  if (result.kind === "response") {
    assert.deepEqual(JSON.parse(result.bodyText), body);
  }
});

test("preserves a Branch permission error response", async () => {
  const body = {
    success: false,
    error: "Forbidden",
    details: { reason: "permission", availability: "unavailable" },
  };
  const { invoke } = createHarness({}, jsonResponse(body, 403, "Forbidden"));

  const result = await invoke({ path: "/branches" });

  assert.equal(result.kind, "response");
  if (result.kind === "response") {
    assert.equal(result.status, 403);
    assert.deepEqual(JSON.parse(result.bodyText), body);
  }
});

test("allows the exact Branch cohort analytics POST read route", async () => {
  const body = JSON.stringify({ branchIds: ["branch-1"] });
  const responseBody = {
    success: true,
    data: { cohortKey: "branch-1", canonicalMetrics: null },
  };
  const { invoke, fetchCalls } = createHarness({}, jsonResponse(responseBody));

  const result = await invoke({
    path: "/branches/analytics/cohort",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer renderer-spoof",
    },
    body,
  });

  assert.equal(fetchCalls.length, 1);
  const call = fetchCalls[0];
  assert.equal(call.url.toString(), `${API_ORIGIN}/branches/analytics/cohort`);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.body, body);
  const headers = call.init.headers as Headers;
  assert.equal(headers.get("authorization"), "Bearer real-access-token");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(result.kind, "response");
  if (result.kind === "response") {
    assert.deepEqual(JSON.parse(result.bodyText), responseBody);
  }
});

test("rejects non-exact Branch cohort analytics POST paths", async () => {
  for (const path of [
    "/branches/analytics/cohort/extra",
    "/branches/analytics?cohort=true",
    "/branches/branch-1/analytics/cohort",
  ]) {
    const { invoke, fetchCalls } = createHarness();

    const result = await invoke({ path, method: "POST", body: "{}" });

    assert.equal(result.kind, "network-error", `${path} must be rejected`);
    assert.equal(fetchCalls.length, 0, `${path} must not fetch`);
  }
});

function jsonResponse(
  body: unknown,
  status = 200,
  statusText = "OK"
): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}
