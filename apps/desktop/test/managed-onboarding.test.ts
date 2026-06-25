import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_ONBOARDING_PROTOCOL_VERSION,
  fetchTrustedDesktopConfig,
  parseTrustedDesktopConfig,
  withSingleManagedOnboardingRetry,
} from "../src/main/managed-onboarding.js";

test("parseTrustedDesktopConfig accepts the exact trusted config contract", () => {
  const result = parseTrustedDesktopConfig({
    apiOrigin: "https://api.closedloop.ai/v1",
    relayOrigin: "https://relay.closedloop.ai/socket",
    onboardingProtocolVersion: DESKTOP_ONBOARDING_PROTOCOL_VERSION,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.config : null, {
    apiOrigin: "https://api.closedloop.ai",
    relayOrigin: "https://relay.closedloop.ai",
    onboardingProtocolVersion: DESKTOP_ONBOARDING_PROTOCOL_VERSION,
  });
});

test("parseTrustedDesktopConfig rejects missing or extra fields", () => {
  assert.deepEqual(
    parseTrustedDesktopConfig({
      apiOrigin: "https://api.closedloop.ai",
      relayOrigin: "https://relay.closedloop.ai",
      onboardingProtocolVersion: DESKTOP_ONBOARDING_PROTOCOL_VERSION,
      bootstrapToken: "secret",
    }),
    { ok: false, reason: "invalid_response" }
  );
});

test("parseTrustedDesktopConfig rejects unsupported protocol versions", () => {
  assert.deepEqual(
    parseTrustedDesktopConfig({
      apiOrigin: "https://api.closedloop.ai",
      relayOrigin: "https://relay.closedloop.ai",
      onboardingProtocolVersion: "0",
    }),
    { ok: false, reason: "unsupported_protocol" }
  );
});

test("fetchTrustedDesktopConfig retries are enabled only for network failure and 503", async () => {
  const networkResult = await fetchTrustedDesktopConfig({
    webAppOrigin: "https://app.closedloop.ai",
    fetchImpl: async () => {
      throw new Error("network failed");
    },
  });
  assert.equal(networkResult.kind, "failed");
  assert.equal(
    networkResult.kind === "failed" ? networkResult.retryable : false,
    true
  );

  const forbiddenResult = await fetchTrustedDesktopConfig({
    webAppOrigin: "https://app.closedloop.ai",
    fetchImpl: async () =>
      new Response(JSON.stringify({ code: "FORBIDDEN", retryable: false }), {
        status: 403,
      }),
  });
  assert.equal(forbiddenResult.kind, "failed");
  assert.equal(
    forbiddenResult.kind === "failed" ? forbiddenResult.retryable : true,
    false
  );

  const unavailableResult = await fetchTrustedDesktopConfig({
    webAppOrigin: "https://app.closedloop.ai",
    fetchImpl: async () =>
      new Response(JSON.stringify({ code: "UNAVAILABLE", retryable: true }), {
        status: 503,
      }),
  });
  assert.equal(unavailableResult.kind, "failed");
  assert.equal(
    unavailableResult.kind === "failed" ? unavailableResult.retryable : false,
    true
  );
});

test("fetchTrustedDesktopConfig rejects invalid web origins before fetch", async () => {
  let fetchCalled = false;
  const result = await fetchTrustedDesktopConfig({
    webAppOrigin: "http://attacker.example",
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("must not fetch");
    },
  });

  assert.deepEqual(result, {
    kind: "failed",
    reason: "invalid_origin",
    retryable: false,
    error: "invalid webAppOrigin",
  });
  assert.equal(fetchCalled, false);
});

test("fetchTrustedDesktopConfig allows loopback HTTP development origins", async () => {
  let fetchedUrl = "";
  const result = await fetchTrustedDesktopConfig({
    webAppOrigin: "http://localhost:3000/onboarding",
    fetchImpl: async (url) => {
      fetchedUrl = String(url);
      return new Response(
        JSON.stringify({
          apiOrigin: "https://api.closedloop.ai",
          relayOrigin: "https://relay.closedloop.ai",
          onboardingProtocolVersion: DESKTOP_ONBOARDING_PROTOCOL_VERSION,
        }),
        { status: 200 }
      );
    },
  });

  assert.equal(result.kind, "ok");
  assert.equal(
    fetchedUrl,
    "http://localhost:3000/.well-known/closedloop-desktop.json"
  );
});

test("withSingleManagedOnboardingRetry retries once when still active", async () => {
  let calls = 0;
  const result = await withSingleManagedOnboardingRetry({
    operation: async () => {
      calls += 1;
      return calls === 1 ? "retry" : "success";
    },
    shouldRetry: (value) => value === "retry",
    delayMs: 5000,
    sleep: async (delayMs) => {
      assert.equal(delayMs, 5000);
    },
  });

  assert.equal(result, "success");
  assert.equal(calls, 2);
});

test("withSingleManagedOnboardingRetry skips retry after cancellation", async () => {
  let calls = 0;
  let cancelled = false;
  const result = await withSingleManagedOnboardingRetry({
    operation: async () => {
      calls += 1;
      return calls === 1 ? "retry" : "success";
    },
    shouldRetry: (value) => value === "retry",
    delayMs: 5000,
    sleep: async () => {
      cancelled = true;
    },
    isCancelled: () => cancelled,
  });

  assert.equal(result, "retry");
  assert.equal(calls, 1);
});

test("withSingleManagedOnboardingRetry returns non-retryable results without sleeping", async () => {
  let slept = false;
  const result = await withSingleManagedOnboardingRetry({
    operation: async () => "terminal",
    shouldRetry: (value) => value === "retry",
    delayMs: 5000,
    sleep: async () => {
      slept = true;
    },
  });

  assert.equal(result, "terminal");
  assert.equal(slept, false);
});
