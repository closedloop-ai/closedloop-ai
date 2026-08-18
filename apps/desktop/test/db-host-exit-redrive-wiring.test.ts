/**
 * @file db-host-exit-redrive-wiring.test.ts
 * @description ISS-5808 — the PRODUCTION WIRING of the db-host-exit re-drive.
 *
 * `db-host-exit-work-recovery.test.ts` proves the primitive
 * (`redriveOnDbHostExit`) and `db-host-exit-consumer-recovery.test.ts` proves
 * each classifier. Neither proves the re-drive is INSTALLED anywhere, and the
 * installation IS the fix: deleting the `DB_HOST_EXIT_REDRIVE_READ` argument
 * from an `ipcMain.handle` registration, or the `redriveOnDbHostExit(...)`
 * wrapper from the DATA_REVISION rebuild, left both of those suites green.
 *
 * So this suite drives the REAL registrars and the REAL maintenance chain, and
 * observes the re-drive by COUNTING how many times the underlying db access is
 * attempted — never by elapsed time.
 *
 * The Branches case is the load-bearing one: its handler sanitizes the failure
 * through `rethrowAsBranchSourceError` before `withDb` ever sees it, so it only
 * re-drives if the `cause` link this ticket added survives that boundary. It is
 * the end-to-end proof of the classification, not just of the wrapper.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import type {
  Harness,
  HarnessCollector,
  NormalizedSession,
} from "../src/main/collectors/types.js";
import type { WithDb } from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import { createDbIpcHandlerWrappers } from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import {
  createMaintenanceProgressState,
  type MaintenanceProgressState,
} from "../src/main/dashboard/maintenance-progress-state.js";
import {
  createPostBootMaintenance,
  type PostBootMaintenanceDeps,
} from "../src/main/dashboard/post-boot-maintenance.js";
import { DB_HOST_EXIT_MAX_ATTEMPTS } from "../src/main/database/db-host/db-host-exit-redrive.js";
import type { DbHostAgentDatabase } from "../src/main/database/sqlite.js";
import { DbHostExitError } from "../src/shared/db-host-exit-error.js";
import { MaintenancePhase } from "../src/shared/maintenance-progress-contract.js";
import { SHARED_AGENT_SESSIONS_IPC_CHANNELS } from "../src/shared/shared-agent-sessions-contract.js";
import { SHARED_BRANCHES_IPC_CHANNELS } from "../src/shared/shared-branches-contract.js";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";
import {
  registeredInvokeHandler,
  resetElectronModuleStub,
} from "./helpers/electron-module-stub.js";
import {
  fakeCollector,
  makePopulatedSession,
} from "./normalized-session-test-utils.js";

/**
 * Thrown by the probe on every attempt AFTER the first, so a handler abandons
 * the instant it has proven the re-drive reached it. Distinct text so an
 * unrelated failure can never be mistaken for the probe running.
 */
const PROBE_SENTINEL = "iss-5808-redrive-probe";

const STUB_OPTIONS = {
  getWindow: () => null,
  isTrustedSender: () => true,
  onTerminalFailure: () => undefined,
} as unknown as AgentDashboardDesignSystemRuntimeOptions;

const TRUSTED_EVENT = { sender: {} };

let mock: ElectronModuleMock;
let registerLocalDashboardReadIpcHandlers: (deps: { withDb: WithDb }) => void;
let registerSharedSessionAndBranchIpcHandlers: (deps: {
  withDb: WithDb;
  options: AgentDashboardDesignSystemRuntimeOptions;
  cloudHydration: undefined;
}) => void;

