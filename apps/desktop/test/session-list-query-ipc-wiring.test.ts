/**
 * ISS-9479 — every Sessions read channel compiles `listQuery` before it reads.
 * Drives the REAL registrar and the REAL `withDb` over a store that fails any
 * use, so a channel that stopped compiling would answer a refused expression
 * with the store's failure (or an unfiltered read) instead of the refusal.
 */
import {
  LIST_QUERY_EXPRESSION_PARAM,
  LIST_QUERY_EXPRESSION_VERSION,
  ListFilterOperator,
  ListQueryRefusal,
} from "@repo/api/src/types/list-query-expression";
import { SessionListField } from "@repo/api/src/types/list-query-fields";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { WithDb } from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import { createDbIpcHandlerWrappers } from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import type { DbHostAgentDatabase } from "../src/main/database/sqlite.js";
import { SHARED_AGENT_SESSIONS_IPC_CHANNELS } from "../src/shared/shared-agent-sessions-contract.js";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";
import {
  registeredInvokeHandler,
  resetElectronModuleStub,
} from "./helpers/electron-module-stub.js";

const OPTIONS = {
  getWindow: () => null,
  isTrustedSender: () => true,
  onTerminalFailure: () => undefined,
  emitIpcPerf: () => undefined,
} as unknown as AgentDashboardDesignSystemRuntimeOptions;

const TRUSTED_EVENT = { sender: {} };
const STORE_PROBE = "iss-9479-store-probe";

/** The desktop declares no project facet: a cloud-only capability gap. */
const REFUSED = {
  [LIST_QUERY_EXPRESSION_PARAM]: {
    version: LIST_QUERY_EXPRESSION_VERSION,
    filters: [
      {
        field: SessionListField.ProjectIds,
        operator: ListFilterOperator.IsAnyOf,
        values: ["project-1"],
      },
    ],
  },
};
const SERVED = {
  [LIST_QUERY_EXPRESSION_PARAM]: {
    version: LIST_QUERY_EXPRESSION_VERSION,
    filters: [
      {
        field: SessionListField.Repo,
        operator: ListFilterOperator.IsAnyOf,
        values: ["org/repo"],
      },
    ],
  },
};
const REFUSAL_MESSAGE = `list query refused (${ListQueryRefusal.UnsupportedField})`;

const READ_CHANNELS = [
  SHARED_AGENT_SESSIONS_IPC_CHANNELS.list,
  SHARED_AGENT_SESSIONS_IPC_CHANNELS.usage,
  SHARED_AGENT_SESSIONS_IPC_CHANNELS.analytics,
  SHARED_AGENT_SESSIONS_IPC_CHANNELS.pageData,
];

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

afterEach(() => {
  resetElectronModuleStub();
});

describe("Sessions read channels compile listQuery (ISS-9479)", () => {
  it.each(READ_CHANNELS)(
    "%s refuses an expression it cannot serve",
    async (channel) => {
      expect(await readRejection(channel, REFUSED)).toBe(REFUSAL_MESSAGE);
    }
  );

  it.each(READ_CHANNELS)(
    "%s reads a served expression from the store",
    async (channel) => {
      expect(await readRejection(channel, SERVED)).toBe(STORE_PROBE);
    }
  );
});

/** A store whose every member fails, so a read that reaches it rejects. */
function failingDatabase(): DbHostAgentDatabase {
  const failing = new Proxy(
    {},
    {
      get() {
        throw new Error(STORE_PROBE);
      },
    }
  );
  return { syncSource: failing } as unknown as DbHostAgentDatabase;
}

/** The read's rejection message, or `""` when it resolved. */
async function readRejection(
  channel: string,
  request: unknown
): Promise<string> {
  const withDb = createDbIpcHandlerWrappers({
    getAgentDatabase: () => Promise.resolve(failingDatabase()),
    options: OPTIONS,
  }).withDb;
  registerSharedSessionAndBranchIpcHandlers({
    withDb,
    options: OPTIONS,
  });
  try {
    await registeredInvokeHandler(channel)(TRUSTED_EVENT, request);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
