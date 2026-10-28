import assert from "node:assert/strict";
import { test } from "vitest";
import {
  API_ORIGIN,
  createHarness,
} from "./cloud-api-fetch-ipc-test-harness.js";

/**
 * ISS-12302 / PLN-2173 M1: the Cloud-mode Session and Branch Details tabs set
 * and clear one custom-field value through `PUT` / `DELETE
 * /{agent-sessions|branches}/[id]/custom-field-values/[fieldId]`, so the bridge
 * admits exactly those paths for those two methods and nothing around them.
 */

const SESSION_ID = "55555555-5555-4555-8555-555555555551";
const BRANCH_ID = "66666666-6666-4666-8666-666666666661";
const FIELD_ID = "77777777-7777-4777-8777-777777777771";
const OTHER_ID = "88888888-8888-4888-8888-888888888881";

const SESSION_VALUE_PATH = `/agent-sessions/${SESSION_ID}/custom-field-values/${FIELD_ID}`;
const BRANCH_VALUE_PATH = `/branches/${BRANCH_ID}/custom-field-values/${FIELD_ID}`;
const ADMITTED_PATHS = [SESSION_VALUE_PATH, BRANCH_VALUE_PATH];

const VALUE_BODY = JSON.stringify({ value: ["opt-a", "opt-b"] });

test("admits PUT and DELETE on one session or branch custom-field value", async () => {
  for (const path of ADMITTED_PATHS) {
    for (const [method, body] of [
      ["PUT", VALUE_BODY],
      ["DELETE", undefined],
    ] as const) {
      const { invoke, fetchCalls } = createHarness();

      const result = await invoke({
        path,
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body }),
      });

      assert.equal(result.kind, "response", `${method} ${path} must pass`);
      assert.equal(fetchCalls.length, 1, `${method} ${path} must fetch`);
      const call = fetchCalls[0];
      assert.equal(call.url.toString(), `${API_ORIGIN}${path}`);
      assert.equal(call.init.method, method);
      assert.equal(call.init.body, body);
      const headers = call.init.headers as Headers;
      assert.equal(headers.get("authorization"), "Bearer real-access-token");
    }
  }
});

test("refuses POST and PATCH on the value paths", async () => {
  for (const path of ADMITTED_PATHS) {
    for (const method of ["POST", "PATCH"]) {
      const { invoke, fetchCalls } = createHarness();

      const result = await invoke({ path, method, body: VALUE_BODY });

      assert.equal(result.kind, "network-error", `${method} ${path}`);
      assert.equal(fetchCalls.length, 0, `${method} ${path} must not fetch`);
    }
  }
});

test("refuses PUT and DELETE on every path around the value paths", async () => {
  for (const path of [
    // The collections.
    `/agent-sessions/${SESSION_ID}/custom-field-values`,
    `/branches/${BRANCH_ID}/custom-field-values`,
    // A non-UUID id in either slot.
    `/agent-sessions/bulk-assign/custom-field-values/${FIELD_ID}`,
    `/branches/${BRANCH_ID}/custom-field-values/not-a-uuid`,
    // A trailing slash, or an extra segment.
    `${SESSION_VALUE_PATH}/`,
    `${BRANCH_VALUE_PATH}/${OTHER_ID}`,
    // Other entity types' value routes.
    `/documents/${OTHER_ID}/custom-field-values/${FIELD_ID}`,
    `/projects/${OTHER_ID}/custom-field-values/${FIELD_ID}`,
    // The settings routes. A definition's PUT is the Documents custom-field
    // reuse write (`cloud-api-fetch-document-routes.ts`); its DELETE stays
    // closed and is pinned below.
    `/agent-sessions/${SESSION_ID}/custom-field-settings/${FIELD_ID}`,
  ]) {
    for (const method of ["PUT", "DELETE"]) {
      const { invoke, fetchCalls } = createHarness();

      const result = await invoke({
        path,
        method,
        ...(method === "PUT" ? { body: VALUE_BODY } : {}),
      });

      assert.equal(result.kind, "network-error", `${method} ${path}`);
      assert.equal(fetchCalls.length, 0, `${method} ${path} must not fetch`);
    }
  }
});

test("refuses DELETE on a custom-field definition", async () => {
  const { invoke, fetchCalls } = createHarness();
  const result = await invoke({
    path: `/custom-fields/${FIELD_ID}`,
    method: "DELETE",
  });
  assert.equal(result.kind, "network-error");
  assert.equal(fetchCalls.length, 0);
});
