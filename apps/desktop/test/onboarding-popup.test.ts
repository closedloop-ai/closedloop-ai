import assert from "node:assert/strict";
import { test } from "vitest";
import {
  fetchOnboardingStatus,
  resolveOnboardingPopupDecision,
} from "../src/main/onboarding/onboarding-popup.js";

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

test("fetchOnboardingStatus bounds the request with a timeout signal", async () => {
  let capturedSignal: AbortSignal | null = null;
  await fetchOnboardingStatus({
    apiOrigin: "https://api.closedloop.ai",
    apiKey: "sk_live_test_key",
    fetchImpl: async (_input, init) => {
      capturedSignal = init?.signal ?? null;
      return new Response(JSON.stringify({ wizardCompleted: true }), {
        status: 200,
      });
    },
  });

  assert.ok(capturedSignal, "expected an abort signal on the status request");
});

test("fetchOnboardingStatus fails open when the API hangs", {
  timeout: 5000,
}, async () => {
  // Without a signal a wedged API never settles this promise and the onboarding
  // reminder silently never appears; the whole point of the bound is that the
  // caller still gets a `failed` result it can fail open on.
  //
  // NOT on fake timers, and not by choice (whitlockk, PR #6487). The repo's contract
  // is to pin timeout behavior with a faked clock, but `AbortSignal.timeout` is
  // driven by Node's INTERNAL timers, which neither `mock.timers` nor
  // `vi.useFakeTimers` patches — measured: a signal from `AbortSignal.timeout(10)`
  // stays unaborted across `advanceTimersByTimeAsync(50)`. So the wall-clock
  // dependency is removed instead: the budget is 0, which arms the abort on the
  // next turn of the loop, no assertion here compares against a duration, and
  // `fetchImpl` re-checks `aborted` before subscribing so an abort that beat
  // the listener cannot wedge the test. The case cap is not an assertion about
  // duration: it is there so that DELETING the bound reports as a named test
  // timeout rather than wedging the whole lane with no verdict.
  const result = await fetchOnboardingStatus({
    apiOrigin: "https://api.closedloop.ai",
    apiKey: "sk_live_test_key",
    timeoutMs: 0,
    fetchImpl: (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) {
          // Deliberately left pending: with no signal there is nothing to fail
          // open ON, and the case cap below names that as the failure. Rejecting
          // here instead would make the test pass under the exact deletion it
          // exists to catch.
          return;
        }
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });

  assert.equal(result.kind, "failed");
  assert.equal(
    result.kind === "failed" ? result.reason : null,
    "request_failed"
  );
  assert.equal(
    resolveOnboardingPopupDecision({
      setupComplete: true,
      dismissedPermanent: false,
      statusResult: result,
    }),
    "show"
  );
});

test("fetchOnboardingStatus reports a stalled body read as request_failed", async () => {
  // undici aborts the RESPONSE BODY on the same signal, so a server that answers
  // headers and then stalls must not be misreported as an invalid response.
  const result = await fetchOnboardingStatus({
    apiOrigin: "https://api.closedloop.ai",
    apiKey: "sk_live_test_key",
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(
              new DOMException("aborted due to timeout", "TimeoutError")
            );
          },
        }),
        { status: 200 }
      ),
  });

  assert.equal(result.kind, "failed");
  assert.equal(
    result.kind === "failed" ? result.reason : null,
    "request_failed"
  );
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
