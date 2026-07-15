import assert from "node:assert/strict";
import { test } from "node:test";
import {
  pollDeviceOnboarding,
  startDeviceOnboarding,
} from "../src/main/desktop-device-onboarding-client.js";

const API_ORIGIN = "https://api.closedloop.test";

const START_INPUT = {
  apiOrigin: API_ORIGIN,
  webAppOrigin: "https://app.closedloop.test",
  gatewayId: "gateway-1",
  gatewayPublicKeyPem:
    "-----BEGIN PUBLIC KEY-----\nMCowBQ...\n-----END PUBLIC KEY-----\n",
  machineName: "test-machine",
  platform: "darwin",
  desktopVersion: "1.2.3",
};

const START_BODY = {
  deviceSessionId: "device-1",
  deviceSessionSecret: "secret-1",
  userCode: "ABCD1234",
  verificationUrl:
    "https://app.closedloop.test/settings/integrations/desktop/connect?code=ABCD1234",
  expiresAt: "2026-06-30T16:15:00.000Z",
  pollIntervalSeconds: 5,
};

type FetchCall = { url: string; init: RequestInit };

function fetchStub(response: Response | (() => never)): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (typeof response === "function") {
      response();
    }
    return Promise.resolve(response as Response);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("startDeviceOnboarding posts the device descriptor and parses the start body", async () => {
  const fetcher = fetchStub(jsonResponse(START_BODY));
  const result = await startDeviceOnboarding({
    ...START_INPUT,
    fetchImpl: fetcher.fetchImpl,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.value, START_BODY);
  assert.equal(
    fetcher.calls[0]?.url,
    "https://api.closedloop.test/desktop/device-onboarding/start"
  );
  const sent = JSON.parse(String(fetcher.calls[0]?.init.body));
  assert.equal(sent.webAppOrigin, START_INPUT.webAppOrigin);
  assert.equal(sent.gatewayId, "gateway-1");
  assert.equal(sent.gatewayPublicKeyPem, START_INPUT.gatewayPublicKeyPem);
  assert.equal(sent.machineName, "test-machine");
  assert.equal(sent.platform, "darwin");
  assert.equal(sent.desktopVersion, "1.2.3");
  // The backend pins the protocol version.
  assert.equal(sent.desktopSecurityUpgradeProtocolVersion, 1);
});

test("startDeviceOnboarding defaults pollIntervalSeconds when the server omits it", async () => {
  const { pollIntervalSeconds: _omit, ...withoutInterval } = START_BODY;
  const fetcher = fetchStub(jsonResponse(withoutInterval));
  const result = await startDeviceOnboarding({
    ...START_INPUT,
    fetchImpl: fetcher.fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.pollIntervalSeconds, 5);
});

test("startDeviceOnboarding rejects a success body missing required fields", async () => {
  const fetcher = fetchStub(jsonResponse({ deviceSessionId: "only-id" }));
  const result = await startDeviceOnboarding({
    ...START_INPUT,
    fetchImpl: fetcher.fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error, "invalid");
});

test("startDeviceOnboarding maps contract error statuses", async () => {
  const cases: Array<{
    status: number;
    body: unknown;
    error: string;
    retryable: boolean;
  }> = [
    {
      status: 400,
      body: { code: "INVALID_DEVICE_SESSION_REQUEST", retryable: false },
      error: "bad_request",
      retryable: false,
    },
    {
      status: 429,
      body: { code: "DEVICE_SESSION_RATE_LIMITED", retryable: true },
      error: "rate_limited",
      retryable: true,
    },
    {
      status: 503,
      body: { code: "DEVICE_SESSION_PERSIST_FAILED", retryable: true },
      error: "unavailable",
      retryable: true,
    },
  ];

  for (const testCase of cases) {
    const fetcher = fetchStub(jsonResponse(testCase.body, testCase.status));
    const result = await startDeviceOnboarding({
      ...START_INPUT,
      fetchImpl: fetcher.fetchImpl,
    });
    assert.equal(result.ok, false, `status ${testCase.status}`);
    assert.equal(!result.ok && result.error, testCase.error);
    assert.equal(!result.ok && result.retryable, testCase.retryable);
  }
});

test("startDeviceOnboarding reports a retryable network error when fetch throws", async () => {
  const fetcher = fetchStub(() => {
    throw new Error("connection refused");
  });
  const result = await startDeviceOnboarding({
    ...START_INPUT,
    fetchImpl: fetcher.fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error, "network");
  assert.equal(!result.ok && result.retryable, true);
});

test("pollDeviceOnboarding posts the session id/secret and parses pending", async () => {
  const fetcher = fetchStub(jsonResponse({ status: "pending" }));
  const result = await pollDeviceOnboarding({
    apiOrigin: API_ORIGIN,
    deviceSessionId: "device-1",
    deviceSessionSecret: "secret-1",
    fetchImpl: fetcher.fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.value, { status: "pending" });
  assert.equal(
    fetcher.calls[0]?.url,
    "https://api.closedloop.test/desktop/device-onboarding/poll"
  );
  const sent = JSON.parse(String(fetcher.calls[0]?.init.body));
  assert.equal(sent.deviceSessionId, "device-1");
  assert.equal(sent.deviceSessionSecret, "secret-1");
});

test("pollDeviceOnboarding parses an approved decision with its fields", async () => {
  const approved = {
    status: "approved",
    onboardingAttemptId: "attempt-1",
    webAppOrigin: "https://app.closedloop.test",
    expiresAt: "2026-06-30T16:15:00.000Z",
  };
  const fetcher = fetchStub(jsonResponse(approved));
  const result = await pollDeviceOnboarding({
    apiOrigin: API_ORIGIN,
    deviceSessionId: "device-1",
    deviceSessionSecret: "secret-1",
    fetchImpl: fetcher.fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.value, approved);
});

test("pollDeviceOnboarding parses terminal denied/expired decisions", async () => {
  for (const status of ["denied", "expired"] as const) {
    const fetcher = fetchStub(jsonResponse({ status }));
    const result = await pollDeviceOnboarding({
      apiOrigin: API_ORIGIN,
      deviceSessionId: "device-1",
      deviceSessionSecret: "secret-1",
      fetchImpl: fetcher.fetchImpl,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.value, { status });
  }
});

test("pollDeviceOnboarding rejects an approved body missing fields", async () => {
  const fetcher = fetchStub(jsonResponse({ status: "approved" }));
  const result = await pollDeviceOnboarding({
    apiOrigin: API_ORIGIN,
    deviceSessionId: "device-1",
    deviceSessionSecret: "secret-1",
    fetchImpl: fetcher.fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error, "invalid");
});

test("pollDeviceOnboarding maps a 401 to a non-retryable invalid error", async () => {
  const fetcher = fetchStub(
    jsonResponse({ code: "DEVICE_SESSION_INVALID", retryable: false }, 401)
  );
  const result = await pollDeviceOnboarding({
    apiOrigin: API_ORIGIN,
    deviceSessionId: "device-1",
    deviceSessionSecret: "secret-1",
    fetchImpl: fetcher.fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error, "invalid");
  assert.equal(!result.ok && result.retryable, false);
});

test("pollDeviceOnboarding treats a 503 as retryable", async () => {
  const fetcher = fetchStub(
    jsonResponse({ code: "DEVICE_SESSION_POLL_FAILED", retryable: true }, 503)
  );
  const result = await pollDeviceOnboarding({
    apiOrigin: API_ORIGIN,
    deviceSessionId: "device-1",
    deviceSessionSecret: "secret-1",
    fetchImpl: fetcher.fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error, "unavailable");
  assert.equal(!result.ok && result.retryable, true);
});
