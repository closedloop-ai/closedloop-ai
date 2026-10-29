/**
 * PRD-721: every Branches read channel compiles `listQuery` before it reads.
 * Drives the REAL registrar and the REAL `withDb` over a store that fails any
 * use, so a channel that stopped compiling would answer a refused expression
 * with the store's failure (or an unfiltered read) instead of the refusal.
 */
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import {
  LIST_QUERY_EXPRESSION_PARAM,
  LIST_QUERY_EXPRESSION_VERSION,
  ListFilterOperator,
  ListQueryRefusal,
} from "@repo/api/src/types/list-query-expression";
import { BranchListField } from "@repo/api/src/types/list-query-fields";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { WithDb } from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import { createDbIpcHandlerWrappers } from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import type { DbHostAgentDatabase } from "../src/main/database/sqlite.js";
import {
  LOCAL_BRANCH_READ,
  SHARED_BRANCHES_IPC_CHANNELS,
  SHARED_BRANCHES_SOURCE_ERROR_CODE,
} from "../src/shared/shared-branches-contract.js";
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
const STORE_PROBE = "prd-721-branches-store-probe";

/** A local server-page read, so no channel warms the cloud org directory. */
const SERVER_PAGE = {
  ...LOCAL_BRANCH_READ,
  pageMode: BranchListPageMode.Server,
  limit: BRANCH_LIST_SERVER_PAGE_SIZE,
  offset: 0,
};
const SORTS = [
  {
    field: BranchListSortKey.Name,
    direction: BranchListSortDirection.Asc,
  },
];

/** Tags have no legacy spelling for "no tags": an unserved operator. */
const REFUSED = {
  ...SERVER_PAGE,
  [LIST_QUERY_EXPRESSION_PARAM]: {
    version: LIST_QUERY_EXPRESSION_VERSION,
    filters: [
      { field: BranchListField.Tags, operator: ListFilterOperator.IsEmpty },
    ],
    sorts: SORTS,
  },
};
const SERVED = {
  ...SERVER_PAGE,
  [LIST_QUERY_EXPRESSION_PARAM]: {
    version: LIST_QUERY_EXPRESSION_VERSION,
    filters: [
      {
        field: BranchListField.Repo,
        operator: ListFilterOperator.IsAnyOf,
        values: ["org/repo"],
      },
    ],
    sorts: SORTS,
  },
};
const REFUSAL_MESSAGE = `list query refused (${ListQueryRefusal.UnsupportedOperator})`;

const READ_CHANNELS = [
  SHARED_BRANCHES_IPC_CHANNELS.list,
  SHARED_BRANCHES_IPC_CHANNELS.usage,
  SHARED_BRANCHES_IPC_CHANNELS.analytics,
  SHARED_BRANCHES_IPC_CHANNELS.pageData,
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

describe("Branches read channels compile listQuery (PRD-721)", () => {
  it.each(READ_CHANNELS)(
    "%s refuses an expression it cannot serve",
    async (channel) => {
      expect(await readOutcome(channel, REFUSED)).toBe(REFUSAL_MESSAGE);
    }
  );

  it.each(READ_CHANNELS)(
    "%s reads a served expression from the store",
    async (channel) => {
      // The read reaches the store: it rejects with the store's failure, raw or
      // sanitized to the source error, or a read that degrades on it resolves.
      expect([STORE_PROBE, SHARED_BRANCHES_SOURCE_ERROR_CODE, ""]).toContain(
        await readOutcome(channel, SERVED)
      );
    }
  );
});

/**
 * A store whose every member fails. Its handles are copied by reference into
 * the branch sync source, so the coercion runs before any of them is used.
 */
function failingDatabase(): DbHostAgentDatabase {
  const failing = new Proxy(
    {},
    {
      get() {
        throw new Error(STORE_PROBE);
      },
    }
  );
  return {
    prisma: failing,
    syncSource: failing,
  } as unknown as DbHostAgentDatabase;
}

/** The read's rejection message, or `""` when it resolved. */
async function readOutcome(channel: string, request: unknown): Promise<string> {
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