before(async () => {
  mock = registerElectronModuleMock();
  // Dynamic, because the redirect must be installed before each registrar
  // evaluates its module-scope `import { ipcMain } from "electron"`.
  const local = await import(
    "../src/main/dashboard/agent-dashboard-local-read-ipc.js"
  );
  registerLocalDashboardReadIpcHandlers =
    local.registerLocalDashboardReadIpcHandlers as typeof registerLocalDashboardReadIpcHandlers;
  const shared = await import(
    "../src/main/dashboard/agent-dashboard-shared-read-ipc.js"
  );
  registerSharedSessionAndBranchIpcHandlers =
    shared.registerSharedSessionAndBranchIpcHandlers as typeof registerSharedSessionAndBranchIpcHandlers;
});

after(() => {
  mock.deregister();
});

afterEach(() => {
  resetElectronModuleStub();
});

/**
 * An `agentDatabase` whose FIRST touch of the probed property fails with a
 * recoverable db-host exit and whose later touches throw {@link PROBE_SENTINEL}.
 *
 * Counting touches is what makes the assertion behavioural: a handler that
 * re-drives touches twice, a handler that does not touches once. The first
 * failure must be the recoverable exit specifically — a plain error would let a
 * re-driving handler pass for the wrong reason.
 */
function makeProbeDatabase(property: string): {
  agentDatabase: DbHostAgentDatabase;
  touches: () => number;
} {
  let touches = 0;
  const probe = {
    get [property]() {
      touches++;
      if (touches === 1) {
        throw new DbHostExitError(0, true, "db-host exited (code: 0)");
      }
      throw new Error(PROBE_SENTINEL);
    },
  };
  return {
    agentDatabase: probe as unknown as DbHostAgentDatabase,
    touches: () => touches,
  };
}

/** The real `withDb`, over the probe — not a stub that drops its options. */
function makeRealWithDb(agentDatabase: DbHostAgentDatabase): WithDb {
  return createDbIpcHandlerWrappers({
    getAgentDatabase: () => Promise.resolve(agentDatabase),
    options: STUB_OPTIONS,
  }).withDb;
}

/**
 * Settle whatever an `ipcMain.handle` callback returned (it is typed `unknown`,
 * since the registrar's fake accepts any handler) and hand back the rejection,
 * or `null` when it resolved. Assertions stay in the test body.
 */
async function settledError(work: unknown): Promise<unknown> {
  return await Promise.resolve(work).then(
    () => null,
    (error: unknown) => error
  );
}

describe("the db-host-exit re-drive is installed on the read IPC channels (ISS-5808)", () => {
  it("re-drives desktop:db:get-insights against the replacement host", async () => {
    const { agentDatabase, touches } = makeProbeDatabase("dashboard");
    registerLocalDashboardReadIpcHandlers({
      withDb: makeRealWithDb(agentDatabase),
    });

    const error = await settledError(
      registeredInvokeHandler("desktop:db:get-insights")(
        TRUSTED_EVENT,
        "delivery",
        "7d"
      )
    );

    assert.match(String(error), new RegExp(PROBE_SENTINEL));
    assert.equal(
      touches(),
      2,
      "the handler must retry the read against the replacement child"
    );
  });

  it("does NOT re-drive a channel that never opted in", async () => {
    const { agentDatabase, touches } = makeProbeDatabase("dashboard");
    registerLocalDashboardReadIpcHandlers({
      withDb: makeRealWithDb(agentDatabase),
    });

    const error = await settledError(
      registeredInvokeHandler("desktop:db:get-token-analytics")(TRUSTED_EVENT)
    );

    assert.ok(
      error instanceof DbHostExitError,
      "an un-opted-in handler must surface the exit unchanged"
    );
    assert.equal(touches(), 1);
  });

  it("re-drives the Sessions page-data channel", async () => {
    const { agentDatabase, touches } = makeProbeDatabase("syncSource");
    registerSharedSessionAndBranchIpcHandlers({
      withDb: makeRealWithDb(agentDatabase),
      options: STUB_OPTIONS,
      cloudHydration: undefined,
    });

    await settledError(
      registeredInvokeHandler(SHARED_AGENT_SESSIONS_IPC_CHANNELS.pageData)(
        TRUSTED_EVENT,
        {}
      )
    );

    assert.equal(touches(), 2);
  });

  it("re-drives the Branches page-data channel THROUGH its sanitizing boundary", async () => {
    const { agentDatabase, touches } = makeProbeDatabase("syncSource");
    registerSharedSessionAndBranchIpcHandlers({
      withDb: makeRealWithDb(agentDatabase),
      options: STUB_OPTIONS,
      cloudHydration: undefined,
    });

    await settledError(
      registeredInvokeHandler(SHARED_BRANCHES_IPC_CHANNELS.pageData)(
        TRUSTED_EVENT,
        {}
      )
    );

    assert.equal(
      touches(),
      2,
      "rethrowAsBranchSourceError discards the message, so this only re-drives if the `cause` link survives"
    );
  });
});

