import assert from "node:assert/strict";
import { Priority } from "@repo/api/src/types/common";
import { afterAll, beforeAll, test, vi } from "vitest";
import {
  LOCAL_BRANCH_PRIORITY_WRITE_CHANNEL,
  LOCAL_SESSION_PRIORITY_WRITE_CHANNEL,
  type LocalPriorityWriteRequest,
  type LocalPriorityWriteResult,
  LocalPriorityWriteStatus,
} from "../src/shared/local-priority-write-contract.js";
import {
  type ElectronModuleMock,
  registerElectronPreloadMock,
} from "./helpers/electron-module-mock.js";

/**
 * ISS-9491 — the PRELOAD hop of the Desktop local priority write:
 * `window.desktopApi.{agentSessionsApi,branchesApi}.updatePriority` →
 * `ipcRenderer.invoke`. The renderer source and the main handler each have
 * suites; this hop had channel-name coverage only, so a bridge that rebuilt the
 * request and lost `expectedPriority` — or turned its `null` ("holds none")
 * into an absent key (unguarded) — would ship every local edit as a
 * last-write-wins write that no other suite notices. The answer travels back
 * through the same hop: a bridge that dropped the store's `stale` result would
 * leave the renderer source nothing to turn into the 409 the cell rolls back on.
 */

type UpdatePriority = (request: LocalPriorityWriteRequest) => Promise<unknown>;

const GUARDED_UNSET: LocalPriorityWriteRequest = {
  id: "iss9491-session",
  priority: Priority.High,
  expectedPriority: null,
};
const GUARDED_SET: LocalPriorityWriteRequest = {
  id: "owner%2Frepo::iss9491",
  priority: null,
  expectedPriority: Priority.Low,
};
const UNGUARDED: LocalPriorityWriteRequest = {
  id: "iss9491-session",
  priority: Priority.Urgent,
};

let electronMock: ElectronModuleMock;
let rendererIpc: RendererIpc;
let api: PriorityBridges;
let sessionArgs: unknown[][];
let branchArgs: unknown[][];

beforeAll(async () => {
  electronMock = registerElectronPreloadMock();
  const stub = await import("./helpers/electron-module-stub.js");
  stub.resetElectronModuleStub();
  await import("../src/main/preload-design-system.js");
  rendererIpc = stub.ipcRenderer;
  api = stub.exposedMainWorldApi("desktopApi") as PriorityBridges;
  await api.agentSessionsApi.updatePriority(GUARDED_UNSET);
  await api.agentSessionsApi.updatePriority(UNGUARDED);
  await api.branchesApi.updatePriority(GUARDED_SET);
  sessionArgs = stub.rendererInvokeArgsFor(
    LOCAL_SESSION_PRIORITY_WRITE_CHANNEL
  );
  branchArgs = stub.rendererInvokeArgsFor(LOCAL_BRANCH_PRIORITY_WRITE_CHANNEL);
}, 300_000);

afterAll(() => {
  electronMock.deregister();
});

test("ISS-9491: the session bridge forwards the guard as sent — null stays a guard, absent stays absent", () => {
  // Strict deep equality: `{ expectedPriority: undefined }` does not equal an
  // absent key, and `undefined` does not equal `null`.
  assert.deepEqual(sessionArgs, [[GUARDED_UNSET], [UNGUARDED]]);
});

test("ISS-9491: the branch bridge forwards the guard on its own channel", () => {
  assert.deepEqual(branchArgs, [[GUARDED_SET]]);
});

test("ISS-9491: both bridges resolve the main handler's stale refusal unchanged", async () => {
  // The stub's own `invoke` answers `undefined` on purpose; this case needs the
  // main handler's refusal to come back through the real bridge.
  const invoke = vi.spyOn(rendererIpc, "invoke").mockResolvedValue(STALE);
  try {
    assert.deepEqual(
      await api.agentSessionsApi.updatePriority(GUARDED_UNSET),
      STALE
    );
    assert.deepEqual(await api.branchesApi.updatePriority(GUARDED_SET), STALE);
    assert.deepEqual(
      invoke.mock.calls.map(([channel]) => channel),
      [
        LOCAL_SESSION_PRIORITY_WRITE_CHANNEL,
        LOCAL_BRANCH_PRIORITY_WRITE_CHANNEL,
      ]
    );
  } finally {
    invoke.mockRestore();
  }
});

const STALE: LocalPriorityWriteResult = {
  status: LocalPriorityWriteStatus.Stale,
};

type PriorityBridges = {
  agentSessionsApi: { updatePriority: UpdatePriority };
  branchesApi: { updatePriority: UpdatePriority };
};
type RendererIpc = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
};
