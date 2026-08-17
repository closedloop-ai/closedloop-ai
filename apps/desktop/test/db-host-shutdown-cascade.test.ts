/**
 * @file db-host-shutdown-cascade.test.ts
 * @description ISS-5262 — a graceful db-host exit at quit must not cascade into
 * a burst of failures AFTER `shutdown sequence end: clean`.
 *
 * The observed production log:
 *
 * ```
 * [shutdown]  shutdown sequence end: clean
 * [agent-session-sync]  sync failed: db-host exited (code: 0)
 * [agent-collectors]    collector claude import failed: db-host exited (code: 0)
 * [agent-dashboard]     ipc perf session_count query failed: db-host is closed (op: sessions.count)
 * Error occurred in handler for 'desktop:shared-agent-sessions:usage': Error: db-host exited (code: 0)
 * ```
 *
 * ISS-4713 already stopped the RELABEL ("exited unexpectedly") and the
 * mid-shutdown restart; ISS-4903 already drained the transcript lane. What was
 * left is the error `handleExit` fans out to every pending op: consumers could
 * not tell a benign quit from a real fault, so they all reported one.
 *
 * The legs pinned here, all with injected timers (no wall-clock waits), per the
 * `test:node` determinism rules:
 *
 *  1. The classifier recognizes a graceful shutdown failure — and REFUSES a
 *     crash-signal exit code, so a real crash can never be laundered as benign.
 *  2. A graceful exit inside the shutdown window yields a CLASSIFIABLE
 *     rejection, logs nothing, and re-forks nothing.
 *  3. An unexpected non-zero exit outside the window still logs
 *     "exited unexpectedly" AND still restarts — unchanged.
 *  4. A non-zero exit INSIDE the shutdown window is still NOT classified benign.
 *  5. `withDb` resolves the payload-free shutdown sentinel instead of rejecting
 *     (the ipcMain handler error), while a genuine failure still rejects.
 *  6. End to end: an in-flight `desktop:shared-agent-sessions:usage` read racing
 *     the exit settles WITHOUT throwing, and no consumer emits a failure line
 *     after the `clean` marker.
 *  7. The perf wide event is DROPPED rather than emitted with a fabricated
 *     `session_count: 0` the COUNT never measured.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { IpcMainInvokeEvent } from "electron";
import { createDbIpcHandlerWrappers } from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import {
  instrumentIpcPerf,
  ipcSessionCount,
} from "../src/main/dashboard/agent-dashboard-ipc-perf.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import { DbHostClient } from "../src/main/database/db-host/db-host-client.js";
import {
  DbHostRequestKind,
  DbHostResponseKind,
} from "../src/main/database/db-host/db-host-protocol.js";
import type { DbHostAgentDatabase } from "../src/main/database/sqlite.js";
import { runShutdownSequence } from "../src/main/lifecycle/shutdown.js";
import {
  DesktopIpcOperation,
  type DesktopIpcPerfEventInput,
} from "../src/main/telemetry/app-otel-runtime.js";
import {
  DB_HOST_SHUTTING_DOWN_STATUS,
  isDbHostShuttingDownResult,
} from "../src/shared/db-host-shutdown-contract.js";
import {
  DbHostShutdownError,
  DbHostShutdownReason,
  isDbHostShutdownError,
  isGracefulDbHostExitCode,
} from "../src/shared/db-host-shutdown-error.js";
import type {
  DbHostChildExitListener,
  DbHostChildListenerArgs,
  DbHostChildMessageListener,
} from "./db-host-fake-child-support.js";

/** The exact marker the shutdown sequence prints when it claims a clean quit. */
const CLEAN_MARKER = "shutdown sequence end: clean";
/** SIGSEGV's signal number — the shape a native crash reports as its exit code. */
const CRASH_EXIT_CODE = 11;
/** A representative genuine failure, used to prove nothing benign is inferred. */
const SQLITE_BUSY_PATTERN = /SQLITE_BUSY/;

type PostedRequest = { kind: string; id?: number };

