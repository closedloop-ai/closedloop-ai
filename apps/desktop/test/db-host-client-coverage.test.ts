/**
 * @file db-host-client-coverage.test.ts
 * @description ISS-10514 — `DbHostClient` (main's transport to the db-host
 * utilityProcess) on the paths its sibling `db-host-*` suites do not reach:
 * notification routing, replies for ids nobody awaits, a null exit code, identity changes around the Init handshake,
 * the background-read flag, calls on a closed or child-less client, and the
 * restart ladder's non-Error fork failure and failed shutdown kill.
 *
 * Children are fakes handed in through the `fork` seam. Timers are Vitest's
 * fake clock, installed before each client is built and restored in
 * `afterEach`; the tests assert on posted requests, callbacks, and log lines,
 * never on elapsed time.
 */

import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DbHostClient } from "../src/main/database/db-host/db-host-client.js";
import { MemoryPressureLevel } from "../src/main/database/db-host/db-host-memory-watchdog.js";
import {
  type DbHostInitOptions,
  type DbHostRequest,
  DbHostRequestKind,
  DbHostResponseKind,
  type DbHostUserIdentity,
} from "../src/main/database/db-host/db-host-protocol.js";
import {
  PARSE_POLICY_ATTRIBUTION,
  PARSE_POLICY_BASE,
} from "../src/main/parse-policy/parse-policy.js";
import { runAsBackgroundDbReads } from "../src/shared/db-host-call-priority.js";
import { DbHostExitError } from "../src/shared/db-host-exit-error.js";
import type {
  DbHostChildExitListener,
  DbHostChildListenerArgs,
  DbHostChildMessageListener,
} from "./db-host-fake-child-support.js";
import { drainMicrotasks } from "./helpers/db-host-exit-harness.js";

const OP = "sessions.getAll";
const INIT: DbHostInitOptions = { dataDir: "iss-10514-db-host-client" };
const SIGNED_IN: DbHostUserIdentity = {
  userId: "user-1",
  organizationId: "org-1",
};
const OTHER_USER: DbHostUserIdentity = {
  userId: "user-2",
  organizationId: "org-2",
};
const KILL_FAILED_LOG = /^db-host kill during shutdown failed: (.+)$/;
const RESTART_FAILED_LOG = /^db-host restart failed, retrying: (.+)$/;

type FakeChild = {
  posted: DbHostRequest[];
  send: (message: unknown) => void;
  exit: (code: number | null) => void;
  ready: () => void;
  kills: () => number;
};

type ForkPlan = {
  /** Thrown instead of forking, for the given 1-based fork ordinal. */
  forkThrow?: (ordinal: number) => unknown;
  /** Thrown by `kill()` on every child. */
  killThrow?: unknown;
  /** Build the client with no `onSessionTerminal` handler. */
  withoutSessionTerminal?: boolean;
};

type Harness = {
  client: DbHostClient;
  children: FakeChild[];
  logs: string[];
  emits: string[];
  terminals: { sessionId: string; status: string }[];
};

function makeChild(plan: ForkPlan): {
  child: FakeChildProcess;
  api: FakeChild;
} {
  const posted: DbHostRequest[] = [];
  let messageListener: DbHostChildMessageListener | undefined;
  let exitListener: DbHostChildExitListener | undefined;
  let kills = 0;
  const child: FakeChildProcess = {
    stderr: null,
    on(...args: DbHostChildListenerArgs): unknown {
      if (args[0] === "message") {
        messageListener = args[1];
      } else {
        exitListener = args[1];
      }
      return child;
    },
    postMessage(message: DbHostRequest) {
      posted.push(message);
    },
    kill() {
      kills += 1;
      if (plan.killThrow !== undefined) {
        throw plan.killThrow;
      }
    },
  };
  const send = (message: unknown) => messageListener?.(message);
  return {
    child,
    api: {
      posted,
      send,
      exit: (code) => exitListener?.(code),
      ready: () =>
        send({
          kind: DbHostResponseKind.Ready,
          id: posted.find((m) => m.kind === DbHostRequestKind.Init)?.id,
        }),
      kills: () => kills,
    },
  };
}

type FakeChildProcess = {
  stderr: null;
  on: (...args: DbHostChildListenerArgs) => unknown;
  postMessage: (message: DbHostRequest) => void;
  kill: () => void;
};

function makeHarness(plan: ForkPlan = {}): Harness {
  const children: FakeChild[] = [];
  const logs: string[] = [];
  const emits: string[] = [];
  const terminals: { sessionId: string; status: string }[] = [];
  let forks = 0;
  const client = new DbHostClient({
    onEmit: (sessionId) => emits.push(sessionId),
    onLog: (message) => logs.push(message),
    ...(plan.withoutSessionTerminal
      ? {}
      : {
          onSessionTerminal: (notice: { sessionId: string; status: string }) =>
            terminals.push(notice),
        }),
    fork: () => {
      forks += 1;
      if (plan.forkThrow) {
        const thrown = plan.forkThrow(forks);
        if (thrown !== undefined) {
          throw thrown;
        }
      }
      const { child, api } = makeChild(plan);
      children.push(api);
      return child;
    },
  });
  return {
    client,
    children,
    logs,
    emits,
    terminals,
  };
}

