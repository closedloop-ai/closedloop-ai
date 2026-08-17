/**
 * @file shared-read-ipc-parity-scope.test.ts
 * @description ISS-4556 — the PRODUCTION WIRING for the displayed-status parity
 * scope: that `registerSharedSessionAndBranchIpcHandlers` actually opens
 * {@link withDisplayedStatusParityScope} around each of the four Sessions read
 * channels that serve a multi-row cohort.
 *
 * WHY A SEPARATE SUITE. `withDisplayedStatusParityScope` itself is unit-tested
 * (`shared-agent-sessions-status-facet.test.ts`) by calling it directly with a
 * hand-written callback, which proves the primitive pins a decision but proves
 * nothing about where it is installed — and the placement IS the fix. Deleting
 * all four `withDisplayedStatusParityScope(...)` wrappers from
 * `agent-dashboard-shared-read-ipc.ts` left `pnpm test:node` entirely green.
 * With the Labs flag ON, that unwrapped `pageData` handler resolves the gate
 * once per row in `mapListItem`, once per row in `matchesStatusFilter`, once per
 * sort comparison, and once in `buildUsageStatusPredicate`; a settings-store
 * resolver that throws transiently mid-fold (swallowed to `false` by the gate)
 * then yields ONE page where rows folded before the throw badge `Stale`/
 * `Waiting` and rows after it badge a raw `active`, ranked 0 against 4 under a
 * single Status header click. That is the per-read incoherence the scope exists
 * to remove, and nothing detected its absence.
 *
 * HOW. The registrar imports `ipcMain` from `electron` at module scope, so it is
 * reached through the ISS-4845 electron-module mock and driven as the renderer
 * drives it: register, then invoke the recorded handler.
 *
 * The observation point is a GETTER on `agentDatabase.syncSource`. Every one of
 * the four handlers evaluates `agentDatabase.syncSource` as an argument INSIDE
 * the callback handed to the scope, so the getter fires in the scope when the
 * wrapper is present and outside it when the wrapper is gone — and it reads the
 * gate from exactly where the real leaves (`mapListItem`, `matchesStatusFilter`,
 * `sessionSortKey`, `buildUsageStatusPredicate`) read it. It then throws, so no
 * case needs a real SQLite store to prove where the boundary sits.
 *
 * The resolver is deliberately NOT constant: it answers `true` once and `false`
 * forever after. Scoped, the scope entry consumes that single answer and pins
 * it, so both probe reads are `true` and the resolver is consulted exactly ONCE
 * no matter how many leaves read the gate. Unscoped, each read re-resolves and
 * the two disagree — which is the production symptom itself, not a proxy for it.
 * A constant resolver would pass in both worlds.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import type { WithDb } from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import type { DbHostAgentDatabase } from "../src/main/database/sqlite.js";
import {
  isDisplayedStatusParityEnabled,
  setDisplayedStatusParityResolver,
} from "../src/main/session/displayed-status-parity-gate.js";
import { SHARED_AGENT_SESSIONS_IPC_CHANNELS } from "../src/shared/shared-agent-sessions-contract.js";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";
import {
  registeredInvokeHandler,
  resetElectronModuleStub,
} from "./helpers/electron-module-stub.js";

/**
 * Thrown by the probe getter to abandon the handler the instant it has read the
 * gate. Distinct text so a case cannot mistake an unrelated failure (a missing
 * handler, a real store call) for the probe having run.
 */
const PROBE_SENTINEL = "displayed-status-parity-scope-probe";
const PROBE_SENTINEL_RE = /displayed-status-parity-scope-probe/;

/**
 * The four Sessions read channels that serve a MULTI-ROW cohort and must
 * therefore resolve the gate once for the whole read.
 *
 * `detail` is deliberately absent: it maps exactly one row, so it has no
 * intra-read cohort to keep coherent (see the gate module's docstring).
 */
const SCOPED_CHANNELS = [
  SHARED_AGENT_SESSIONS_IPC_CHANNELS.list,
  SHARED_AGENT_SESSIONS_IPC_CHANNELS.usage,
  SHARED_AGENT_SESSIONS_IPC_CHANNELS.analytics,
  SHARED_AGENT_SESSIONS_IPC_CHANNELS.pageData,
] as const;

