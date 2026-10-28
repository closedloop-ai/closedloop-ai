/**
 * @file db-host-unexpected-exit-telemetry.test.ts
 * @description ISS-5715 — an unexpected db-host exit must reach the desktop
 * telemetry emitter, not just `onLog`.
 *
 * Two legs, because either one alone goes green while the signal is dead:
 *
 *  1. `reportDbHostExitedUnexpectedly` emits at `error` severity under the
 *     db-host category, carrying the counters as typed diagnostics.
 *  2. The db-host lifecycle actually DELIVERS a real unexpected exit to that
 *     emitter. Without leg 2 the emitter is an orphan: deleting the one
 *     production call site would leave leg 1 passing and the app silent again.
 *
 * Leg 2 used to be a structural guard that parsed the lifecycle module and
 * regex-matched the `onUnexpectedExit` initializer's source text. Review (codex
 * + whitlockk, PR #4708) correctly rejected it: it stayed green if the emitter was
 * merely REFERENCED and never invoked — behind an always-false branch, say —
 * and `apps/desktop/AGENTS.md` ("Test Practices") bans source/AST structural
 * guards for behavior outright. It is replaced here by a behavioral test that
 * builds the real `createAgentDashboardDbHostLifecycle`, drives a real child
 * exit through the injected fork seam, and asserts the emitted event.
 *
 * Timers are mocked so the restart ladder's backoff timer is never armed for
 * real and the suite leaves no dangling handle.
 */
import assert from "node:assert/strict";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  test,
  vi,
} from "vitest";
import type { createAgentDashboardDbHostLifecycle as CreateLifecycle } from "../src/main/dashboard/agent-dashboard-db-host-lifecycle.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import {
  type DbHostError,
  DbHostRequestKind,
  DbHostResponseKind,
} from "../src/main/database/db-host/db-host-protocol.js";
import {
  DB_HOST_RESTART_EXHAUSTED_RUNTIME_STATUS,
  DB_HOST_RESTART_EXHAUSTED_USER_REASON,
  MAX_DB_HOST_RESTART_ATTEMPTS,
} from "../src/main/database/db-host/db-host-restart-budget.js";
import { reportDbHostExitedUnexpectedly } from "../src/main/telemetry/db-host-exit-telemetry.js";
import { Observability } from "../src/main/telemetry/observability.js";
import type { DbHostExitDiagnostics } from "../src/main/telemetry/telemetry-protocol.js";
import type { EnrichedTelemetryEvent } from "../src/main/telemetry/telemetry-service.js";
import {
  type AgentMonitorRuntimeStatus,
  AgentMonitorRuntimeStatusKind,
} from "../src/shared/agent-monitor-status.js";
import type {
  DbHostChildExitListener,
  DbHostChildListenerArgs,
  DbHostChildMessageListener,
} from "./db-host-fake-child-support.js";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

/** The category a Datadog log monitor would key on. */
const DB_HOST_EXIT_CATEGORY = "desktop.db_host.exited_unexpectedly";
/** ISS-8776 — the terminal category, kept distinct from the bounce above. */
const DB_HOST_RESTART_EXHAUSTED_CATEGORY = "desktop.db_host.restart_exhausted";
/** Microtask hops drained between synchronous steps. */
const MICROTASK_DRAIN_TURNS = 50;
/** The pre-open zombie reap shells out to `lsof`; give the boot leg real room. */
const LIFECYCLE_BOOT_TIMEOUT_MS = 30_000;

afterEach(() => {
  Observability.reset();
  vi.restoreAllMocks();
});

function exitDiagnostics(
  overrides: Partial<DbHostExitDiagnostics> = {}
): DbHostExitDiagnostics {
  return {
    exitCode: 0,
    crashesInWindow: 1,
    backoffMs: 1000,
    rejectedOps: 3,
    restartAlreadyInFlight: false,
    ...overrides,
  };
}

function initCapturing(): EnrichedTelemetryEvent[] {
  const events: EnrichedTelemetryEvent[] = [];
  Observability.init({ telemetrySend: (event) => events.push(event) });
  return events;
}

