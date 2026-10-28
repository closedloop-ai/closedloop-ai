/**
 * @file agent-dashboard-disabled-ipc.test.ts
 * @description Regression for disabled responder installation. The boot and
 * shutdown paths must install disabled responders
 * WITHOUT colliding with already-registered live handlers (Electron's
 * ipcMain.handle throws on a second registration for a channel).
 *
 * installDisabledAgentDashboardDbIpcHandlers removes each handler before
 * (re)registering, so it is collision-safe. A fake registrar mirrors Electron's
 * throw-on-duplicate behavior to prove it.
 */
import assert from "node:assert/strict";
import {
  BranchTraceUnavailableReason,
  unavailableBranchTraceResult,
} from "@repo/api/src/types/branch-trace.js";
import {
  ConvertFailureClass,
  makeConvertInstallErrorOutcome,
} from "@repo/api/src/types/convert-install.js";
import { test } from "vitest";
import {
  CATALOG_CONVERT_INSTALL_CHANNEL,
  DESIGN_SYSTEM_DB_IPC_CHANNELS,
  type IpcHandleRegistrar,
  installDisabledAgentDashboardDbIpcHandlers,
} from "../src/main/dashboard/agent-dashboard-ipc-contract.js";
import {
  emptySharedAgentSessionsAnalytics,
  emptySharedAgentSessionsListResponse,
  emptySharedAgentSessionsUsageSummary,
  SHARED_AGENT_SESSIONS_IPC_CHANNEL_LIST,
  SHARED_AGENT_SESSIONS_IPC_CHANNELS,
} from "../src/shared/shared-agent-sessions-contract.js";
import {
  emptySharedBranchesAnalytics,
  emptySharedBranchesListResponse,
  emptySharedBranchesUsageSummary,
  SHARED_BRANCHES_IPC_CHANNEL_LIST,
  SHARED_BRANCHES_IPC_CHANNELS,
} from "../src/shared/shared-branches-contract.js";
import { THREAD_VIEWED_CHANNEL } from "../src/shared/thread-viewership-contract.js";

type Listener = (event: unknown, ...args: unknown[]) => unknown;

