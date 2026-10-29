/**
 * @file db-store-client-coverage.test.ts
 * @description ISS-10514 — the dispatcher's store-thread client
 * (`db-store-client.ts`) on the paths its sibling suites do not reach: relayed
 * error payloads, malformed inner messages, late replies that land after a
 * deadline trip, a post that throws, and calls made after the thread died.
 *
 * The worker is a fake handed in through `createWorker`; timers are Vitest's
 * fake clock, installed before the client is built (the client captures
 * `setTimeout` and `Date.now` at construction) and restored in `afterEach`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DbHostDataCloneError,
  type DbHostError,
} from "../src/main/database/db-host/db-host-protocol.js";
import {
  createDbStoreClient,
  DbStoreRelayedError,
  type DbStoreWorkerHandle,
  serializedDbStoreError,
} from "../src/main/database/db-host/db-store-client.js";
import {
  STORE_HEAVY_DEADLINE_MS,
  STORE_INVOKE_DEADLINE_MS,
  STORE_UNRESPONSIVE_DEADLINE_MS,
} from "../src/main/database/db-host/db-store-deadlines.js";
import {
  type DbStoreRequest,
  DbStoreRequestKind,
  type DbStoreResponse,
  DbStoreResponseKind,
} from "../src/main/database/db-host/db-store-protocol.js";
import { isDbStoreOpDeadlineError } from "../src/shared/db-store-op-deadline-error.js";

const LIGHT_OP = "sessions.getAll";
const SECOND_LIGHT_OP = "sessions.count";
const HEAVY_OP = "importer.importSession";
const THIRD_LIGHT_OP = "sessions.list";
const MINUTE_MS = 60_000;
const UNRESPONSIVE_DEATH = /store thread is unresponsive/;
const RELAYED_PLAIN_STACK = /^Error: plain\n/;
const MALFORMED_LOG = /sent a malformed message \(kind: ([^)]+)\); ignoring it/;
const LATE_SUCCESS_LOG =
  /"sessions\.getAll" succeeded \d+ms after it was posted/;
const LATE_FAILURE_LOG =
  /"sessions\.getAll" failed \((.+)\) \d+ms after it was posted/;
const GAVE_UP_LOG = /never answered; giving up on it/;
const CLONE_FAILURE =
  /could not be sent: its payload is not structured-clone-safe/;

type Harness = {
  client: ReturnType<typeof createDbStoreClient>;
  sent: DbStoreRequest[];
  logs: string[];
  deaths: string[];
  emit: (message: unknown) => void;
  emitExit: (code: number) => void;
  /** Make the next postMessage calls whose kind is `kind` throw. */
  failPostsOf: (kind: DbStoreRequestKind | null) => void;
};

function makeHarness(): Harness {
  const listeners: {
    message?: (value: unknown) => void;
    error?: (error: Error) => void;
    exit?: (code: number) => void;
  } = {};
  let failingKind: DbStoreRequestKind | null = null;
  const sent: DbStoreRequest[] = [];
  const logs: string[] = [];
  const deaths: string[] = [];
  const worker: DbStoreWorkerHandle = {
    on(
      event: "message" | "error" | "exit",
      listener: (payload: never) => void
    ) {
      Reflect.set(listeners, event, listener);
      return worker;
    },
    postMessage(message: DbStoreRequest) {
      if (message.kind === failingKind) {
        throw new Error("could not clone");
      }
      sent.push(message);
    },
    terminate() {
      return Promise.resolve(0);
    },
  };
  const client = createDbStoreClient({
    onEmit: () => undefined,
    onSessionTerminal: () => undefined,
    onCommittedWrite: () => undefined,
    onWriteTask: () => undefined,
    onLog: (message) => logs.push(message),
    onDurableLog: () => undefined,
    onTelemetry: () => undefined,
    onDeath: (reason) => deaths.push(reason),
    createWorker: () => worker,
  });
  return {
    client,
    sent,
    logs,
    deaths,
    emit: (message) => listeners.message?.(message),
    emitExit: (code) => listeners.exit?.(code),
    failPostsOf: (kind) => {
      failingKind = kind;
    },
  };
}