async function drainMicrotasks(): Promise<void> {
  for (let turn = 0; turn < MICROTASK_DRAIN_TURNS; turn++) {
    await Promise.resolve();
  }
}

/**
 * A fake forked db-host child that captures the client's exit + message
 * listeners, so a test can complete the Init handshake and then deliver a real
 * `exit` through the very listener the production client registered.
 */
function makeFakeChild() {
  const posted: { kind: string; id?: number }[] = [];
  let exitListener: DbHostChildExitListener | undefined;
  let messageListener: DbHostChildMessageListener | undefined;
  const child = {
    stderr: null,
    on(...args: DbHostChildListenerArgs): unknown {
      if (args[0] === "exit") {
        exitListener = args[1];
      } else {
        messageListener = args[1];
      }
      return child;
    },
    postMessage(message: { kind: string; id?: number }) {
      posted.push(message);
    },
    kill() {
      // no-op for the fake
    },
  };
  return {
    child,
    posted,
    /** Deliver a child exit through the client's registered listener. */
    exit(code: number | null) {
      exitListener?.(code);
    },
    /** Complete the child's pending init reply so the lifecycle's start resolves. */
    ready() {
      const initId = posted.find((m) => m.kind === DbHostRequestKind.Init)?.id;
      messageListener?.({ kind: DbHostResponseKind.Ready, id: initId });
    },
    /**
     * Answer Init with an ERROR and stay alive — the real worker's behavior for
     * a store that refuses to open (`db-host-worker.ts`, PLN-1837 §1.2). The
     * refusal is deterministic, so exiting would refuse again on every restart;
     * the child therefore reports and keeps running, and the client keeps it.
     */
    readyError(message: string) {
      const initId = posted.find((m) => m.kind === DbHostRequestKind.Init)?.id;
      messageListener?.({
        kind: DbHostResponseKind.Ready,
        id: initId,
        error: { message } satisfies DbHostError,
      });
    },
    /** Park an invoke on the child so an exit has a blast radius to report. */
    lastInvokeId(): number | undefined {
      return posted.filter((m) => m.kind === DbHostRequestKind.Invoke).at(-1)
        ?.id;
    },
  };
}

/**
 * The minimum runtime options the db-host lifecycle actually reads. Everything
 * else on `AgentDashboardDesignSystemRuntimeOptions` is optional and unused by
 * this concern, so the cast is confined to this one builder rather than
 * sprinkled through the tests.
 */
function runtimeOptions(
  userDataPath: string,
  onTerminalFailure: (reason: string) => void = () => {
    // Most cases never reach a terminal failure.
  },
  setAgentMonitorRuntimeStatus: (
    status: AgentMonitorRuntimeStatus
  ) => void = () => {
    // Most cases never publish a runtime status.
  }
): AgentDashboardDesignSystemRuntimeOptions {
  return {
    getWindow: () => null,
    isTrustedSender: () => false,
    userDataPath,
    onTerminalFailure,
    setAgentMonitorRuntimeStatus,
  } as unknown as AgentDashboardDesignSystemRuntimeOptions;
}

/**
 * A child that forks cleanly and EXITS before it can answer Init — the shape of
 * a replacement that dies on arrival, which is what drives the ISS-8776 restart
 * ladder to its ceiling through the spawn-failure path.
 */
function makeStillbornChild() {
  const stillborn = makeFakeChild();
  const realPost = stillborn.child.postMessage.bind(stillborn.child);
  stillborn.child.postMessage = (message: { kind: string; id?: number }) => {
    realPost(message);
    if (message.kind === DbHostRequestKind.Init) {
      stillborn.exit(1);
    }
  };
  return stillborn;
}

/**
 * Build the REAL lifecycle over a fake child and run it to the point where the
 * db host is live and one caller invoke is in flight.
 */
