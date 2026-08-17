/**
 * ISS-4758 child process: arm a REAL desktop sync poller and never call
 * `stop()`, then let the script end.
 *
 * The process can only exit if the poll handle is `unref`'d. That is the actual
 * failure mode behind the outage — an assertion threw between `start()` and
 * `stop()` in a test, the referenced 5s interval survived, and because
 * `node --test` bounds a TEST but never a test FILE's process, the whole desktop
 * suite hung until the 30-minute CI cap cancelled it.
 *
 * The arm/unref counters exist so the parent can tell a genuine pass from a
 * VACUOUS one: if the service stopped arming a timer at all (a `shouldRun()`
 * gate change, say), the process would still exit and a naive "it exited" test
 * would go green while pinning nothing.
 */
import { AgentComponentInvocationSyncService } from "../src/main/agent-sync/agent-component-invocation-sync-service.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";

type Counters = { armed: number; unrefed: number };

const counters: Counters = { armed: 0, unrefed: 0 };

function countHandle(handle: NodeJS.Timeout): NodeJS.Timeout {
  counters.armed += 1;
  const realUnref = handle.unref.bind(handle);
  handle.unref = () => {
    counters.unrefed += 1;
    return realUnref();
  };
  return handle;
}

function installTimerProbe(): void {
  const realSetInterval = globalThis.setInterval;
  const realSetTimeout = globalThis.setTimeout;
  // biome-ignore lint/suspicious/noExplicitAny: probing the ambient timer API
  globalThis.setInterval = ((fn: any, ms?: number, ...args: any[]) =>
    countHandle(realSetInterval(fn, ms, ...args))) as typeof setInterval;
  // biome-ignore lint/suspicious/noExplicitAny: probing the ambient timer API
  globalThis.setTimeout = ((fn: any, ms?: number, ...args: any[]) =>
    countHandle(realSetTimeout(fn, ms, ...args))) as typeof setTimeout;
}

function startSessionLane(): void {
  new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => null,
    sendBatch: () => Promise.resolve({ accepted: true as const }),
  }).start();
}

function startInvocationLane(): void {
  new AgentComponentInvocationSyncService({
    isReady: () => true,
    getSource: () => null,
    getComputeTargetId: () => null,
    sendPart: () =>
      Promise.resolve({ kind: "retry" as const, error: "unused" }),
  }).start();
}

const lane = process.argv.at(-1);
installTimerProbe();
if (lane === "session") {
  startSessionLane();
} else if (lane === "invocation") {
  startInvocationLane();
} else {
  process.stderr.write(`unknown lane: ${String(lane)}\n`);
  process.exit(2);
}

// The invocation lane arms its next tick from a `.finally()` continuation, so
// let the queued work settle before reporting — otherwise the counters read 0
// and the parent's vacuity guard trips on a lane that is in fact fine.
await new Promise<void>((resolve) => {
  setImmediate(resolve);
});

// Deliberately NO stop(). Report what the lane armed, then fall off the end of
// the script: an un-`unref`'d handle would keep this process alive forever.
process.stdout.write(
  `${JSON.stringify({ armed: counters.armed, unrefed: counters.unrefed })}\n`
);