function executeIdFor(sent: DbStoreRequest[], op: string): number {
  const request = sent.find(
    (message) =>
      message.kind === DbStoreRequestKind.Execute && message.op === op
  );
  if (request?.kind !== DbStoreRequestKind.Execute) {
    throw new Error(`no Execute posted for ${op}`);
  }
  return request.id;
}

/** The id of the most recent Execute posted for `op`. */
function lastExecuteIdFor(sent: DbStoreRequest[], op: string): number {
  const request = sent.findLast(
    (message) =>
      message.kind === DbStoreRequestKind.Execute && message.op === op
  );
  if (request?.kind !== DbStoreRequestKind.Execute) {
    throw new Error(`no Execute posted for ${op}`);
  }
  return request.id;
}

/**
 * Post a heavy op and then a light op, wait one light budget, then answer
 * both. The light op answers `queued` only if it was held to the heavy
 * backstop, which proves the heavy accounting was not left negative by
 * whatever the caller did before.
 */
async function lightOpPostedBehindHeavy(
  harness: Harness
): Promise<{ light: unknown; heavy: unknown }> {
  const heavy = settledOf(harness.client.execute(HEAVY_OP, []));
  const light = settledOf(harness.client.execute(THIRD_LIGHT_OP, []));
  vi.advanceTimersByTime(STORE_INVOKE_DEADLINE_MS);
  harness.emit(
    result(lastExecuteIdFor(harness.sent, THIRD_LIGHT_OP), true, {
      value: "queued",
    })
  );
  harness.emit(
    result(lastExecuteIdFor(harness.sent, HEAVY_OP), true, { value: "heavy" })
  );
  return { light: await light, heavy: await heavy };
}

function result(
  id: number,
  ok: boolean,
  extra: { value?: unknown; error?: DbHostError } = {}
): DbStoreResponse {
  return { kind: DbStoreResponseKind.Result, id, ok, ...extra };
}

/** Attach a handler now so a rejection that lands during a clock advance is not unhandled. */
function settledOf(
  promise: Promise<unknown>
): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("relayed store errors", () => {
  it("carries the serialized name, message, and stack whole", async () => {
    const harness = makeHarness();
    const outcome = settledOf(harness.client.execute(LIGHT_OP, []));
    const serialized: DbHostError = {
      message: "constraint failed",
      name: "SqliteError",
      stack: "SqliteError: constraint failed\n    at store",
    };
    harness.emit(
      result(executeIdFor(harness.sent, LIGHT_OP), false, { error: serialized })
    );
    const settled = await outcome;
    expect(settled.ok).toBe(false);
    if (settled.ok) {
      return;
    }
    expect(settled.error).toBeInstanceOf(DbStoreRelayedError);
    expect(settled.error).toMatchObject({
      message: "constraint failed",
      name: "SqliteError",
      stack: serialized.stack,
    });
    expect(serializedDbStoreError(settled.error)).toBe(serialized);
  });

  it("names a failure that arrived without a name `Error`", async () => {
    const harness = makeHarness();
    const outcome = settledOf(harness.client.execute(LIGHT_OP, []));
    harness.emit(
      result(executeIdFor(harness.sent, LIGHT_OP), false, {
        error: { message: "plain" },
      })
    );
    const settled = await outcome;
    expect(settled.ok).toBe(false);
    if (settled.ok) {
      return;
    }
    expect(settled.error).toMatchObject({
      name: "Error",
      message: "plain",
      stack: expect.stringMatching(RELAYED_PLAIN_STACK),
    });
  });

  it("a failed result with no error payload rejects with the generic message", async () => {
    const harness = makeHarness();
    const outcome = settledOf(harness.client.execute(LIGHT_OP, []));
    harness.emit(result(executeIdFor(harness.sent, LIGHT_OP), false));
    const settled = await outcome;
    expect(settled.ok).toBe(false);
    if (settled.ok) {
      return;
    }
    expect(serializedDbStoreError(settled.error)).toEqual({
      message: "db-host store op failed",
    });
  });

  it("a dispatcher-local error has no serialized payload", () => {
    expect(serializedDbStoreError(new Error("local"))).toBeNull();
    expect(serializedDbStoreError("not an error")).toBeNull();
  });
});