function makeFakeRegistrar(): {
  registrar: IpcHandleRegistrar;
  handlers: Map<string, Listener>;
} {
  const handlers = new Map<string, Listener>();
  const registrar: IpcHandleRegistrar = {
    handle(channel, listener) {
      if (handlers.has(channel)) {
        // Mirror Electron: a second handle() for the same channel throws.
        throw new Error(
          `Attempted to register a second handler for '${channel}'`
        );
      }
      handlers.set(channel, listener);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
  };
  return { registrar, handlers };
}

function invokeDisabled(
  handlers: Map<string, Listener>,
  channel: string,
  ...args: unknown[]
): unknown {
  const listener = handlers.get(channel);
  if (!listener) {
    throw new Error(`missing disabled handler for ${channel}`);
  }
  return listener(undefined, ...args);
}

test("installs disabled DB IPC responders for every design-system channel", () => {
  const { registrar, handlers } = makeFakeRegistrar();
  installDisabledAgentDashboardDbIpcHandlers(registrar);
  for (const channel of DESIGN_SYSTEM_DB_IPC_CHANNELS) {
    assert.ok(handlers.has(channel), `missing disabled handler for ${channel}`);
  }
});

test("is collision-safe when live handlers are already registered", () => {
  const { registrar, handlers } = makeFakeRegistrar();
  // Simulate the live handlers installed by a successfully started runtime.
  for (const channel of DESIGN_SYSTEM_DB_IPC_CHANNELS) {
    registrar.handle(channel, () => "live");
  }

  // The real bug: without removeHandler-first this throws on the first channel.
  assert.doesNotThrow(() =>
    installDisabledAgentDashboardDbIpcHandlers(registrar)
  );

  // The disabled responder replaced the live handler rather than colliding.
  const sample = DESIGN_SYSTEM_DB_IPC_CHANNELS[0];
  const listener = handlers.get(sample);
  assert.ok(listener);
  assert.notEqual(listener?.(undefined), "live");
});

test("installs disabled shared-branches responders returning canonical empty/null", () => {
  const { registrar, handlers } = makeFakeRegistrar();
  installDisabledAgentDashboardDbIpcHandlers(registrar);

  for (const channel of SHARED_BRANCHES_IPC_CHANNEL_LIST) {
    assert.ok(handlers.has(channel), `missing disabled handler for ${channel}`);
  }
  assert.deepEqual(
    handlers.get(SHARED_BRANCHES_IPC_CHANNELS.list)?.(undefined),
    emptySharedBranchesListResponse()
  );
  assert.deepEqual(
    handlers.get(SHARED_BRANCHES_IPC_CHANNELS.usage)?.(undefined),
    emptySharedBranchesUsageSummary()
  );
  assert.deepEqual(
    handlers.get(SHARED_BRANCHES_IPC_CHANNELS.analytics)?.(undefined),
    emptySharedBranchesAnalytics()
  );
  assert.equal(
    handlers.get(SHARED_BRANCHES_IPC_CHANNELS.cohortAnalytics)?.(undefined),
    null
  );
  assert.equal(
    handlers.get(SHARED_BRANCHES_IPC_CHANNELS.detail)?.(undefined),
    null
  );
  // Disabled trace reads preserve explicit unavailable completeness.
  assert.deepEqual(
    handlers.get(SHARED_BRANCHES_IPC_CHANNELS.trace)?.(undefined),
    unavailableBranchTraceResult([], BranchTraceUnavailableReason.Unknown)
  );
});

test("installs disabled shared-session responders returning canonical empty/null", () => {
  const { registrar, handlers } = makeFakeRegistrar();
  installDisabledAgentDashboardDbIpcHandlers(registrar);

  for (const channel of SHARED_AGENT_SESSIONS_IPC_CHANNEL_LIST) {
    assert.ok(handlers.has(channel), `missing disabled handler for ${channel}`);
  }
  assert.deepEqual(
    handlers.get(SHARED_AGENT_SESSIONS_IPC_CHANNELS.list)?.(undefined),
    emptySharedAgentSessionsListResponse()
  );
  assert.deepEqual(
    handlers.get(SHARED_AGENT_SESSIONS_IPC_CHANNELS.usage)?.(undefined),
    emptySharedAgentSessionsUsageSummary()
  );
  assert.deepEqual(
    handlers.get(SHARED_AGENT_SESSIONS_IPC_CHANNELS.analytics)?.(undefined),
    emptySharedAgentSessionsAnalytics()
  );
  assert.equal(
    handlers.get(SHARED_AGENT_SESSIONS_IPC_CHANNELS.detail)?.(undefined),
    null
  );
  // ISS-9857: the events page fails closed like the detail it continues.
  assert.equal(
    handlers.get(SHARED_AGENT_SESSIONS_IPC_CHANNELS.events)?.(undefined),
    null
  );
});

test("replaces already-registered live branch handlers after a startup failure", () => {
  const { registrar, handlers } = makeFakeRegistrar();
  // Simulate a path that needs to recover while live branch handlers are still
  // registered, then install the disabled responders.
  for (const channel of SHARED_BRANCHES_IPC_CHANNEL_LIST) {
    registrar.handle(channel, () => "live-branch");
  }

  assert.doesNotThrow(() =>
    installDisabledAgentDashboardDbIpcHandlers(registrar)
  );

  // The disabled responder replaced the live branch handler rather than
  // colliding — the list channel now returns the empty canonical response.
  assert.deepEqual(
    handlers.get(SHARED_BRANCHES_IPC_CHANNELS.list)?.(undefined),
    emptySharedBranchesListResponse()
  );
});

test("disabled paged and kanban responses preserve caller window arguments", () => {
  const { registrar, handlers } = makeFakeRegistrar();
  installDisabledAgentDashboardDbIpcHandlers(registrar);

  assert.deepEqual(
    invokeDisabled(handlers, "desktop:db:get-sessions-page", {
      limit: 17,
      offset: 34,
    }),
    { sessions: [], total: 0, limit: 17, offset: 34 }
  );
  assert.deepEqual(
    invokeDisabled(
      handlers,
      "desktop:db:get-kanban-pages",
      ["active", 42, "error", null],
      13
    ),
    {
      active: { sessions: [], total: 0, limit: 13, offset: 0 },
      error: { sessions: [], total: 0, limit: 13, offset: 0 },
    },
    "non-string statuses must not become response keys"
  );
});

test("disabled insights return the exact empty shape for each section", () => {
  const { registrar, handlers } = makeFakeRegistrar();
  installDisabledAgentDashboardDbIpcHandlers(registrar);
  const emptyTimeSeries = { series: [], points: [] };

  assert.deepEqual(
    invokeDisabled(handlers, "desktop:db:get-insights", "utilization"),
    {
      kpis: [],
      charts: {
        eventActivity: emptyTimeSeries,
        eventVolume: emptyTimeSeries,
        eventsByType: [],
        sessionsByStatus: [],
        reviewQueue: [],
      },
    }
  );
  assert.deepEqual(
    invokeDisabled(handlers, "desktop:db:get-insights", "agents"),
    {
      kpis: [],
      charts: {
        modelUsageOverTime: emptyTimeSeries,
        modelBreakdown: [],
        tokenDistribution: [],
        toolUsage: [],
        agentsByStatus: [],
        agentsByType: [],
        toolRunsOverTime: emptyTimeSeries,
      },
    }
  );
  assert.deepEqual(
    invokeDisabled(handlers, "desktop:db:get-insights", "delivery"),
    {
      kpis: [],
      charts: {
        prTrend: emptyTimeSeries,
        klocTrend: emptyTimeSeries,
        locTrend: emptyTimeSeries,
        prByRepo: [],
        meanTimeToMerge: [],
        prByState: [],
        branchLifespan: [],
        branchesWithoutPr: [],
      },
    }
  );
});

test("disabled conversion, viewership, and default list arms stay contract-complete", () => {
  const { registrar, handlers } = makeFakeRegistrar();
  installDisabledAgentDashboardDbIpcHandlers(registrar);

  assert.deepEqual(
    invokeDisabled(handlers, CATALOG_CONVERT_INSTALL_CHANNEL),
    makeConvertInstallErrorOutcome({
      failureClass: ConvertFailureClass.Transient,
      message: "Agent Dashboard is disabled in Settings.",
    })
  );
  assert.deepEqual(invokeDisabled(handlers, THREAD_VIEWED_CHANNEL), {
    recorded: false,
  });
  assert.deepEqual(
    invokeDisabled(handlers, "desktop:db:get-sessions"),
    [],
    "the named default arm must remain an empty list"
  );
});

// ISS-4773 (whitlockk review): the canonical empty usage summary must PUBLISH the
// three-way cost split as explicit zeroes.
//
// On the wire, an ABSENT `meteredEstimatedCost`/`unknownEstimatedCost` pair is
// the signal for "this producer predates ISS-4773 and cannot split the bucket",
// which makes the Sessions Cost card fall back to its pre-ISS-4773 presentation.
// The normal folds (`buildUsageSummary` / `foldUsageAggregate`) emit the split,
// so if THIS shape omitted it, a current Desktop's empty and disabled-IPC states
// would be misread as an old producer and flip the card's label purely because
// the read was empty. Absent means "cannot split", never "nothing was billed".
test("the canonical empty usage summary publishes a zeroed cost split (ISS-4773)", () => {
  const empty = emptySharedAgentSessionsUsageSummary();

  assert.equal(
    empty.meteredEstimatedCost,
    0,
    "an empty read from a current producer must say zero, not stay silent"
  );
  assert.equal(empty.unknownEstimatedCost, 0);
  // The partition invariant the consumer reconciles against holds at zero too.
  assert.equal(
    (empty.meteredEstimatedCost ?? 0) + (empty.unknownEstimatedCost ?? 0),
    empty.apiEstimatedCost
  );
});