async function startedHarness(plan: ForkPlan = {}): Promise<Harness> {
  const harness = makeHarness(plan);
  const started = harness.client.start(INIT);
  harness.children[0].ready();
  await started;
  return harness;
}

function lastInvokeId(child: FakeChild): number {
  const invoke = child.posted.findLast(
    (message) => message.kind === DbHostRequestKind.Invoke
  );
  if (invoke?.kind !== DbHostRequestKind.Invoke) {
    throw new Error("no Invoke posted");
  }
  return invoke.id;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("child notifications", () => {
  it("routes emit, session-terminal, and log to their callbacks", async () => {
    const harness = await startedHarness();
    const child = harness.children[0];
    child.send({ kind: DbHostResponseKind.Emit, sessionId: "session-1" });
    child.send({
      kind: DbHostResponseKind.SessionTerminal,
      sessionId: "session-2",
      status: SESSION_STATUS.ERROR,
    });
    child.send({ kind: DbHostResponseKind.Log, message: "child says hi" });

    expect(harness.emits).toEqual(["session-1"]);
    expect(harness.terminals).toEqual([
      { sessionId: "session-2", status: SESSION_STATUS.ERROR },
    ]);
    expect(harness.logs).toEqual(["child says hi"]);
  });

  it("drops a session-terminal notice when no handler is wired and keeps routing", async () => {
    const harness = await startedHarness({ withoutSessionTerminal: true });
    const child = harness.children[0];
    expect(() =>
      child.send({
        kind: DbHostResponseKind.SessionTerminal,
        sessionId: "session-3",
        status: SESSION_STATUS.INACTIVE,
      })
    ).not.toThrow();
    child.send({ kind: DbHostResponseKind.Log, message: "still routed" });
    expect(harness.terminals).toEqual([]);
    expect(harness.logs).toEqual(["still routed"]);
  });

  it("reads memory pressure against the default wall clock when no clock is injected", async () => {
    const harness = await startedHarness();
    expect(harness.client.isUnderMemoryPressure()).toBe(false);
    harness.children[0].send({
      kind: DbHostResponseKind.MemoryPressure,
      level: MemoryPressureLevel.High,
    });
    expect(harness.client.isUnderMemoryPressure()).toBe(true);
  });
});

describe("correlated replies", () => {
  it("ignores Ready and Result for ids nobody is waiting on", async () => {
    const harness = await startedHarness();
    const child = harness.children[0];
    const pending = harness.client.invoke(OP, []);
    await drainMicrotasks();
    const id = lastInvokeId(child);

    child.send({ kind: DbHostResponseKind.Ready, id: id + 50 });
    child.send({
      kind: DbHostResponseKind.Result,
      id: id + 51,
      ok: true,
      value: "stray",
    });
    expect(harness.client.pendingRequestCount).toBe(1);

    child.send({
      kind: DbHostResponseKind.Result,
      id,
      ok: true,
      value: "mine",
    });
    await expect(pending).resolves.toBe("mine");
  });

  it("a failed Result rejects with the child's rebuilt error", async () => {
    const harness = await startedHarness();
    const child = harness.children[0];
    const pending = harness.client.invoke(OP, []);
    await drainMicrotasks();
    child.send({
      kind: DbHostResponseKind.Result,
      id: lastInvokeId(child),
      ok: false,
      error: { message: "no such table", name: "SqliteError" },
    });
    await expect(pending).rejects.toMatchObject({
      message: "no such table",
      name: "SqliteError",
    });
    expect(harness.client.pendingRequestCount).toBe(0);
  });
});

describe("an exit with a null code", () => {
  it("names the code null in the rejection of the op it took down", async () => {
    const harness = await startedHarness();
    const child = harness.children[0];
    const pending = harness.client.invoke(OP, []);
    await drainMicrotasks();
    child.exit(null);

    const error = await pending.then(
      () => null,
      (reason: unknown) => reason
    );
    expect(error).toBeInstanceOf(DbHostExitError);
    expect(error).toMatchObject({
      message: "db-host exited (code: null)",
      exitCode: null,
      restartScheduled: true,
    });
    await harness.client.close();
  });
});

describe("identity around the Init handshake", () => {
  it("re-sends the current identity when it changed while Init was in flight", async () => {
    const harness = makeHarness();
    const started = harness.client.start({ ...INIT, identity: SIGNED_IN });
    harness.client.setUserIdentity(OTHER_USER);
    const child = harness.children[0];
    child.ready();
    await started;

    const identityPosts = child.posted.filter(
      (message) => message.kind === DbHostRequestKind.SetUserIdentity
    );
    // One from setUserIdentity itself, one from the post-Init correction.
    expect(identityPosts).toEqual([
      { kind: DbHostRequestKind.SetUserIdentity, identity: OTHER_USER },
      { kind: DbHostRequestKind.SetUserIdentity, identity: OTHER_USER },
    ]);
  });

  it("sends no identity correction when the identity did not change during Init", async () => {
    const harness = makeHarness();
    const started = harness.client.start({ ...INIT, identity: SIGNED_IN });
    const child = harness.children[0];
    child.ready();
    await started;
    expect(
      child.posted.filter(
        (message) => message.kind === DbHostRequestKind.SetUserIdentity
      )
    ).toEqual([]);
  });

  it("a restart forks the replacement with the identity set after boot", async () => {
    const harness = await startedHarness();
    harness.client.setUserIdentity(OTHER_USER);
    harness.children[0].exit(1);
    vi.runOnlyPendingTimers();
    expect(harness.children).toHaveLength(2);
    const init = harness.children[1].posted.find(
      (message) => message.kind === DbHostRequestKind.Init
    );
    expect(init).toMatchObject({
      kind: DbHostRequestKind.Init,
      options: { ...INIT, identity: OTHER_USER },
    });
  });

  it("a restart forks the replacement with the parse policy retained after boot (ISS-12552)", async () => {
    const harness = makeHarness();
    const started = harness.client.start({
      ...INIT,
      parsePolicy: PARSE_POLICY_BASE,
    });
    harness.children[0].ready();
    await started;
    harness.client.retainParsePolicy(PARSE_POLICY_ATTRIBUTION);
    harness.children[0].exit(1);
    vi.runOnlyPendingTimers();
    expect(harness.children).toHaveLength(2);
    const init = harness.children[1].posted.find(
      (message) => message.kind === DbHostRequestKind.Init
    );
    expect(init).toMatchObject({
      kind: DbHostRequestKind.Init,
      options: { ...INIT, parsePolicy: PARSE_POLICY_ATTRIBUTION },
    });
  });

  it("posts nothing before start and nothing after close", async () => {
    const harness = makeHarness();
    harness.client.setUserIdentity(SIGNED_IN);
    expect(harness.children).toEqual([]);

    const started = harness.client.start(INIT);
    const child = harness.children[0];
    child.ready();
    await started;
    const closing = harness.client.close();
    await drainMicrotasks();
    const closeRequest = child.posted.find(
      (message) => message.kind === DbHostRequestKind.Close
    );
    child.send({
      kind: DbHostResponseKind.Result,
      id: closeRequest?.id,
      ok: true,
    });
    await closing;
    const postedBefore = child.posted.length;

    harness.client.setUserIdentity(OTHER_USER);
    harness.client.cancelRead("token-after-close");
    expect(child.posted).toHaveLength(postedBefore);
  });
});

describe("invoke wire flags", () => {
  it("marks an invoke made inside a background scope, and forwards a live cancel", async () => {
    const harness = await startedHarness();
    const child = harness.children[0];
    const background = runAsBackgroundDbReads(() =>
      harness.client.invoke(OP, [1])
    );
    await drainMicrotasks();
    const invoke = child.posted.findLast(
      (message) => message.kind === DbHostRequestKind.Invoke
    );
    expect(invoke).toEqual({
      kind: DbHostRequestKind.Invoke,
      id: lastInvokeId(child),
      op: OP,
      args: [1],
      background: true,
    });

    harness.client.cancelRead("token-live");
    expect(child.posted.at(-1)).toEqual({
      kind: DbHostRequestKind.CancelRead,
      token: "token-live",
    });

    child.send({
      kind: DbHostResponseKind.Result,
      id: lastInvokeId(child),
      ok: true,
      value: null,
    });
    await expect(background).resolves.toBeNull();
  });
});

describe("the restart ladder", () => {
  it("logs a fork that throws a non-Error value by its string form", async () => {
    const harness = await startedHarness({
      forkThrow: (ordinal) =>
        ordinal === 2
          ? { toString: () => "EMFILE: too many open files" }
          : undefined,
    });
    harness.children[0].exit(1);
    vi.runOnlyPendingTimers();
    await drainMicrotasks();

    expect(
      harness.logs
        .map((line) => RESTART_FAILED_LOG.exec(line)?.[1])
        .filter((reason) => reason !== undefined)
    ).toEqual(["EMFILE: too many open files"]);
    await harness.client.close();
  });

  it.each([
    ["an Error", new Error("already dead"), "already dead"],
    ["a non-Error value", "ESRCH", "ESRCH"],
  ])(
    "a replacement that comes up after shutdown began is killed, and %s thrown by kill is logged",
    async (_label, thrown, expected) => {
      const harness = await startedHarness({ killThrow: thrown });
      harness.children[0].exit(1);
      vi.runOnlyPendingTimers();
      expect(harness.children).toHaveLength(2);

      harness.client.beginClosing();
      harness.children[1].ready();
      await drainMicrotasks();

      expect(harness.children[1].kills()).toBe(1);
      expect(
        harness.logs
          .map((line) => KILL_FAILED_LOG.exec(line)?.[1])
          .filter((reason) => reason !== undefined)
      ).toEqual([expected]);
    }
  );
});