describe("malformed inner messages", () => {
  it("logs the kind it could read and settles nothing", async () => {
    const harness = makeHarness();
    const outcome = settledOf(harness.client.execute(LIGHT_OP, []));
    const id = executeIdFor(harness.sent, LIGHT_OP);
    harness.emit(42);
    harness.emit(null);
    harness.emit({ id, ok: true });
    harness.emit({ kind: 5, id, ok: true });
    harness.emit({ kind: DbStoreResponseKind.Result, id: "1", ok: true });
    expect(
      harness.logs.map((line) => MALFORMED_LOG.exec(line)?.[1] ?? line)
    ).toEqual(["number", "object", "absent", "absent", "store-result"]);

    harness.emit(result(id, true, { value: "answer" }));
    expect(await outcome).toEqual({ ok: true, value: "answer" });
  });

  it("a result for an id nobody is waiting on is ignored", async () => {
    const harness = makeHarness();
    const outcome = settledOf(harness.client.execute(LIGHT_OP, []));
    const id = executeIdFor(harness.sent, LIGHT_OP);
    harness.emit(result(id + 100, true, { value: "stray" }));
    harness.emit(result(id, true, { value: "mine" }));
    expect(await outcome).toEqual({ ok: true, value: "mine" });
    expect(harness.logs).toEqual([]);
  });
});

describe("replies that arrive after a deadline trip", () => {
  it("a late success is logged, and its abandon timer later finds nothing to give up", async () => {
    const harness = makeHarness();
    const outcome = settledOf(harness.client.execute(LIGHT_OP, []));
    const id = executeIdFor(harness.sent, LIGHT_OP);
    vi.advanceTimersByTime(STORE_INVOKE_DEADLINE_MS);
    const settled = await outcome;
    expect(settled.ok).toBe(false);
    if (!settled.ok) {
      expect(isDbStoreOpDeadlineError(settled.error)).toBe(true);
    }

    harness.emit(result(id, true, { value: "too late" }));
    expect(harness.logs.some((line) => LATE_SUCCESS_LOG.test(line))).toBe(true);

    // The overdue entry's abandon timer is not cleared by the late reply; when
    // it fires it must find the entry already gone and say nothing.
    vi.advanceTimersByTime(STORE_INVOKE_DEADLINE_MS);
    expect(harness.logs.some((line) => GAVE_UP_LOG.test(line))).toBe(false);
    expect(harness.deaths).toEqual([]);

    // A late LIGHT reply must not release a heavy slot it never held.
    expect(await lightOpPostedBehindHeavy(harness)).toEqual({
      light: { ok: true, value: "queued" },
      heavy: { ok: true, value: "heavy" },
    });
  });

  it("a late failure logs the store's message, or says there was none", async () => {
    const harness = makeHarness();
    const first = settledOf(harness.client.execute(LIGHT_OP, []));
    const firstId = executeIdFor(harness.sent, LIGHT_OP);
    vi.advanceTimersByTime(STORE_INVOKE_DEADLINE_MS);
    await first;
    harness.emit(result(firstId, false, { error: { message: "disk full" } }));

    const second = settledOf(harness.client.execute(LIGHT_OP, []));
    const secondId = harness.sent.at(-1);
    vi.advanceTimersByTime(STORE_INVOKE_DEADLINE_MS);
    await second;
    if (secondId?.kind !== DbStoreRequestKind.Execute) {
      throw new Error("expected a second Execute");
    }
    harness.emit(result(secondId.id, false));

    expect(
      harness.logs
        .map((line) => LATE_FAILURE_LOG.exec(line)?.[1])
        .filter((reason) => reason !== undefined)
    ).toEqual(["disk full", "no message"]);
  });

  it("abandoning one overdue op while another is still pending leaves that op to settle", async () => {
    const harness = makeHarness();
    const overdue = settledOf(harness.client.execute(LIGHT_OP, []));
    vi.advanceTimersByTime(STORE_INVOKE_DEADLINE_MS);
    expect((await overdue).ok).toBe(false);

    vi.advanceTimersByTime(1);
    const stillPending = settledOf(harness.client.execute(SECOND_LIGHT_OP, []));
    const pendingId = executeIdFor(harness.sent, SECOND_LIGHT_OP);
    // The overdue op is abandoned one more budget after its trip; the second
    // op's own deadline is still 1ms away at that instant.
    vi.advanceTimersByTime(STORE_INVOKE_DEADLINE_MS - 1);
    expect(harness.logs.filter((line) => GAVE_UP_LOG.test(line))).toHaveLength(
      1
    );

    harness.emit(result(pendingId, true, { value: "in time" }));
    expect(await stillPending).toEqual({ ok: true, value: "in time" });
    expect(harness.deaths).toEqual([]);
  });
});

