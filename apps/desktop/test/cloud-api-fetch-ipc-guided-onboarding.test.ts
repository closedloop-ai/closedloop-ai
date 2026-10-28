/**
 * ISS-11249: the guided onboarding run's transition command must clear the
 * non-GET IPC allowlist.
 *
 * Without the entry the renderer could READ `/onboarding/guided/snapshot` (GET
 * is not allowlist-gated) and never move the run, so every resumed checklist
 * step on a signed-in Desktop was an enabled control that did nothing — main
 * refused the write before it touched the network and the client's own
 * `onError` deliberately raises no toast. The launched-app spec
 * `guided-onboarding-settings-sync.spec.ts` is the end-to-end proof; this pins
 * the gate itself, including that opening it opened nothing else.
 */

import assert from "node:assert/strict";
import { GUIDED_ONBOARDING_TRANSITION_PATH } from "@repo/api/src/types/onboarding-guided";
import { test } from "vitest";
import {
  API_ORIGIN,
  createHarness,
  NOT_ALLOWLISTED_ERROR,
} from "./cloud-api-fetch-ipc-test-harness.js";

test("forwards the guided onboarding transition with main-held authentication", async () => {
  const { invoke, fetchCalls } = createHarness();
  const body = JSON.stringify({
    commandId: "11111111-2222-4333-8444-555555555555",
    event: { step: "choose_session_sync", type: "resume_pending_step" },
    experienceVariant: "v2",
    host: "desktop",
    revision: 3,
    state: { phase: "sync_policy", history: ["dashboard_available"] },
  });
  const result = await invoke({
    path: GUIDED_ONBOARDING_TRANSITION_PATH,
    method: "POST",
    body,
  });

  assert.equal(result.kind, "response");
  assert.equal(fetchCalls.length, 1);
  assert.equal(
    fetchCalls[0].url.toString(),
    `${API_ORIGIN}${GUIDED_ONBOARDING_TRANSITION_PATH}`
  );
  assert.equal(fetchCalls[0].init.body, body);
  assert.equal(
    (fetchCalls[0].init.headers as Headers).get("authorization"),
    "Bearer real-access-token"
  );
});

test("does not open the guided snapshot sibling or other onboarding writes", async () => {
  for (const [path, method] of [
    [GUIDED_ONBOARDING_TRANSITION_PATH, "PATCH"],
    [GUIDED_ONBOARDING_TRANSITION_PATH, "PUT"],
    [GUIDED_ONBOARDING_TRANSITION_PATH, "DELETE"],
    [`${GUIDED_ONBOARDING_TRANSITION_PATH}/`, "POST"],
    [`${GUIDED_ONBOARDING_TRANSITION_PATH}/replay`, "POST"],
    ["/onboarding/guided/snapshot", "POST"],
    ["/onboarding/guided", "POST"],
    ["/onboarding", "POST"],
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