/**
 * Optional seams for the committed-work cases. Absent by default so every
 * pre-existing case keeps the minimal `agentDatabase` it had.
 */
type MaintenanceDepsOverrides = {
  collectors?: readonly HarnessCollector[];
  rebuildSessionFromParse?: (
    session: NormalizedSession,
    harness: Harness
  ) => Promise<{
    rebuilt: boolean;
    activeRace: boolean;
    contentChanged?: boolean;
  }>;
  enqueueOutboxEntries?: (
    sourceKey: string,
    entries: readonly { externalSessionId: string }[]
  ) => Promise<void>;
  onInvalidate?: () => void;
  onStoreOp?: (name: string) => void;
  computeTargetId?: string;
  /**
   * ISS-6241: the REAL published maintenance state, so a case can assert what
   * the renderer would actually read rather than what the chain intended to
   * publish.
   */
  maintenanceProgress?: MaintenanceProgressState;
};

/**
 * The DATA_REVISION rebuild's first db touch is
 * `db.listStaleRevisionSessions(DATA_REVISION)` (`data-revision-rebuild.ts`), so
 * failing exactly that call is how a case makes the whole pass fail at its
 * cheapest point without a SQLite store.
 */
function makeMaintenanceDeps(
  listStaleRevisionSessions: () => Promise<unknown[]>,
  logs: string[],
  overrides: MaintenanceDepsOverrides = {}
): PostBootMaintenanceDeps {
  return {
    isMaintenanceActive: () => true,
    setMaintenancePhase: (generation, phase) =>
      overrides.maintenanceProgress?.setPhase(generation, phase),
    setMaintenancePhaseProgress: (generation, phase, progress) =>
      overrides.maintenanceProgress?.setPhaseProgress(
        generation,
        phase,
        progress
      ),
    agentDatabase: {
      listStaleRevisionSessions,
      rebuildSessionFromParse: overrides.rebuildSessionFromParse,
      sessions: {
        invalidateHistoricalDetails: () => overrides.onInvalidate?.(),
      },
      syncSource: overrides.enqueueOutboxEntries
        ? { enqueueOutboxEntries: overrides.enqueueOutboxEntries }
        : undefined,
    } as unknown as DbHostAgentDatabase,
    getCollectors: () => overrides.collectors ?? [],
    getHistoricalParseRunner: () => null,
    // Every other pass in the chain runs through `invokeStoreOp`; resolving it
    // to `null` keeps the case about the rebuild.
    invokeStoreOp: (name: string) => {
      overrides.onStoreOp?.(name);
      return Promise.resolve(null);
    },
    getWindow: () => null,
    log: (message: string) => logs.push(message),
    isDbHostUnderMemoryPressure: () => false,
    cooperativeDelay: () => Promise.resolve(),
    resolveComputeTargetId: () => overrides.computeTargetId ?? null,
  };
}