describe("the silence watch after an overdue op is abandoned", () => {
  it("stays armed while a heavy op is still pending, so a silent store still dies on time", async () => {
    const harness = makeHarness();
    const light = settledOf(harness.client.execute(LIGHT_OP, []));
    const heavy = settledOf(harness.client.execute(HEAVY_OP, []));
    vi.advanceTimersByTime(STORE_INVOKE_DEADLINE_MS);
    expect((await light).ok).toBe(false);
    vi.advanceTimersByTime(STORE_INVOKE_DEADLINE_MS);
    expect(harness.logs.filter((line) => GAVE_UP_LOG.test(line))).toHaveLength(
      1
    );
    expect(harness.deaths).toEqual([]);

    vi.advanceTimersByTime(
      STORE_UNRESPONSIVE_DEADLINE_MS - 2 * STORE_INVOKE_DEADLINE_MS - 1
    );
    expect(harness.deaths).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(harness.deaths).toHaveLength(1);
    expect(harness.deaths[0]).toMatch(UNRESPONSIVE_DEATH);
    expect((await heavy).ok).toBe(false);
  });

  it("stays armed while only overdue ops remain, so a silent store still dies on time", async () => {
    const harness = makeHarness();
    const heavy = settledOf(harness.client.execute(HEAVY_OP, []));
    vi.advanceTimersByTime(50 * MINUTE_MS);
    // Queued behind the heavy op, so it trips at 110 min and is abandoned at 170.
    const queued = settledOf(harness.client.execute(SECOND_LIGHT_OP, []));
    // Replies keep the store alive; each restarts the silence window.
    const firstReply = settledOf(harness.client.execute(THIRD_LIGHT_OP, []));
    harness.emit(result(lastExecuteIdFor(harness.sent, THIRD_LIGHT_OP), true));
    vi.advanceTimersByTime(50 * MINUTE_MS);
    const secondReply = settledOf(harness.client.execute(THIRD_LIGHT_OP, []));
    harness.emit(result(lastExecuteIdFor(harness.sent, THIRD_LIGHT_OP), true));
    expect(await firstReply).toEqual({ ok: true, value: undefined });
    expect(await secondReply).toEqual({ ok: true, value: undefined });

    // 120 min: the heavy op is abandoned while the queued op is overdue and
    // nothing is pending.
    vi.advanceTimersByTime(20 * MINUTE_MS);
    expect((await queued).ok).toBe(false);
    expect((await heavy).ok).toBe(false);
    expect(harness.logs.filter((line) => GAVE_UP_LOG.test(line))).toHaveLength(
      1
    );

    // The window restarted by the reply at 100 min ends at 165 min.
    vi.advanceTimersByTime(
      100 * MINUTE_MS + STORE_UNRESPONSIVE_DEADLINE_MS - 120 * MINUTE_MS - 1
    );
    expect(harness.deaths).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(harness.deaths).toHaveLength(1);
    expect(harness.deaths[0]).toMatch(UNRESPONSIVE_DEATH);
  });
});

