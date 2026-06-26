import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  DESKTOP_POP_GATEWAY_ID_HEADER,
  DESKTOP_POP_SIGNATURE_HEADER,
  DESKTOP_POP_TIMESTAMP_HEADER,
  DesktopPopUnavailableError,
} from "../src/main/desktop-pop.js";
import {
  type FetchLoopExecutionCredentialsOptions,
  fetchLoopExecutionCredentials,
} from "../src/main/loop-execution-credentials-client.js";
import { SIGNED_LOOP_LAUNCH_MANAGED_KEY_ERROR } from "../src/main/signed-loop-launch-error.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("fetchLoopExecutionCredentials attaches required managed PoP headers", async () => {
  let observedInit: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => {
    observedInit = init;
    return new Response(
      JSON.stringify({ success: true, data: { closedLoopAuthToken: "jwt" } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const credentials = await fetchLoopExecutionCredentials({
    ...buildOptions(),
    signDesktopRequest: () => ({
      [DESKTOP_POP_GATEWAY_ID_HEADER]: "gateway-1",
      [DESKTOP_POP_TIMESTAMP_HEADER]: "123",
      [DESKTOP_POP_SIGNATURE_HEADER]: "signature",
    }),
  });

  assert.deepEqual(credentials, { closedLoopAuthToken: "jwt" });
  assert.ok(observedInit);
  const headers = observedInit.headers as Record<string, string>;
  assert.equal(headers[DESKTOP_POP_GATEWAY_ID_HEADER], "gateway-1");
  assert.equal(headers[DESKTOP_POP_TIMESTAMP_HEADER], "123");
  assert.equal(headers[DESKTOP_POP_SIGNATURE_HEADER], "signature");
});

test("fetchLoopExecutionCredentials hard-fails before fetch when signer throws", async () => {
  let fetchCalled = false;
  const reports: Array<{ surface: string; reason: string }> = [];
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response("{}");
  };

  await assert.rejects(
    () =>
      fetchLoopExecutionCredentials({
        ...buildOptions(),
        signDesktopRequest: () => {
          throw new DesktopPopUnavailableError("missing_private_key");
        },
        onDesktopPopUnavailable: (surface, reason) => {
          reports.push({ surface, reason });
        },
      }),
    { message: SIGNED_LOOP_LAUNCH_MANAGED_KEY_ERROR }
  );

  assert.equal(fetchCalled, false);
  assert.deepEqual(reports, [
    {
      surface: "loop_execution_credentials",
      reason: "missing_private_key",
    },
  ]);
});

test("fetchLoopExecutionCredentials hard-fails before fetch when signer returns null", async () => {
  let fetchCalled = false;
  const reports: Array<{ surface: string; reason: string }> = [];
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response("{}");
  };

  await assert.rejects(
    () =>
      fetchLoopExecutionCredentials({
        ...buildOptions(),
        signDesktopRequest: () => null,
        onDesktopPopUnavailable: (surface, reason) => {
          reports.push({ surface, reason });
        },
      }),
    { message: SIGNED_LOOP_LAUNCH_MANAGED_KEY_ERROR }
  );

  assert.equal(fetchCalled, false);
  assert.deepEqual(reports, [
    {
      surface: "loop_execution_credentials",
      reason: "sign_failed_or_null",
    },
  ]);
});

function buildOptions(): FetchLoopExecutionCredentialsOptions {
  return {
    apiOrigin: "https://api.example.test",
    apiKey: "api-key",
    apiKeyProvenance: "DESKTOP_MANAGED",
    computeTargetId: "target-1",
    loopId: "loop-1",
    commandId: "019e09cc-0000-7000-8000-000000000010",
  };
}
