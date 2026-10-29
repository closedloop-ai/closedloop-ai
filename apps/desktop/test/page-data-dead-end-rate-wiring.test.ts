/**
 * ISS-12039 — the Sessions page reads through `pageData`, so its user-initiated
 * reads are the dead-end rate's `page_data` operations. This drives the REAL
 * registrar and the REAL `withDb` and observes the rate record, so dropping the
 * `instrumentIpcPerf` wrap from the channel turns it red.
 */
import assert from "node:assert/strict";
import { ReadInitiator } from "@repo/api/src/types/read-initiator";
import { afterAll, afterEach, beforeAll, beforeEach, it, vi } from "vitest";
import type { WithDb } from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import { createDbIpcHandlerWrappers } from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import type { DbHostAgentDatabase } from "../src/main/database/sqlite.js";
import { DesktopIpcOperation } from "../src/main/telemetry/app-otel-runtime-ipc.js";
import { recordIpcCall } from "../src/main/telemetry/dead-end-rate-record.js";
import { SHARED_AGENT_SESSIONS_IPC_CHANNELS } from "../src/shared/shared-agent-sessions-contract.js";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";
import {
  registeredInvokeHandler,
  resetElectronModuleStub,
} from "./helpers/electron-module-stub.js";

vi.mock("../src/main/telemetry/dead-end-rate-record.js", () => ({
  recordIpcCall: vi.fn(),
}));

const OPTIONS = {
  getWindow: () => null,
  isTrustedSender: () => true,
  onTerminalFailure: () => undefined,
  emitIpcPerf: () => undefined,
} as unknown as AgentDashboardDesignSystemRuntimeOptions;

const TRUSTED_EVENT = { sender: {} };

let mock: ElectronModuleMock;
let registerSharedSessionAndBranchIpcHandlers: (deps: {
  withDb: WithDb;
  options: AgentDashboardDesignSystemRuntimeOptions;
}) => void;

beforeAll(async () => {
  mock = registerElectronModuleMock();
  const shared = await import(
    "../src/main/dashboard/agent-dashboard-shared-read-ipc.js"
  );
  registerSharedSessionAndBranchIpcHandlers =
    shared.registerSharedSessionAndBranchIpcHandlers as typeof registerSharedSessionAndBranchIpcHandlers;
});

afterAll(() => {
  mock.deregister();
});

beforeEach(() => {
  vi.mocked(recordIpcCall).mockClear();
});

afterEach(() => {
  resetElectronModuleStub();
});

/** A database whose session store fails every read with a plain error. */
function failingDatabase(): DbHostAgentDatabase {
  return {
    get syncSource(): never {
      throw new Error("iss-12039-page-data-probe");
    },
  } as unknown as DbHostAgentDatabase;
}

async function readPageData(request: unknown): Promise<void> {
  const withDb = createDbIpcHandlerWrappers({
    getAgentDatabase: () => Promise.resolve(failingDatabase()),
    options: OPTIONS,
  }).withDb;
  registerSharedSessionAndBranchIpcHandlers({
    withDb,
    options: OPTIONS,
  });
  await Promise.resolve(
    registeredInvokeHandler(SHARED_AGENT_SESSIONS_IPC_CHANNELS.pageData)(
      TRUSTED_EVENT,
      request
    )
  ).catch(() => undefined);
}

it("records a user-initiated Sessions page read as page_data (ISS-12039)", async () => {
  await readPageData({ limit: 25, readInitiator: ReadInitiator.User });

  assert.deepEqual(vi.mocked(recordIpcCall).mock.calls, [
    [DesktopIpcOperation.PageData],
  ]);
});

it("records no background or old-shape Sessions page read", async () => {
  await readPageData({ limit: 25, readInitiator: ReadInitiator.Background });
  await readPageData({ limit: 25 });

  assert.deepEqual(vi.mocked(recordIpcCall).mock.calls, []);
});
