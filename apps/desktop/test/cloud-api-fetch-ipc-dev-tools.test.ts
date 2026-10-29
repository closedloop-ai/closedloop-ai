import assert from "node:assert/strict";
import {
  FEATURE_FLAG_OVERRIDES_HEADER,
  FEATURE_FLAGS_CHECKED_HEADER,
} from "@repo/api/src/types/feature-flag-overrides";
import { test } from "vitest";
import { createHarness } from "./cloud-api-fetch-ipc-test-harness.js";

test("forwards Dev Tools overrides and returns server checked keys", async () => {
  const checked = "agentsNav,docsHelp";
  const { invoke, fetchCalls } = createHarness(
    {},
    new Response("{}", {
      headers: { [FEATURE_FLAGS_CHECKED_HEADER]: checked },
    })
  );
  const overrides = JSON.stringify({ agentsNav: false });

  const result = await invoke({
    path: "/desktop/feature-flags",
    headers: { [FEATURE_FLAG_OVERRIDES_HEADER]: overrides },
  });

  const headers = fetchCalls[0]?.init.headers as Headers;
  assert.equal(headers.get(FEATURE_FLAG_OVERRIDES_HEADER), overrides);
  assert.equal(result.kind, "response");
  if (result.kind === "response") {
    assert.equal(
      new Headers(result.headers).get(FEATURE_FLAGS_CHECKED_HEADER),
      checked
    );
  }
});