async function startLifecycleWithFakeChild(
  createAgentDashboardDbHostLifecycle: typeof CreateLifecycle,
  userDataPath: string
) {
  const children = [makeFakeChild(), makeFakeChild()];
  let spawnCount = 0;
  const logs: string[] = [];
  const lifecycle = createAgentDashboardDbHostLifecycle({
    options: runtimeOptions(userDataPath),
    log: (_scope, message) => logs.push(message),
    getPackScanCoordinator: () => null,
    getCatalogCoordinator: () => null,
    fork: () => children[Math.min(spawnCount++, children.length - 1)].child,
  });

  // The pre-open zombie reap is a real async step in front of start(); poll for
  // the Init the client posts once it completes rather than guessing a delay.
  while (children[0].posted.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  children[0].ready();
  await lifecycle.ready;

  return { lifecycle, children, logs };
}

describe("reportDbHostExitedUnexpectedly", () => {
  test("emits an error-severity monitored event with the exit counters", () => {
    const events = initCapturing();
    reportDbHostExitedUnexpectedly(exitDiagnostics());
    assert.equal(events.length, 1);
    assert.equal(events[0].category, DB_HOST_EXIT_CATEGORY);
    assert.equal(events[0].severity, "error");
    assert.deepEqual(events[0].diagnostics?.dbHostExit, exitDiagnostics());
  });

  test("carries the blast radius and the untrusted exit code verbatim", () => {
    const events = initCapturing();
    // A null code (Electron reported none) and a large rejected-op count must
    // both survive to the backend — the count is how much in-flight ingestion
    // and read work the exit dropped.
    reportDbHostExitedUnexpectedly(
      exitDiagnostics({ exitCode: null, rejectedOps: 17 })
    );
    assert.equal(events[0].diagnostics?.dbHostExit?.exitCode, null);
    assert.equal(events[0].diagnostics?.dbHostExit?.rejectedOps, 17);
  });
});

describe("db-host lifecycle exit → telemetry (behavioral)", () => {
  let electronMock: ElectronModuleMock;
  let createLifecycle: typeof CreateLifecycle;

  beforeAll(async () => {
    // `agent-dashboard-runtime-paths.ts` does `import { app } from "electron"`
    // at module scope, which throws under `tsx --test` against the real
    // entrypoint (a path string). Redirect the specifier, then import the
    // lifecycle dynamically — the ISS-4845 mechanism.
    electronMock = registerElectronModuleMock();
    ({ createAgentDashboardDbHostLifecycle: createLifecycle } = await import(
      "../src/main/dashboard/agent-dashboard-db-host-lifecycle.js"
    ));
  });

  afterAll(() => {
    electronMock.deregister();
  });

  beforeEach(() => {
    // The exit arms the restart ladder's backoff timer. Mock timers so it is
    // never armed for real and the suite leaves no dangling handle behind.
    nodeTestTimers.enable(["setTimeout"]);
  });

  afterEach(() => {
    nodeTestTimers.reset();
  });

  test("an unexpected child exit reaches the telemetry emitter", {
    timeout: LIFECYCLE_BOOT_TIMEOUT_MS,
  }, async () => {
    const events = initCapturing();
    const { lifecycle, children } = await startLifecycleWithFakeChild(
      createLifecycle,
      "/tmp/iss-5715-lifecycle-exit"
    );

    // One caller invoke in flight — a real Sessions read, one of the three
    // consumers that die with the child — so the exit has a genuine blast
    // radius to report rather than a synthetic constant.
    const inFlight = lifecycle.agentDatabase.sessions
      .getById("session-1")
      .catch(() => {
        // The child dies under it; the rejection is the point.
      });
    await drainMicrotasks();
    assert.ok(
      children[0].lastInvokeId() !== undefined,
      "the invoke reached the child before the exit"
    );

    // Nobody asked the child to stop — this is the unexpected branch.
    children[0].exit(0);
    await inFlight;

    const emitted = events.filter(
      (event) => event.category === DB_HOST_EXIT_CATEGORY
    );
    assert.equal(
      emitted.length,
      1,
      "an unexpected db-host exit must emit exactly one monitored event"
    );
    assert.equal(emitted[0].severity, "error");
    assert.equal(emitted[0].diagnostics?.dbHostExit?.rejectedOps, 1);
    assert.equal(
      emitted[0].diagnostics?.dbHostExit?.restartAlreadyInFlight,
      false
    );
    assert.equal(emitted[0].diagnostics?.dbHostExit?.crashesInWindow, 1);
  });

  test("an intentional shutdown exit raises no telemetry event", {
    timeout: LIFECYCLE_BOOT_TIMEOUT_MS,
  }, async () => {
    const events = initCapturing();
    const { lifecycle, children } = await startLifecycleWithFakeChild(
      createLifecycle,
      "/tmp/iss-5715-lifecycle-shutdown"
    );

    // ISS-4713: the intentional-teardown window is open, so the very same
    // child exit is EXPECTED and must stay off the monitored channel — or
    // every quit would page someone.
    lifecycle.beginClosing();
    children[0].exit(0);
    await drainMicrotasks();

    assert.deepEqual(
      events.filter((event) => event.category === DB_HOST_EXIT_CATEGORY),
      [],
      "an expected shutdown exit must not emit the monitored event"
    );
  });

  test("an exhausted restart ladder reaches BOTH the telemetry emitter and the user", {
    timeout: LIFECYCLE_BOOT_TIMEOUT_MS,
  }, async () => {
    // ISS-8776. The composition-root wiring, not the client: `onRestartExhausted`
    // fans out to two sinks with different audiences, and the ceiling suite
    // drives `DbHostClient` directly with its own fake, so it cannot catch this
    // wiring being dropped, reordered, or half-deleted. Same reason its sibling
    // `onUnexpectedExit` case above exists.
    const events = initCapturing();
    const terminalReasons: string[] = [];
    const children = [makeFakeChild()];
    let spawnCount = 0;
    const lifecycle = createLifecycle({
      options: runtimeOptions("/tmp/iss-8776-lifecycle-exhausted", (reason) =>
        terminalReasons.push(reason)
      ),
      log: () => {
        // no-op
      },
      getPackScanCoordinator: () => null,
      getCatalogCoordinator: () => null,
      // The first child comes up; every replacement dies on arrival, so the
      // ladder walks its whole budget and gives up.
      fork: () => {
        spawnCount += 1;
        return spawnCount === 1
          ? children[0].child
          : makeStillbornChild().child;
      },
    });

    while (children[0].posted.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    children[0].ready();
    await lifecycle.ready;

    children[0].exit(1);
    // Walk the ladder well past its ceiling on mock timers — no wall clock.
    for (let round = 0; round < MAX_DB_HOST_RESTART_ATTEMPTS * 3; round++) {
      nodeTestTimers.tick(900_000);
      await drainMicrotasks();
    }

    const exhausted = events.filter(
      (event) => event.category === DB_HOST_RESTART_EXHAUSTED_CATEGORY
    );
    assert.equal(
      exhausted.length,
      1,
      "the terminal state must reach the monitored channel exactly once"
    );
    assert.equal(exhausted[0].severity, "error");
    assert.equal(
      exhausted[0].diagnostics?.dbHostExit?.restartAttempts,
      MAX_DB_HOST_RESTART_ATTEMPTS,
      "the alert carries how many attempts actually failed"
    );
    assert.deepEqual(
      terminalReasons,
      [DB_HOST_RESTART_EXHAUSTED_USER_REASON],
      "and the user is told, through the same channel a boot-time DB refusal uses"
    );
  });

  test("exhaustion AFTER a healthy boot stops the runtime status reporting ready", {
    timeout: LIFECYCLE_BOOT_TIMEOUT_MS,
  }, async () => {
    // davetho (#6432). The ordering is the whole point: this child answers
    // Ready first, which is what a real boot does and what latches
    // `desktop:get-runtime-status` at `ready` through
    // `agent-dashboard-runtime-bootstrap.ts`. A ladder that then exhausts and
    // publishes nothing leaves every renderer surface reading healthy while the
    // local store is gone for the rest of the session.
    initCapturing();
    const statuses: AgentMonitorRuntimeStatus[] = [];
    const children = [makeFakeChild()];
    let spawnCount = 0;
    const lifecycle = createLifecycle({
      options: runtimeOptions(
        "/tmp/iss-8776-lifecycle-status",
        () => {
          // The notification/tray sink is asserted by the case above.
        },
        (status) => statuses.push(status)
      ),
      log: () => {
        // no-op
      },
      getPackScanCoordinator: () => null,
      getCatalogCoordinator: () => null,
      fork: () => {
        spawnCount += 1;
        return spawnCount === 1
          ? children[0].child
          : makeStillbornChild().child;
      },
    });

    while (children[0].posted.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    children[0].ready();
    await lifecycle.ready;
    // Length, not `deepEqual([])`: node's assert types narrow the subject to
    // the expected type, so comparing against an empty literal would make
    // `statuses` `never[]` for the rest of the case.
    assert.equal(
      statuses.length,
      0,
      "a healthy boot must publish nothing here — otherwise the assertion below cannot tell exhaustion from start-up noise"
    );

    children[0].exit(1);
    for (let round = 0; round < MAX_DB_HOST_RESTART_ATTEMPTS * 3; round++) {
      nodeTestTimers.tick(900_000);
      await drainMicrotasks();
    }

    assert.deepEqual(
      statuses,
      [DB_HOST_RESTART_EXHAUSTED_RUNTIME_STATUS],
      "exhaustion must publish exactly one failed runtime status"
    );
    // Spelled out rather than left to the constant, so a later edit that made
    // the shared value `dbAhead: true` — sending the user to an app update that
    // cannot help — reddens here instead of travelling silently.
    assert.equal(statuses[0].kind, AgentMonitorRuntimeStatusKind.Failed);
    assert.equal(
      statuses[0].dbAhead,
      false,
      "a restart-ladder exhaustion says nothing about migrations, so it must not claim the DB-ahead treatment"
    );
    assert.equal(statuses[0].reason, DB_HOST_RESTART_EXHAUSTED_USER_REASON);
  });

  test("a store that REFUSED to open still has its later exit treated as expected", {
    timeout: LIFECYCLE_BOOT_TIMEOUT_MS,
  }, async () => {
    // codex (#6432). The rejection path releases the fatal-exit hook, because a
    // `ready` rejection throws out of runtime creation before any close handle
    // reaches the caller. But the CHILD survives that rejection: a store that
    // refuses to open is answered with a `Ready` carrying an error and the
    // worker stays alive. Release the hook and nothing is left to announce a
    // fatal teardown to a live utility process — `app.exit()` kills it,
    // `handleExit()` sees no closing window, and the supervisor calls it a crash
    // and re-forks into a main process that is already going away.
    const events = initCapturing();
    const logs: string[] = [];
    const children = [makeFakeChild()];
    let spawnCount = 0;
    const lifecycle = createLifecycle({
      options: runtimeOptions("/tmp/iss-8776-lifecycle-refused"),
      log: (_scope, message) => logs.push(message),
      getPackScanCoordinator: () => null,
      getCatalogCoordinator: () => null,
      fork: () => {
        spawnCount += 1;
        return spawnCount === 1
          ? children[0].child
          : makeStillbornChild().child;
      },
    });

    while (children[0].posted.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    children[0].readyError("migration refused: DB is ahead of this app");
    await assert.rejects(lifecycle.ready);

    // `app.exit()` now tears down the utility process that never stopped
    // running. Electron reports 0 for a utility-process disconnect.
    children[0].exit(0);
    for (let round = 0; round < MAX_DB_HOST_RESTART_ATTEMPTS * 3; round++) {
      nodeTestTimers.tick(900_000);
      await drainMicrotasks();
    }

    assert.deepEqual(
      events.filter((event) => event.category === DB_HOST_EXIT_CATEGORY),
      [],
      "the refused store's own teardown is not a crash and must stay off the monitored channel"
    );
    assert.equal(
      spawnCount,
      1,
      "and nothing may re-fork a child whose store refuses deterministically"
    );
    assert.deepEqual(
      events.filter(
        (event) => event.category === DB_HOST_RESTART_EXHAUSTED_CATEGORY
      ),
      [],
      "a ladder that never armed cannot have exhausted"
    );
  });
});