describe("the db-host-exit re-drive is installed on the DATA_REVISION rebuild (ISS-5808)", () => {
  it("re-drives the rebuild pass against the replacement host", async () => {
    const logs: string[] = [];
    let calls = 0;
    const deps = makeMaintenanceDeps(() => {
      calls++;
      if (calls === 1) {
        return Promise.reject(
          new DbHostExitError(0, true, "db-host exited (code: 0)")
        );
      }
      return Promise.resolve([]);
    }, logs);

    await createPostBootMaintenance(deps).runPostBootMaintenance(1);

    assert.equal(calls, 2, "the rebuild must be re-attempted, not abandoned");
    assert.deepEqual(
      logs.filter((line) => line.startsWith("data-revision rebuild failed")),
      [],
      "a pass that recovered must not also report a failure"
    );
  });

  it("still reports a failure once the re-drive bound is exhausted", async () => {
    const logs: string[] = [];
    let calls = 0;
    const deps = makeMaintenanceDeps(() => {
      calls++;
      return Promise.reject(
        new DbHostExitError(0, true, "db-host exited (code: 0)")
      );
    }, logs);

    await createPostBootMaintenance(deps).runPostBootMaintenance(1);

    assert.equal(calls, DB_HOST_EXIT_MAX_ATTEMPTS);
    assert.ok(
      logs.some((line) => line.startsWith("data-revision rebuild failed")),
      "an exhausted re-drive must never read as a completed pass"
    );
  });
});

/** The captured compute target the outbox enqueue is keyed under. */
const COMPUTE_TARGET_ID = "compute-target-1";
/** A stale row the rebuild will treat as terminal and therefore rebuildable. */
function staleRow(id: string): { id: string; harness: string; status: string } {
  return { id, harness: "claude", status: "inactive" };
}

/**
 * A file collector whose sources map 1:1 to session ids, so `rebuildHarness`
 * reaches `applyRebuild` (and therefore `rebuildSessionFromParse`) for each id
 * without touching the filesystem.
 */
function sessionCollector(ids: readonly string[]): HarnessCollector {
  return fakeCollector("claude", {
    sources: ids.map((id) => `/transcripts/${id}.jsonl`),
    sessionIdForSource: (source: string) =>
      source.replace("/transcripts/", "").replace(".jsonl", ""),
    parse: (source: string) =>
      Promise.resolve([
        makePopulatedSession({
          sessionId: source.replace("/transcripts/", "").replace(".jsonl", ""),
        }),
      ]),
  });
}

