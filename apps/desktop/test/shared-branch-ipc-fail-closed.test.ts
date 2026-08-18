import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { encodeBranchId } from "@repo/api/src/types/branch";
import type { WithDb } from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import type { registerSharedSessionAndBranchIpcHandlers as RegisterSharedSessionAndBranchIpcHandlers } from "../src/main/dashboard/agent-dashboard-shared-read-ipc.js";
import type { DbHostAgentDatabase } from "../src/main/database/sqlite.js";
import {
  SHARED_BRANCHES_IPC_CHANNELS,
  SHARED_BRANCHES_SOURCE_ERROR_CODE,
} from "../src/shared/shared-branches-contract.js";
import { seeder, withAcDb } from "./branch-reads-ac-test-helpers.js";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";
import {
  registeredInvokeHandler,
  resetElectronModuleStub,
} from "./helpers/electron-module-stub.js";

const options: AgentDashboardDesignSystemRuntimeOptions = {
  getWindow: () => null,
  isTrustedSender: () => true,
  onTerminalFailure: () => undefined,
};

let electronMock: ElectronModuleMock;
let registerSharedHandlers: typeof RegisterSharedSessionAndBranchIpcHandlers;

before(async () => {
  electronMock = registerElectronModuleMock();
  const module = await import(
    "../src/main/dashboard/agent-dashboard-shared-read-ipc.js"
  );
  registerSharedHandlers = module.registerSharedSessionAndBranchIpcHandlers;
});

afterEach(() => {
  resetElectronModuleStub();
});

after(() => {
  electronMock.deregister();
});

test("ISS-5828: production Branch IPC registration fails closed without cloud hydration", () =>
  withAcDb(async (db) => {
    const seed = seeder(db);
    await seed.session("session-ipc-fail-closed");
    for (const branch of ["main", "feature/eligible"]) {
      const artifactId = await seed.branch({ branch, repo: "acme/web" });
      await seed.link({
        session: "session-ipc-fail-closed",
        artifactId,
        method: "git_push",
      });
    }

    registerSharedHandlers({
      withDb: makeWithDb(db),
      options,
      cloudHydration: undefined,
    });

    const defaultId = encodeBranchId({
      repoFullName: "acme/web",
      branchName: "main",
    });
    const calls = [
      [SHARED_BRANCHES_IPC_CHANNELS.list, {}],
      [SHARED_BRANCHES_IPC_CHANNELS.pageData, {}],
      [SHARED_BRANCHES_IPC_CHANNELS.usage, {}],
      [SHARED_BRANCHES_IPC_CHANNELS.analytics, {}],
      [SHARED_BRANCHES_IPC_CHANNELS.detail, defaultId],
    ] as const;

    for (const [channel, input] of calls) {
      await assert.rejects(
        invoke(channel, input),
        isBranchSourceError,
        `${channel} must reject when eligibility authority is unavailable`
      );
    }
    const trace = await invoke(SHARED_BRANCHES_IPC_CHANNELS.trace, defaultId);
    assert.deepEqual(readArray(trace, "sessions"), []);
  }));

function makeWithDb(agentDatabase: DbHostAgentDatabase): WithDb {
  return (handler) =>
    async (_event, ...args) =>
      await handler(agentDatabase, ...args);
}

async function invoke(channel: string, value: unknown): Promise<unknown> {
  return await registeredInvokeHandler(channel)({ sender: null }, value);
}

function isBranchSourceError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === SHARED_BRANCHES_SOURCE_ERROR_CODE
  );
}

function readArray(value: unknown, key: string): unknown[] {
  if (value === null || typeof value !== "object") {
    throw new TypeError(`Expected object containing ${key}`);
  }
  const result = Reflect.get(value, key);
  if (!Array.isArray(result)) {
    throw new TypeError(`Expected array at ${key}`);
  }
  return result;
}