/**
 * The host options the registrar requires. `emitIpcPerf` is left unwired so
 * `instrumentIpcPerf` passes straight through to the handler, and no API
 * key/origin is wired so the org-directory warm-up returns without a fetch —
 * both keep the case about the scope and nothing else.
 */
const STUB_OPTIONS: AgentDashboardDesignSystemRuntimeOptions = {
  getWindow: () => null,
  isTrustedSender: () => true,
  onTerminalFailure: () => undefined,
};

let mock: ElectronModuleMock;
let registerSharedSessionAndBranchIpcHandlers: (deps: {
  withDb: WithDb;
  options: AgentDashboardDesignSystemRuntimeOptions;
  cloudHydration: undefined;
}) => void;

before(async () => {
  mock = registerElectronModuleMock();
  // Dynamic, because the redirect must be installed before the registrar
  // evaluates its `import { ipcMain } from "electron"`.
  const module = await import(
    "../src/main/dashboard/agent-dashboard-shared-read-ipc.js"
  );
  registerSharedSessionAndBranchIpcHandlers =
    module.registerSharedSessionAndBranchIpcHandlers as typeof registerSharedSessionAndBranchIpcHandlers;
});

after(() => {
  mock.deregister();
});

afterEach(() => {
  resetElectronModuleStub();
  // Fail CLOSED again, so a later suite in this process inherits the module's
  // documented default rather than this suite's alternating probe.
  setDisplayedStatusParityResolver(() => false);
});

describe("shared Sessions read IPC opens the displayed-status parity scope (ISS-4556)", () => {
  for (const channel of SCOPED_CHANNELS) {
    it(`pins ONE gate decision for the whole ${channel} read`, async () => {
      const { reads, resolverCalls, invoke } = armChannel(channel);

      // Asserted, not swallowed: the rejection is what proves the probe ran, so
      // no case can pass on an empty `reads` array.
      await assert.rejects(invoke, PROBE_SENTINEL_RE, `${channel} reaches`);

      // Both reads came from inside the handler and saw the SAME decision. With
      // the wrapper removed the first is `true` and the second `false`.
      assert.deepEqual(
        reads,
        [true, true],
        `${channel} must serve one pinned decision to every leaf that reads the gate`
      );
      // ...and it was resolved ONCE for the read, not once per leaf.
      assert.equal(
        resolverCalls(),
        1,
        `${channel} must consult the settings-store resolver exactly once per read`
      );
    });
  }
});

/**
 * The agent database the registrar hands each handler. `syncSource` is a getter
 * rather than a value because the property ACCESS is the probe: it is evaluated
 * as an argument inside the scoped callback, so it observes the gate from the
 * same position the real leaves do.
 */
function probeDatabase(reads: boolean[]): DbHostAgentDatabase {
  return {
    get syncSource(): never {
      reads.push(
        isDisplayedStatusParityEnabled(),
        isDisplayedStatusParityEnabled()
      );
      throw new Error(PROBE_SENTINEL);
    },
  } as unknown as DbHostAgentDatabase;
}

/** The `withDb` wrapper the composition root supplies, minus auth and the store. */
function makeWithDb(agentDatabase: DbHostAgentDatabase): WithDb {
  return (handler) =>
    async (_event, ...args) =>
      await handler(agentDatabase, ...args);
}

/**
 * Register the REAL handlers over the probe database and hand back the recorded
 * channel, ready to invoke exactly as the renderer's `ipcRenderer.invoke` does.
 * Every assertion stays in the test body.
 */
function armChannel(channel: string): {
  reads: boolean[];
  resolverCalls: () => number;
  invoke: () => Promise<unknown>;
} {
  const reads: boolean[] = [];
  let resolverCalls = 0;
  setDisplayedStatusParityResolver(() => {
    resolverCalls += 1;
    return resolverCalls === 1;
  });
  registerSharedSessionAndBranchIpcHandlers({
    withDb: makeWithDb(probeDatabase(reads)),
    options: STUB_OPTIONS,
    cloudHydration: undefined,
  });
  const handler = registeredInvokeHandler(channel);
  return {
    reads,
    resolverCalls: () => resolverCalls,
    invoke: async () => await handler({ sender: null }, {}),
  };
}
