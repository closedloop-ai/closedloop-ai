/**
 * @file db-host-exit-harness.ts
 * @description ISS-5808 — the ONE fault-injection fixture for "the db-host child
 * exits with code 0 while work is in flight".
 *
 * Nine consumers died together in the two live captures (transcript-sync, three
 * collector live imports, a session backfill, the DATA_REVISION rebuild,
 * pending-sync discovery, `desktop:db:get-insights`,
 * `desktop:get-transcript-sync-status`, and both `page-data` channels), so the
 * suites that cover them share one harness rather than nine bespoke setups —
 * otherwise each re-derives the Electron delivery order that made ISS-5715 so
 * hard to see, and they drift.
 *
 * Timers are INJECTED, never real: `runRestartBackoff()` fires the ladder's
 * pending timer synchronously, so every assertion is on an attempt/call COUNT
 * rather than on elapsed time (the repo's no-timing-assertions rule).
 */
import { DbHostClient } from "../../src/main/database/db-host/db-host-client.js";
import {
  DbHostRequestKind,
  DbHostResponseKind,
} from "../../src/main/database/db-host/db-host-protocol.js";
import type {
  DbHostChildExitListener,
  DbHostChildListenerArgs,
  DbHostChildMessageListener,
} from "../db-host-fake-child-support.js";

/** Microtask hops drained between synchronous steps. */
const MICROTASK_DRAIN_TURNS = 50;

export type FakeDbHostChild = {
  readonly posted: { kind: string; id?: number; op?: string }[];
  /** Deliver a child exit through the client's registered listener. */
  exit: (code: number | null) => void;
  /** Complete this child's pending Init reply so start()/restart resolves. */
  ready: () => void;
  /** Resolve the last Invoke posted to this child. */
  resolveLastInvoke: (value: unknown) => void;
  /** Op paths this child received, in order. */
  invokedOps: () => string[];
};

export type DbHostExitHarness = {
  readonly client: DbHostClient;
  /** Every child forked so far, oldest first. */
  readonly children: FakeDbHostChild[];
  /** The live child (the most recent fork). */
  currentChild: () => FakeDbHostChild;
  /** Log lines the client emitted. */
  readonly logs: string[];
  /** Fire the ladder's pending restart-backoff timer, if one is armed. */
  runRestartBackoff: () => void;
  /** How many restart timers were armed. */
  armedRestartCount: () => number;
  /** Drain the microtask queue. */
  settle: () => Promise<void>;
};

/**
 * Build a fake forked child that captures the client's listeners, so a test can
 * deliver `Ready`, a `Result`, and `exit` in whatever order it needs.
 */
function makeFakeChild(): { child: unknown; api: FakeDbHostChild } {
  const posted: { kind: string; id?: number; op?: string }[] = [];
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
    postMessage(message: { kind: string; id?: number; op?: string }) {
      posted.push(message);
    },
    kill() {
      // no-op for the fake
    },
  };
  return {
    child,
    api: {
      posted,
      exit(code) {
        exitListener?.(code);
      },
      ready() {
        const initId = posted.find(
          (m) => m.kind === DbHostRequestKind.Init
        )?.id;
        messageListener?.({ kind: DbHostResponseKind.Ready, id: initId });
      },
      resolveLastInvoke(value) {
        const invokeId = posted
          .filter((m) => m.kind === DbHostRequestKind.Invoke)
          .at(-1)?.id;
        messageListener?.({
          kind: DbHostResponseKind.Result,
          id: invokeId,
          ok: true,
          value,
        });
      },
      invokedOps() {
        return posted
          .filter((m) => m.kind === DbHostRequestKind.Invoke)
          .map((m) => m.op ?? "");
      },
    },
  };
}

export async function drainMicrotasks(): Promise<void> {
  for (let turn = 0; turn < MICROTASK_DRAIN_TURNS; turn++) {
    await Promise.resolve();
  }
}

/**
 * Start a `DbHostClient` over fake children with an injected timer, and resolve
 * once the first child has reported Ready.
 */
export async function startDbHostExitHarness(): Promise<DbHostExitHarness> {
  const children: FakeDbHostChild[] = [];
  const logs: string[] = [];
  const armedTimers: (() => void)[] = [];
  let pendingTimer: (() => void) | null = null;

  const setTimeoutFn = ((callback: () => void) => {
    pendingTimer = callback;
    armedTimers.push(callback);
    return armedTimers.length;
    // The client's option is typed as the global setTimeout; only the
    // (callback, delay) arity is ever used by the restart ladder and the
    // shutdown budgets, and a test that needs the budgets drives them the same
    // way. The cast is on the injection seam, not on production code.
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = (() => {
    pendingTimer = null;
  }) as unknown as typeof clearTimeout;

  const client = new DbHostClient({
    onEmit: () => {
      // no-op
    },
    onLog: (message) => logs.push(message),
    setTimeoutFn,
    clearTimeoutFn,
    fork: () => {
      const { child, api } = makeFakeChild();
      children.push(api);
      // The structural DbHostProcess shape is satisfied by the fake; the cast is
      // on the test seam the client exposes for exactly this purpose.
      return child as ReturnType<
        NonNullable<ConstructorParameters<typeof DbHostClient>[0]["fork"]>
      >;
    },
  });

  const started = client.start({ dataDir: "iss-5808-harness" });
  await drainMicrotasks();
  children[0].ready();
  await started;

  return {
    client,
    children,
    currentChild: () => children.at(-1) as FakeDbHostChild,
    logs,
    runRestartBackoff() {
      const timer = pendingTimer;
      pendingTimer = null;
      timer?.();
    },
    armedRestartCount: () => armedTimers.length,
    settle: drainMicrotasks,
  };
}
