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
 * + wongk, PR #4708) correctly rejected it: it stayed green if the emitter was
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
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  mock,
  test,
} from "node:test";
import type { createAgentDashboardDbHostLifecycle as CreateLifecycle } from "../src/main/dashboard/agent-dashboard-db-host-lifecycle.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import {
  DbHostRequestKind,
  DbHostResponseKind,
} from "../src/main/database/db-host/db-host-protocol.js";
import { reportDbHostExitedUnexpectedly } from "../src/main/telemetry/db-host-exit-telemetry.js";
import { Observability } from "../src/main/telemetry/observability.js";
import type { DbHostExitDiagnostics } from "../src/main/telemetry/telemetry-protocol.js";
import type { EnrichedTelemetryEvent } from "../src/main/telemetry/telemetry-service.js";
import type {
  DbHostChildExitListener,
  DbHostChildListenerArgs,
  DbHostChildMessageListener,
} from "./db-host-fake-child-support.js";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";

/** The category a Datadog log monitor would key on. */
const DB_HOST_EXIT_CATEGORY = "desktop.db_host.exited_unexpectedly";
/** Microtask hops drained between synchronous steps. */
const MICROTASK_DRAIN_TURNS = 50;
/** The pre-open zombie reap shells out to `lsof`; give the boot leg real room. */
const LIFECYCLE_BOOT_TIMEOUT_MS = 30_000;

afterEach(() => {
  Observability.reset();
  mock.restoreAll();
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
  userDataPath: string
): AgentDashboardDesignSystemRuntimeOptions {
  return {
    getWindow: () => null,
    isTrustedSender: () => false,
    userDataPath,
  } as unknown as AgentDashboardDesignSystemRuntimeOptions;
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

  before(async () => {
    // `agent-dashboard-runtime-paths.ts` does `import { app } from "electron"`
    // at module scope, which throws under `tsx --test` against the real
    // entrypoint (a path string). Redirect the specifier, then import the
    // lifecycle dynamically — the ISS-4845 mechanism.
    electronMock = registerElectronModuleMock();
    ({ createAgentDashboardDbHostLifecycle: createLifecycle } = await import(
      "../src/main/dashboard/agent-dashboard-db-host-lifecycle.js"
    ));
  });

  after(() => {
    electronMock.deregister();
  });

  beforeEach(() => {
    // The exit arms the restart ladder's backoff timer. Mock timers so it is
    // never armed for real and the suite leaves no dangling handle behind.
    mock.timers.enable({ apis: ["setTimeout"] });
  });

  afterEach(() => {
    mock.timers.reset();
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
});
