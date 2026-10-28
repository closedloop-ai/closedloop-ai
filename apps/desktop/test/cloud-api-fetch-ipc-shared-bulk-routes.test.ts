import assert from "node:assert/strict";
import { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
import { describe, it } from "vitest";
import {
  API_ORIGIN,
  createHarness,
} from "./cloud-api-fetch-ipc-test-harness.js";

describe("shared bulk route Desktop allowlist", () => {
  for (const route of [
    BatchMutationRoute.DocumentsUpdateAssignee,
    BatchMutationRoute.ArtifactsFavorites,
  ]) {
    it(`admits the exact POST ${route} path`, async () => {
      const { invoke, fetchCalls } = createHarness();
      const path = route;
      const result = await invoke({ path, method: "POST", body: "{}" });
      assert.equal(result.kind, "response");
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].url.toString(), `${API_ORIGIN}${path}`);
    });

    it(`refuses near-miss write paths around ${route}`, async () => {
      for (const [method, path] of [
        ["POST", route.slice(0, -3)],
        ["POST", `${route}/v2`],
        ["POST", `${route}/`],
        ["PATCH", route],
      ] as const) {
        const { invoke, fetchCalls } = createHarness();
        const result = await invoke({ path, method, body: "{}" });
        assert.equal(result.kind, "network-error", `${method} ${path}`);
        assert.equal(fetchCalls.length, 0);
      }
    });
  }
});
