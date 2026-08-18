import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { vi } from "vitest";
import {
  AgentMonitorIpcChannel,
  type AgentMonitorIpcDeps,
  registerAgentMonitorIpcHandlers,
} from "../src/main/ipc/agent-monitor-ipc.js";
import {
  RuntimeInfoIpcChannel,
  type RuntimeInfoIpcDeps,
  registerRuntimeInfoIpcHandlers,
} from "../src/main/ipc/runtime-info-ipc.js";

// FEA-3639 review: both new IPC gates (GetRuntimeStatus, which exposes
// file-access-block paths; ReimportAgentSessions, which restarts collectors)
// must reject an untrusted sender BEFORE reaching their side effect, per
// apps/desktop/AGENTS.md ("IPC handlers rejecting untrusted senders" → behavioral
// test: invoke the handler and assert the effect). These registrars are now
// electron-free (their app/hooks deps are injected), so they load under
// test:node and their gates can be driven directly.

type IpcHandler = (event: unknown, payload?: unknown) => unknown;

// An IPC event whose `sender` the module's predicate will reject.
const UNTRUSTED_EVENT = { sender: {} };
const UNTRUSTED_SENDER_ERROR = /untrusted sender/;

function registerHandler(
  register: (registrar: {
    handle: (channel: string, listener: IpcHandler) => void;
  }) => void
): Map<string, IpcHandler> {
  const handlers = new Map<string, IpcHandler>();
  register({
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
  });
  return handlers;
}

// Only `isTrustedSender` + the asserted side-effect deps matter on the untrusted
// path — the gate throws before the rest are read. A partial fixture cast fills
// the remainder (AGENTS.md sanctions `as` on impractical-to-build test shapes).
function makeRuntimeInfoDeps(
  overrides: Partial<RuntimeInfoIpcDeps>
): RuntimeInfoIpcDeps {
  return { isTrustedSender: () => false, ...(overrides as RuntimeInfoIpcDeps) };
}

function makeAgentMonitorDeps(
  overrides: Partial<AgentMonitorIpcDeps>
): AgentMonitorIpcDeps {
  return {
    isTrustedSender: () => false,
    ...(overrides as AgentMonitorIpcDeps),
  };
}

describe("runtime-info IPC sender gate (FEA-3639)", () => {
  test("GetRuntimeStatus rejects an untrusted sender before reading file-access blocks", () => {
    const getFileAccessBlocks = vi.fn(() => []);
    const getAppVersion = vi.fn(() => "0.0.0");
    const handlers = registerHandler((registrar) =>
      registerRuntimeInfoIpcHandlers(
        registrar,
        makeRuntimeInfoDeps({ getFileAccessBlocks, getAppVersion })
      )
    );

    const handler = handlers.get(RuntimeInfoIpcChannel.GetRuntimeStatus);
    assert.ok(handler, "GetRuntimeStatus handler must be registered");
    // If the gate were removed the handler would build the payload (calling
    // getFileAccessBlocks) instead of throwing the untrusted-sender error.
    assert.throws(() => handler(UNTRUSTED_EVENT), UNTRUSTED_SENDER_ERROR);
    assert.equal(getFileAccessBlocks.mock.calls.length, 0);
    assert.equal(getAppVersion.mock.calls.length, 0);
  });
});

describe("agent-monitor IPC sender gate (FEA-3639)", () => {
  test("ReimportAgentSessions rejects an untrusted sender before restarting collectors", () => {
    const restartCollectors = vi.fn(() => {});
    const handlers = registerHandler((registrar) =>
      registerAgentMonitorIpcHandlers(
        registrar,
        makeAgentMonitorDeps({ restartCollectors })
      )
    );

    const handler = handlers.get(AgentMonitorIpcChannel.ReimportAgentSessions);
    assert.ok(handler, "ReimportAgentSessions handler must be registered");
    assert.throws(() => handler(UNTRUSTED_EVENT), UNTRUSTED_SENDER_ERROR);
    assert.equal(restartCollectors.mock.calls.length, 0);
  });

  test("ReimportAgentSessions restarts collectors for a trusted sender", () => {
    // Positive control so the gate test cannot pass vacuously: a trusted sender
    // reaches the side effect and its returned promise flows back through invoke.
    const restartCollectors = vi.fn(() => Promise.resolve());
    const handlers = registerHandler((registrar) =>
      registerAgentMonitorIpcHandlers(
        registrar,
        makeAgentMonitorDeps({
          restartCollectors,
          isTrustedSender: () => true,
        })
      )
    );

    const handler = handlers.get(AgentMonitorIpcChannel.ReimportAgentSessions);
    assert.ok(handler, "ReimportAgentSessions handler must be registered");
    const result = handler(UNTRUSTED_EVENT);
    assert.equal(restartCollectors.mock.calls.length, 1);
    assert.ok(
      result instanceof Promise,
      "the handler must return the restart promise so invoke awaits it"
    );
  });
});
