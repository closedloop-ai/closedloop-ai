import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopCommandEvent } from "../src/main/cloud-protocol.js";
import {
  type LoopCommandPreparationOptions,
  prepareLoopCommandForExecution,
} from "../src/main/loop-command-preparer.js";
import type { FetchLoopExecutionCredentialsOptions } from "../src/main/loop-execution-credentials-client.js";
import { SIGNED_LOOP_LAUNCH_MANAGED_KEY_ERROR } from "../src/main/signed-loop-launch-error.js";

test("preserves signed loop kill request body without fetching execution credentials", async () => {
  let fetchCalled = false;
  const killBody = {
    loopId: "loop-kill-1",
    userIntent: { action: "kill", reason: "user requested cancel" },
  };
  const command = buildLoopCommand({
    commandId: "019e09cc-0000-7000-8000-000000000001",
    path: "/api/gateway/symphony/loop/kill",
    body: killBody,
  });

  const prepared = await prepareLoopCommandForExecution(command, {
    ...buildOptions(),
    fetchExecutionCredentials: async () => {
      fetchCalled = true;
      return {};
    },
  });

  assert.equal(prepared, command);
  assert.equal(prepared.body, killBody);
  assert.equal(fetchCalled, false);
});

test("replaces signed loop launch body with one-shot execution credentials", async () => {
  const calls: FetchLoopExecutionCredentialsOptions[] = [];
  const credentials = {
    closedLoopAuthToken: "loop-jwt",
    apiBaseUrl: "https://api.example.test",
  };
  const command = buildLoopCommand({
    commandId: "019e09cc-0000-7000-8000-000000000002",
    path: "/api/gateway/symphony/loop",
    body: {
      loopId: "loop-launch-1",
      userIntent: { action: "launch", documentId: "doc-1" },
    },
  });

  const prepared = await prepareLoopCommandForExecution(command, {
    ...buildOptions(),
    fetchExecutionCredentials: async (options) => {
      calls.push(options);
      return credentials;
    },
  });

  assert.notEqual(prepared, command);
  assert.deepEqual(prepared.body, credentials);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.apiOrigin, "https://api.example.test");
  assert.equal(call.apiKey, "api-key");
  assert.equal(call.apiKeyProvenance, "DESKTOP_MANAGED");
  assert.equal(call.computeTargetId, "target-1");
  assert.equal(call.loopId, "loop-launch-1");
  assert.equal(call.commandId, command.commandId);
});

test("fails signed loop launch before credentials fetch for user-created keys", async () => {
  let fetchCalled = false;
  const command = buildLoopCommand({
    commandId: "019e09cc-0000-7000-8000-000000000003",
    path: "/api/gateway/symphony/loop",
    body: {
      loopId: "loop-launch-2",
      userIntent: { action: "launch", documentId: "doc-2" },
    },
  });

  await assert.rejects(
    () =>
      prepareLoopCommandForExecution(command, {
        ...buildOptions(),
        getApiKeyProvenance: () => "USER_CREATED",
        getManagedPopSigningReadiness: () => ({
          provenance: "USER_CREATED",
          signingReady: false,
          reason: "user_created_key",
        }),
        fetchExecutionCredentials: async () => {
          fetchCalled = true;
          return {};
        },
      }),
    { message: SIGNED_LOOP_LAUNCH_MANAGED_KEY_ERROR }
  );
  assert.equal(fetchCalled, false);
});

test("reports managed signing unavailability before failing signed loop launch", async () => {
  let fetchCalled = false;
  const reports: Array<{ surface: string; reason: string }> = [];
  const command = buildLoopCommand({
    commandId: "019e09cc-0000-7000-8000-000000000004",
    path: "/api/gateway/symphony/loop",
    body: {
      loopId: "loop-launch-3",
      userIntent: { action: "launch", documentId: "doc-3" },
    },
  });

  await assert.rejects(
    () =>
      prepareLoopCommandForExecution(command, {
        ...buildOptions(),
        getManagedPopSigningReadiness: () => ({
          provenance: "DESKTOP_MANAGED",
          signingReady: false,
          reason: "signing_unavailable",
        }),
        onDesktopPopUnavailable: (surface, reason) => {
          reports.push({ surface, reason });
        },
        fetchExecutionCredentials: async () => {
          fetchCalled = true;
          return {};
        },
      }),
    { message: SIGNED_LOOP_LAUNCH_MANAGED_KEY_ERROR }
  );
  assert.equal(fetchCalled, false);
  assert.deepEqual(reports, [
    {
      surface: "loop_execution_credentials",
      reason: "signing_unavailable",
    },
  ]);
});

function buildOptions(): LoopCommandPreparationOptions {
  return {
    getApiOrigin: () => "https://api.example.test",
    getApiKey: () => "api-key",
    getApiKeyProvenance: () => "DESKTOP_MANAGED",
    getManagedPopSigningReadiness: () => ({
      provenance: "DESKTOP_MANAGED",
      signingReady: true,
      reason: "ready",
    }),
    getComputeTargetId: () => "target-1",
  };
}

function buildLoopCommand(options: {
  commandId: string;
  path: DesktopCommandEvent["path"];
  body: unknown;
}): DesktopCommandEvent {
  return {
    protocolVersion: "1",
    messageId: `${options.commandId}-message`,
    timestamp: new Date().toISOString(),
    commandId: options.commandId,
    operationId: "loop.execute",
    method: "POST",
    path: options.path,
    query: {},
    body: options.body,
  };
}