describe("ops queued behind a heavy op", () => {
  it("only the op queued behind the heavy one is re-armed when it settles", async () => {
    const harness = makeHarness();
    const early = settledOf(harness.client.execute(LIGHT_OP, []));
    const heavy = settledOf(harness.client.execute(HEAVY_OP, []));
    const queued = settledOf(harness.client.execute(SECOND_LIGHT_OP, []));
    const earlyId = executeIdFor(harness.sent, LIGHT_OP);
    const heavyId = executeIdFor(harness.sent, HEAVY_OP);

    vi.advanceTimersByTime(STORE_INVOKE_DEADLINE_MS - 10);
    // The heavy op settles while the early light op is still pending, so the
    // re-arm walks past an entry that was never queued behind it.
    harness.emit(result(heavyId, true, { value: "heavy" }));
    expect(await heavy).toEqual({ ok: true, value: "heavy" });

    // The early op keeps the budget it was posted with and trips on time.
    vi.advanceTimersByTime(10);
    const earlySettled = await early;
    expect(earlySettled.ok).toBe(false);
    if (!earlySettled.ok) {
      expect(isDbStoreOpDeadlineError(earlySettled.error)).toBe(true);
    }
    harness.emit(result(earlyId, true, { value: "early" }));

    // Re-armed from the heavy settle: a budget counted from its post would
    // have tripped at STORE_INVOKE_DEADLINE_MS, which is already behind us.
    vi.advanceTimersByTime(STORE_INVOKE_DEADLINE_MS - 11);
    const queuedId = executeIdFor(harness.sent, SECOND_LIGHT_OP);
    harness.emit(result(queuedId, true, { value: "queued" }));
    expect(await queued).toEqual({ ok: true, value: "queued" });
  });
});

describe("a post that throws", () => {
  it("rejects a light op with the typed clone error and leaves the client usable", async () => {
    const harness = makeHarness();
    harness.failPostsOf(DbStoreRequestKind.Execute);
    const failed = await settledOf(harness.client.execute(LIGHT_OP, [1]));
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error).toBeInstanceOf(DbHostDataCloneError);
      expect(String(failed.error)).toMatch(CLONE_FAILURE);
    }

    harness.failPostsOf(null);
    const next = settledOf(harness.client.execute(LIGHT_OP, []));
    harness.emit(
      result(executeIdFor(harness.sent, LIGHT_OP), true, { value: "ok" })
    );
    expect(await next).toEqual({ ok: true, value: "ok" });

    // A failed LIGHT post must not release a heavy slot it never held.
    expect(await lightOpPostedBehindHeavy(harness)).toEqual({
      light: { ok: true, value: "queued" },
      heavy: { ok: true, value: "heavy" },
    });
  });

  it("releases a heavy op's slot, so the next light op runs on its own budget", async () => {
    const harness = makeHarness();
    harness.failPostsOf(DbStoreRequestKind.Execute);
    const failed = await settledOf(harness.client.execute(HEAVY_OP, []));
    expect(failed.ok).toBe(false);

    harness.failPostsOf(null);
    const light = settledOf(harness.client.execute(LIGHT_OP, []));
    vi.advanceTimersByTime(STORE_INVOKE_DEADLINE_MS);
    const settled = await light;
    expect(settled.ok).toBe(false);
    if (!settled.ok) {
      expect(settled.error).toMatchObject({
        deadlineMs: STORE_INVOKE_DEADLINE_MS,
      });
      expect(STORE_INVOKE_DEADLINE_MS).toBeLessThan(STORE_HEAVY_DEADLINE_MS);
    }
  });
});

describe("calls after the store thread died", () => {
  it("cancelRead, setIdentity and close post nothing and close resolves at once", async () => {
    const harness = makeHarness();
    harness.emitExit(1);
    expect(harness.deaths).toHaveLength(1);

    harness.client.cancelRead("token-1");
    harness.client.setIdentity(null);
    await harness.client.close();
    expect(harness.sent).toEqual([]);
  });

  it("the same calls post while the thread is alive", async () => {
    const harness = makeHarness();
    harness.client.cancelRead("token-1");
    harness.client.setIdentity(null);
    const closing = harness.client.close();
    harness.emit({ kind: DbStoreResponseKind.Closed });
    await closing;
    expect(harness.sent.map((message) => message.kind)).toEqual([
      DbStoreRequestKind.CancelRead,
      DbStoreRequestKind.SetIdentity,
      DbStoreRequestKind.Close,
    ]);
  });
});