describe("committed rebuild results survive a db-host-exit re-drive (ISS-5808)", () => {
  it("carries a session committed before the exit into the sync enqueue and the invalidation", async () => {
    const logs: string[] = [];
    const enqueued: string[] = [];
    let invalidations = 0;
    const rebuiltIds: string[] = [];
    let staleCalls = 0;

    const deps = makeMaintenanceDeps(
      () => {
        staleCalls++;
        // Attempt 1 sees both stale rows. By attempt 2, `a` has COMMITTED and
        // carries the current stamp, so the cursored rebuild correctly excludes
        // it — which is exactly why the last attempt's summary cannot be
        // authoritative.
        return Promise.resolve(
          staleCalls === 1 ? [staleRow("a"), staleRow("b")] : [staleRow("b")]
        );
      },
      logs,
      {
        collectors: [sessionCollector(["a", "b"])],
        computeTargetId: COMPUTE_TARGET_ID,
        onInvalidate: () => {
          invalidations++;
        },
        enqueueOutboxEntries: (_sourceKey, entries) => {
          enqueued.push(...entries.map((entry) => entry.externalSessionId));
          return Promise.resolve();
        },
        rebuildSessionFromParse: (session) => {
          rebuiltIds.push(session.sessionId);
          // `a` commits. Then the child dies under `b` — the first attempt's
          // counters and `changedSessionIds` live only in its in-memory summary.
          if (session.sessionId === "b" && rebuiltIds.length === 2) {
            return Promise.reject(
              new DbHostExitError(0, true, "db-host exited (code: 0)")
            );
          }
          return Promise.resolve({
            rebuilt: true,
            activeRace: false,
            contentChanged: true,
          });
        },
      }
    );

    await createPostBootMaintenance(deps).runPostBootMaintenance(1);

    assert.equal(staleCalls, 2, "the rebuild must have been re-driven once");
    assert.deepEqual(
      [...enqueued].sort(),
      ["a", "b"],
      "a session committed by the abandoned attempt must still reach the sync outbox"
    );
    assert.ok(
      invalidations > 0,
      "the renderer must not keep serving pre-rebuild rows for work that landed"
    );
  });

  it("still invalidates when the ONLY stale row committed and its response was lost", async () => {
    const logs: string[] = [];
    const enqueued: string[] = [];
    let invalidations = 0;
    let staleCalls = 0;

    const deps = makeMaintenanceDeps(
      () => {
        staleCalls++;
        // The narrow race the summary can never name: the write committed, the
        // child died before answering, so attempt 2 finds nothing stale and every
        // counter is zero — yet the row on disk HAS changed.
        return Promise.resolve(staleCalls === 1 ? [staleRow("only")] : []);
      },
      logs,
      {
        collectors: [sessionCollector(["only"])],
        computeTargetId: COMPUTE_TARGET_ID,
        onInvalidate: () => {
          invalidations++;
        },
        enqueueOutboxEntries: (_sourceKey, entries) => {
          enqueued.push(...entries.map((entry) => entry.externalSessionId));
          return Promise.resolve();
        },
        rebuildSessionFromParse: () =>
          Promise.reject(
            new DbHostExitError(0, true, "db-host exited (code: 0)")
          ),
      }
    );

    await createPostBootMaintenance(deps).runPostBootMaintenance(1);

    assert.equal(staleCalls, 2);
    assert.deepEqual(
      enqueued,
      [],
      "there is no id to enqueue — the incremental updated_at cursor owns this row"
    );
    assert.equal(
      invalidations,
      1,
      "an abandoned attempt may have committed, so the caches must be dropped on its behalf"
    );
  });

  it("a hand-off that itself fails on the dead host is logged, not thrown", async () => {
    const logs: string[] = [];
    const storeOps: string[] = [];
    let staleCalls = 0;

    const deps = makeMaintenanceDeps(
      () => {
        staleCalls++;
        return Promise.resolve(staleCalls === 1 ? [staleRow("only")] : []);
      },
      logs,
      {
        collectors: [sessionCollector(["only"])],
        computeTargetId: COMPUTE_TARGET_ID,
        onStoreOp: (name) => storeOps.push(name),
        // The hand-off now runs on the FAILURE path too, so it can meet the same
        // disposed host the rebuild just died on. It must degrade to a log: the
        // artifact-link and activity-segment passes behind it are independent
        // work and must still get their turn.
        onInvalidate: () => {
          throw new DbHostExitError(0, true, "db-host exited (code: 0)");
        },
        rebuildSessionFromParse: () =>
          Promise.reject(
            new DbHostExitError(0, true, "db-host exited (code: 0)")
          ),
      }
    );

    await createPostBootMaintenance(deps).runPostBootMaintenance(1);

    assert.ok(
      logs.some((line) =>
        line.startsWith("data-revision rebuild result hand-off failed")
      ),
      "the hand-off failure must be reported, not swallowed"
    );
    assert.ok(
      storeOps.length > 1,
      `the passes behind the rebuild must still run; store ops seen: ${storeOps.join(", ")}`
    );
  });

  it("a hand-off failure during a CANCELLED generation stops the chain instead of logging", async () => {
    const logs: string[] = [];
    const storeOps: string[] = [];
    let staleCalls = 0;
    let active = true;

    const deps = makeMaintenanceDeps(
      () => {
        staleCalls++;
        return Promise.resolve(staleCalls === 1 ? [staleRow("only")] : []);
      },
      logs,
      {
        collectors: [sessionCollector(["only"])],
        computeTargetId: COMPUTE_TARGET_ID,
        onStoreOp: (name) => storeOps.push(name),
        onInvalidate: () => {
          // Shutdown/restart superseded this generation while the hand-off was
          // running, and the same teardown is what made the call throw. A
          // cancelled generation must not report a failure or keep working.
          active = false;
          throw new DbHostExitError(0, true, "db-host exited (code: 0)");
        },
        rebuildSessionFromParse: () =>
          Promise.reject(
            new DbHostExitError(0, true, "db-host exited (code: 0)")
          ),
      }
    );
    deps.isMaintenanceActive = () => active;

    await createPostBootMaintenance(deps).runPostBootMaintenance(1);

    assert.deepEqual(
      logs.filter((line) => line.startsWith("data-revision rebuild result")),
      [],
      "a cancelled generation must not report the teardown it caused as a failure"
    );
    assert.equal(
      storeOps.length,
      1,
      `only the pre-rebuild inventory repair may have run; saw: ${storeOps.join(", ")}`
    );
  });
});

