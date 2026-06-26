import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchOnboardingStatus,
  resolveOnboardingPopupDecision,
} from "../src/main/onboarding-popup.js";

test("fetchOnboardingStatus returns wizardCompleted on success envelope", async () => {
  let capturedUrl = "";
  let capturedAuth: string | null = null;
  const result = await fetchOnboardingStatus({
    apiOrigin: "https://api.closedloop.ai",
    apiKey: "sk_live_test_key",
    fetchImpl: async (input, init) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      const headers = new Headers(init?.headers);
      capturedAuth = headers.get("authorization");
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            wizardCompleted: true,
            checklistDismissed: false,
            checklist: [],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  assert.equal(capturedUrl, "https://api.closedloop.ai/onboarding");
  assert.equal(capturedAuth, "Bearer sk_live_test_key");
  assert.equal(result.kind, "ok");
  assert.equal(result.kind === "ok" ? result.wizardCompleted : null, true);
});

test("fetchOnboardingStatus returns request_failed when fetch throws", async () => {
  const result = await fetchOnboardingStatus({
    apiOrigin: "https://api.closedloop.ai",
    apiKey: "sk_live_test_key",
    fetchImpl: async () => {
      throw new Error("network");
    },
  });
  assert.equal(result.kind, "failed");
  assert.equal(
    result.kind === "failed" ? result.reason : null,
    "request_failed"
  );
});

test("fetchOnboardingStatus returns http_error on non-2xx", async () => {
  const result = await fetchOnboardingStatus({
    apiOrigin: "https://api.closedloop.ai",
    apiKey: "sk_live_test_key",
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
  });
  assert.equal(result.kind, "failed");
  assert.equal(result.kind === "failed" ? result.reason : null, "http_error");
  assert.equal(result.kind === "failed" ? result.statusCode : null, 401);
});

test("fetchOnboardingStatus returns invalid_response when wizardCompleted missing", async () => {
  const result = await fetchOnboardingStatus({
    apiOrigin: "https://api.closedloop.ai",
    apiKey: "sk_live_test_key",
    fetchImpl: async () =>
      new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
      }),
  });
  assert.equal(result.kind, "failed");
  assert.equal(
    result.kind === "failed" ? result.reason : null,
    "invalid_response"
  );
});

test("resolveOnboardingPopupDecision skips when setup incomplete", () => {
  const decision = resolveOnboardingPopupDecision({
    setupComplete: false,
    dismissedPermanent: false,
    statusResult: { kind: "ok", wizardCompleted: false },
  });
  assert.equal(decision, "skip");
});

test("resolveOnboardingPopupDecision skips when permanently dismissed", () => {
  const decision = resolveOnboardingPopupDecision({
    setupComplete: true,
    dismissedPermanent: true,
    statusResult: { kind: "ok", wizardCompleted: false },
  });
  assert.equal(decision, "skip");
});

test("resolveOnboardingPopupDecision suppresses when wizard already complete", () => {
  const decision = resolveOnboardingPopupDecision({
    setupComplete: true,
    dismissedPermanent: false,
    statusResult: { kind: "ok", wizardCompleted: true },
  });
  assert.equal(decision, "suppress");
});

test("resolveOnboardingPopupDecision shows when wizard incomplete", () => {
  const decision = resolveOnboardingPopupDecision({
    setupComplete: true,
    dismissedPermanent: false,
    statusResult: { kind: "ok", wizardCompleted: false },
  });
  assert.equal(decision, "show");
});

test("resolveOnboardingPopupDecision fails open on fetch failure", () => {
  const decision = resolveOnboardingPopupDecision({
    setupComplete: true,
    dismissedPermanent: false,
    statusResult: {
      kind: "failed",
      reason: "request_failed",
      error: "network",
    },
  });
  assert.equal(decision, "show");
});