function makeFakeChild() {
  const posted: PostedRequest[] = [];
  let exitListener: DbHostChildExitListener | undefined;
  let messageListener: DbHostChildMessageListener | undefined;
  let killed = false;
  const child = {
    stderr: null,
    on(...args: DbHostChildListenerArgs): unknown {
      if (args[0] === "exit") {
        exitListener = args[1];
      }
      if (args[0] === "message") {
        messageListener = args[1];
      }
      return child;
    },
    postMessage(message: PostedRequest) {
      posted.push(message);
    },
    kill() {
      killed = true;
    },
  };
  return {
    child,
    posted,
    isKilled: () => killed,
    exit(code: number | null) {
      exitListener?.(code);
    },
    ready() {
      const initId = posted.find((m) => m.kind === DbHostRequestKind.Init)?.id;
      messageListener?.({ kind: DbHostResponseKind.Ready, id: initId });
    },
  };
}

type FakeTimerHandle = { fn: () => void; ms: number };

function makeFakeTimer() {
  const pending = new Set<FakeTimerHandle>();
  const setTimeoutFn = ((fn: () => void, ms?: number) => {
    const handle: FakeTimerHandle = { fn, ms: ms ?? 0 };
    pending.add(handle);
    return handle as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = ((handle?: unknown) => {
    if (handle) {
      pending.delete(handle as FakeTimerHandle);
    }
  }) as unknown as typeof clearTimeout;
  return {
    setTimeoutFn,
    clearTimeoutFn,
    armedCount: () => pending.size,
    fire() {
      const handles = [...pending];
      pending.clear();
      for (const handle of handles) {
        handle.fn();
      }
    },
  };
}

/**
 * Start a ready client over a fresh fake child, recording every child the fork
 * seam produced so a restart (a SECOND fork) is directly observable.
 */
async function startReadyClient(
  timer: ReturnType<typeof makeFakeTimer>,
  onLog: (message: string) => void = () => {
    // default: swallow
  }
) {
  const children: ReturnType<typeof makeFakeChild>[] = [];
  const client = new DbHostClient({
    onEmit: () => {
      // unused
    },
    onLog,
    fork: () => {
      const next = makeFakeChild();
      children.push(next);
      return next.child;
    },
    setTimeoutFn: timer.setTimeoutFn,
    clearTimeoutFn: timer.clearTimeoutFn,
  });
  const started = client.start({ dataDir: "/tmp/db" });
  children[0].ready();
  await started;
  return { client, children, forkCount: () => children.length };
}

/** Settle pending microtasks so a rejection/resolution lands before asserting. */
async function flush(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await Promise.resolve();
  }
}

/** Capture how an invoke settled, without an unhandled rejection. */
function settle(work: Promise<unknown>) {
  const record: {
    status: "pending" | "resolved" | "rejected";
    value: unknown;
  } = { status: "pending", value: undefined };
  work.then(
    (value) => {
      record.status = "resolved";
      record.value = value;
    },
    (error: unknown) => {
      record.status = "rejected";
      record.value = error;
    }
  );
  return record;
}

/** Minimal runtime options — only three fields are non-optional. */
function fakeRuntimeOptions(): AgentDashboardDesignSystemRuntimeOptions {
  return {
    getWindow: () => null,
    isTrustedSender: () => true,
    onTerminalFailure: () => {
      // unused
    },
  } as AgentDashboardDesignSystemRuntimeOptions;
}

/**
 * A trusted `IpcMainInvokeEvent` stand-in. `withDb` reads only `event.sender`,
 * and the fake options above trust every sender.
 */
function trustedEvent(): IpcMainInvokeEvent {
  return { sender: {} } as unknown as IpcMainInvokeEvent;
}

test("the classifier accepts a graceful shutdown failure and refuses a crash", () => {
  assert.equal(isGracefulDbHostExitCode(0), true, "code 0 is graceful");
  assert.equal(
    isGracefulDbHostExitCode(null),
    true,
    "an unreported code during teardown degrades to the benign path"
  );
  assert.equal(
    isGracefulDbHostExitCode(CRASH_EXIT_CODE),
    false,
    "a crash-signal exit code is never graceful"
  );

  assert.equal(
    isDbHostShutdownError(
      new DbHostShutdownError(DbHostShutdownReason.Exited, "db-host exited")
    ),
    true,
    "the typed error classifies"
  );
  // An error serialized out of the db-host child loses its prototype and is
  // rebuilt by `rebuildError`, which restores `name` but not the class.
  const rebuilt = new Error("db-host is closed (op: sessions.count)");
  rebuilt.name = "DbHostShutdownError";
  assert.equal(
    isDbHostShutdownError(rebuilt),
    true,
    "a prototype-less error still classifies by name"
  );
  // `handleExit` mints this SAME string on the crash branch too, so the message
  // alone can never prove a shutdown — only the class can.
  assert.equal(
    isDbHostShutdownError(new Error("db-host exited (code: 0)")),
    false,
    "an untyped exited-message is NOT assumed benign: an unexpected code-0 exit " +
      "would otherwise be quietly reclassified while the client re-forks"
  );
  assert.equal(
    isDbHostShutdownError(new Error("db-host is closed (op: sessions.count)")),
    true,
    "the closed-client rejection classifies"
  );
  assert.equal(
    isDbHostShutdownError(new Error("db-host is closing (op: sessions.count)")),
    true,
    "the closing-client rejection classifies"
  );

  assert.equal(
    isDbHostShutdownError(
      new DbHostShutdownError(
        DbHostShutdownReason.Exited,
        `db-host exited (code: ${CRASH_EXIT_CODE})`
      )
    ),
    true,
    "the class, not the code in the message, is what the predicate reads"
  );
  assert.equal(
    isDbHostShutdownError(new Error("SQLITE_BUSY: database is locked")),
    false,
    "an unrelated failure is not classified"
  );
  assert.equal(
    isDbHostShutdownError("db-host exited (code: 0)"),
    false,
    "a non-Error value is not classified"
  );
});

test("a graceful exit inside the shutdown window: classifiable, no log, no restart", async () => {
  const logs: string[] = [];
  const timer = makeFakeTimer();
  const { client, children, forkCount } = await startReadyClient(timer, (m) =>
    logs.push(m)
  );

  const pending = settle(client.invoke("sessions.count", []));
  await flush();

  // Quit begins, then the child exits cleanly while the read is still pending.
  client.beginClosing();
  children[0].exit(0);
  await flush();

  assert.equal(pending.status, "rejected", "the pending read still settles");
  // Assert the CLASS, not just `isDbHostShutdownError` — the classifier also
  // accepts the legacy message shape, so a message-only assertion would stay
  // green if `handleExit` stopped minting the typed error at all. The typed
  // error is the primary mechanism; the message fallback exists for version
  // skew (pinned separately by the classifier test above), not as a substitute.
  assert.ok(
    pending.value instanceof DbHostShutdownError,
    `handleExit must mint the typed error; got ${String(pending.value)}`
  );
  assert.equal(
    (pending.value as DbHostShutdownError).reason,
    DbHostShutdownReason.Exited,
    "and it names the graceful-exit reason"
  );
  assert.equal(
    isDbHostShutdownError(pending.value),
    true,
    "the rejection is classifiable as a shutdown, so consumers can stay quiet"
  );
  assert.equal(
    (pending.value as Error).message,
    "db-host exited (code: 0)",
    "the message is unchanged, so an older consumer still classifies it"
  );
  assert.deepEqual(logs, [], "a graceful teardown exit logs nothing");
  // Fire any timer a regression might have armed, then prove no re-fork.
  timer.fire();
  await flush();
  assert.equal(forkCount(), 1, "no restart was scheduled mid-shutdown");
});

test("a read issued against a closing/closed client rejects with the typed error", async () => {
  const timer = makeFakeTimer();
  const { client, children } = await startReadyClient(timer);

  // Queued on `ready` when the teardown window opens — the `db-host is closing`
  // arm. `ready` is already settled here, so the check runs in the continuation.
  client.beginClosing();
  const closing = settle(client.invoke("sessions.count", []));
  await flush();
  assert.equal(closing.status, "rejected");
  assert.ok(
    closing.value instanceof DbHostShutdownError,
    `the closing rejection must be typed; got ${String(closing.value)}`
  );
  assert.equal(
    (closing.value as DbHostShutdownError).reason,
    DbHostShutdownReason.Closing
  );

  // And after close() completes — the `db-host is closed (op: …)` arm, which is
  // exactly the `ipc perf session_count query failed` line from the ticket.
  const closed = client.close();
  children[0].exit(0);
  timer.fire();
  await closed;
  const afterClose = settle(client.invoke("sessions.count", []));
  await flush();
  assert.equal(afterClose.status, "rejected");
  assert.ok(
    afterClose.value instanceof DbHostShutdownError,
    `the closed rejection must be typed; got ${String(afterClose.value)}`
  );
  assert.equal(
    (afterClose.value as DbHostShutdownError).reason,
    DbHostShutdownReason.Closed
  );
  assert.equal(
    (afterClose.value as Error).message,
    "db-host is closed (op: sessions.count)",
    "the message is unchanged for an older consumer"
  );
});

test("an unexpected non-zero exit still logs AND still restarts", async () => {
  const logs: string[] = [];
  const timer = makeFakeTimer();
  const { client, children, forkCount } = await startReadyClient(timer, (m) =>
    logs.push(m)
  );

  const pending = settle(client.invoke("sessions.count", []));
  await flush();

  // No beginClosing()/close(): this is a real crash, not a quit.
  children[0].exit(CRASH_EXIT_CODE);
  await flush();

  assert.equal(pending.status, "rejected", "the pending read rejects");
  assert.equal(
    isDbHostShutdownError(pending.value),
    false,
    "a crash is NOT classified benign — consumers must still report it"
  );
  assert.ok(
    logs.some((line) => line.includes("exited unexpectedly")),
    `the crash is still logged loudly; saw ${JSON.stringify(logs)}`
  );
  // The backoff timer elapses → the client re-forks (the existing self-heal).
  timer.fire();
  await flush();
  assert.equal(forkCount(), 2, "the crashed child was restarted");
});

test("a non-zero exit during shutdown is still not treated as benign", async () => {
  const timer = makeFakeTimer();
  const { client, children } = await startReadyClient(timer);

  const pending = settle(client.invoke("sessions.count", []));
  await flush();

  client.beginClosing();
  children[0].exit(CRASH_EXIT_CODE);
  await flush();

  assert.equal(pending.status, "rejected");
  assert.equal(
    isDbHostShutdownError(pending.value),
    false,
    "the app was quitting, but the child still died to a signal — say so"
  );
});

test("withDb resolves the shutdown sentinel instead of rejecting", async () => {
  const { withDb } = createDbIpcHandlerWrappers({
    getAgentDatabase: () => Promise.resolve({} as DbHostAgentDatabase),
    options: fakeRuntimeOptions(),
  });
  const handler = withDb(() =>
    Promise.reject(
      new DbHostShutdownError(
        DbHostShutdownReason.Exited,
        "db-host exited (code: 0)"
      )
    )
  );

  const result = await handler(trustedEvent());

  assert.equal(
    isDbHostShuttingDownResult(result),
    true,
    "the handler resolved the sentinel — ipcMain prints no handler error"
  );
  // The sentinel must be unmistakable for data: no counts, no totals, no zero.
  assert.deepEqual(
    result,
    { status: DB_HOST_SHUTTING_DOWN_STATUS },
    "the sentinel carries no payload a caller could render as a real value"
  );
});

test("withDb still rejects a genuine query failure", async () => {
  const { withDb } = createDbIpcHandlerWrappers({
    getAgentDatabase: () => Promise.resolve({} as DbHostAgentDatabase),
    options: fakeRuntimeOptions(),
  });
  const handler = withDb(() =>
    Promise.reject(new Error("SQLITE_BUSY: database is locked"))
  );

  await assert.rejects(
    () => handler(trustedEvent()),
    SQLITE_BUSY_PATTERN,
    "a real failure must still surface as a handler error"
  );
});

test("an in-flight usage read racing the exit throws nothing after 'clean'", async () => {
  const logs: string[] = [];
  const timer = makeFakeTimer();
  const { client, children } = await startReadyClient(timer, (m) =>
    logs.push(`[agent-sqlite] ${m}`)
  );

  // The db read every dashboard handler makes, wired through the real wrapper:
  // `sessions.count` is the FEA-2211 perf COUNT the instrumentation also issues.
  const agentDatabase = {
    sessions: {
      count: () => client.invoke("sessions.count", []),
    },
  } as unknown as DbHostAgentDatabase;
  const { withDb } = createDbIpcHandlerWrappers({
    getAgentDatabase: () => Promise.resolve(agentDatabase),
    options: fakeRuntimeOptions(),
  });
  const usageHandler = withDb(
    instrumentIpcPerf(
      DesktopIpcOperation.Usage,
      (input: DesktopIpcPerfEventInput) =>
        logs.push(`[perf] ${input.operation}`),
      () => client.invoke("sessions.usage", []),
      {
        random: () => 0,
        onSessionCountError: (error: unknown) =>
          logs.push(
            `[agent-dashboard] ipc perf session_count query failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          ),
      }
    )
  );

  // The read is in flight when quit begins.
  const usage = settle(usageHandler(trustedEvent()));
  await flush();

  client.beginClosing();
  const sequence = await runShutdownSequence(
    {
      updateCheckTimer: null,
      clearUpdateCheckTimer: () => {
        // no-op
      },
      observability: { shutdown: () => Promise.resolve() },
      cloudSocket: {
        stop: () => {
          // no-op
        },
      },
      commandExecutor: {
        dispose: () => {
          // no-op
        },
      },
      agentMonitor: {
        stop: () => {
          // no-op
        },
      },
      server: { stop: () => Promise.resolve() },
      desktopWindow: {
        dispose: () => {
          // no-op
        },
      },
      tray: {
        dispose: () => {
          // no-op
        },
      },
      log: (message: string) => logs.push(`[shutdown] ${message}`),
    },
    { setTimeoutFn: timer.setTimeoutFn }
  );

  assert.equal(sequence, "clean", "the sequence reports a clean shutdown");
  const cleanIndex = logs.findIndex((line) => line.includes(CLEAN_MARKER));
  assert.ok(cleanIndex >= 0, "the clean marker was logged");

  // NOW the db-host exits, exactly as it did in production — after `clean`.
  children[0].exit(0);
  await flush();

  assert.equal(
    usage.status,
    "resolved",
    "the racing usage read RESOLVED; a rejection is what Electron printed as " +
      "\"Error occurred in handler for 'desktop:shared-agent-sessions:usage'\""
  );
  assert.equal(
    isDbHostShuttingDownResult(usage.value),
    true,
    "and it resolved to the sentinel, not to fabricated usage data"
  );
  // The contract this whole ticket is about: `clean` is not contradicted.
  const afterClean = logs.slice(cleanIndex + 1);
  assert.deepEqual(
    afterClean.filter(
      (line) => line.includes("failed") || line.includes("Error")
    ),
    [],
    `nothing failed after the clean marker; saw ${JSON.stringify(afterClean)}`
  );
});

test("a shutdown-time session COUNT reports unknown, never a fabricated 0", async () => {
  const shuttingDown = {
    sessions: {
      count: () =>
        Promise.reject(new Error("db-host is closed (op: sessions.count)")),
    },
  } as unknown as DbHostAgentDatabase;
  const reported: unknown[] = [];

  const count = await ipcSessionCount(shuttingDown, (error) =>
    reported.push(error)
  );

  assert.equal(count, null, "unknown, not 0 — the COUNT never ran");
  assert.deepEqual(reported, [], "and nothing was reported as a failure");
});

test("a real COUNT failure still falls back to 0 AND reports", async () => {
  const broken = {
    sessions: {
      count: () => Promise.reject(new Error("SQLITE_BUSY: database is locked")),
    },
  } as unknown as DbHostAgentDatabase;
  const reported: unknown[] = [];

  const count = await ipcSessionCount(broken, (error) => reported.push(error));

  assert.equal(count, 0, "the FEA-2211 observable fallback is unchanged");
  assert.equal(reported.length, 1, "and the failure is still surfaced");
});

test("no perf wide event is emitted when the count is unknown", async () => {
  const events: DesktopIpcPerfEventInput[] = [];
  const shuttingDown = {
    sessions: {
      count: () =>
        Promise.reject(new Error("db-host is closed (op: sessions.count)")),
    },
  } as unknown as DbHostAgentDatabase;
  const instrumented = instrumentIpcPerf(
    DesktopIpcOperation.Usage,
    (input) => events.push(input),
    () => Promise.resolve({ items: [] }),
    { random: () => 0 }
  );

  await instrumented(shuttingDown);

  assert.deepEqual(
    events,
    [],
    "a wide event is either true or absent — never session_count: 0 by default"
  );
});