describe("an abandoned attempt's count does not survive the re-drive (ISS-6241)", () => {
  it("clears the previous attempt's counts before the replacement attempt runs", async () => {
    const logs: string[] = [];
    let staleCalls = 0;
    // The real published state, generation-guarded exactly as the runtime wires
    // it — this is what `getRuntimeStatus` hands the renderer.
    const maintenanceProgress = createMaintenanceProgressState(() => true);
    // Sampled at the ONE instant that discriminates: attempt 2 has started and
    // has not yet learned its own population. Asserting after the whole chain
    // would prove nothing — the artifact-link phase publish clears the counts on
    // its way past, so a stale count that was on screen for the entire re-drive
    // would still read as absent by then.
    let retrySampleTaken = false;
    let phaseAtRetry: MaintenancePhase | null = null;
    let processedAtRetry: number | undefined;
    let totalAtRetry: number | undefined;

    const deps = makeMaintenanceDeps(
      () => {
        staleCalls++;
        if (staleCalls > 1) {
          const sample = maintenanceProgress.read();
          retrySampleTaken = true;
          phaseAtRetry = sample.phase;
          // `rebuild` is the only member of the wire union that carries counts,
          // so this is the discriminant, not a defensive check: on any other
          // member there are no count fields to read at all.
          if (sample.active && sample.phase === MaintenancePhase.Rebuild) {
            processedAtRetry = sample.processed;
            totalAtRetry = sample.total;
          }
        }
        // Attempt 1 works a population of two. `a` commits, then the host dies
        // under `b` — whose write may itself have committed, so attempt 2
        // correctly finds nothing stale and returns before it can build a
        // reporter of its own. Nothing would overwrite attempt 1's numbers.
        return Promise.resolve(
          staleCalls === 1 ? [staleRow("a"), staleRow("b")] : []
        );
      },
      logs,
      {
        collectors: [sessionCollector(["a", "b"])],
        maintenanceProgress,
        rebuildSessionFromParse: (session) => {
          if (session.sessionId === "b") {
            return Promise.reject(
              new DbHostExitError(0, true, "db-host exited (code: 0)")
            );
          }
          return Promise.resolve({ rebuilt: true, activeRace: false });
        },
      }
    );

    await createPostBootMaintenance(deps).runPostBootMaintenance(1);

    assert.equal(staleCalls, 2, "the rebuild must have been re-driven once");
    assert.ok(retrySampleTaken, "the retry sample must have been taken");
    // Without this the counts-absent claims below could pass vacuously: any
    // member other than `rebuild` has no count fields at all, so a sample taken
    // off the wrong phase would read as "cleared" while proving nothing.
    assert.equal(
      phaseAtRetry,
      MaintenancePhase.Rebuild,
      "the sample must be taken while the rebuild phase still owns the counts"
    );
    assert.equal(
      processedAtRetry,
      undefined,
      "a numerator from an abandoned attempt must not stay on screen"
    );
    assert.equal(
      totalAtRetry,
      undefined,
      "the denominator goes with it — the counts are present together or not at all"
    );
  });
});
