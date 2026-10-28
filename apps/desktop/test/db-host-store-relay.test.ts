/**
 * @file db-host-store-relay.test.ts
 * @description ISS-8246 M1 — the store thread → dispatcher → main path, driven
 * for real.
 *
 * Both legs are production here: `createDbStoreClient` dispatches an inner
 * response exactly as it does in the db-host, and `createDbHostStoreRelay`
 * re-addresses it to the outer `DbHostResponse` main consumes. The only fake is
 * the worker thread itself, so what these tests actually pin is the mapping and
 * the ordering — which is where this milestone's risk sits.
 *
 * Two of the relayed kinds fail SILENTLY when unhandled, and both have already
 * shipped that exact bug one boundary out (ISS-7109 telemetry, ISS-7882 durable
 * logs). A third, `SessionTerminal`, was missing from the first draft of this
 * design. So the coverage below is exhaustive BY DERIVATION rather than by a
 * hand-written list: {@link relayCompletenessGuard} walks `DbStoreResponseKind`
 * itself, so a kind added later fails this file until it is either relayed or
 * explicitly declared as correlated/consumed.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSourceFile,
  isImportDeclaration,
  isStringLiteral,
  ScriptKind,
  ScriptTarget,
} from "typescript6";
import { describe, it } from "vitest";
import { HEAVY_STORE_OPS } from "../src/main/database/db-host/db-host-op-lanes.js";
import {
  type DbHostResponse,
  DbHostResponseKind,
  isDbHostResponse,
} from "../src/main/database/db-host/db-host-protocol.js";
import { DB_HOST_STORE_OP_PREFIX } from "../src/main/database/db-host/db-host-store-op-registry.js";
import { createDbHostStoreRelay } from "../src/main/database/db-host/db-host-store-relay.js";
import {
  createDbStoreClient,
  type DbStoreWorkerHandle,
  serializedDbStoreError,
} from "../src/main/database/db-host/db-store-client.js";
import {
  heavyDeadlineOps,
  STORE_HEAVY_DEADLINE_MS,
  STORE_INVOKE_DEADLINE_MS,
  storeExecuteDeadlineMs,
} from "../src/main/database/db-host/db-store-deadlines.js";
import {
  type DbStoreRequest,
  type DbStoreResponse,
  DbStoreResponseKind,
  isDbStoreResponse,
} from "../src/main/database/db-host/db-store-protocol.js";
import { TRANSACTION_TIMEOUT_MS } from "../src/main/database/prisma-client.js";
import { WriteQueueTaskPhase } from "../src/main/database/write-queue.js";
import { MigrationRefusalKind } from "../src/main/lifecycle/migration-refusal.js";
import { StorageExhaustionReason } from "../src/shared/storage-exhaustion.js";

/**
 * A real, schema-valid event. It matters that this is valid: `isDbHostResponse`
 * rejects a `telemetry` response whose payload is not, so a made-up shape would
 * be dropped at the OUTER boundary and this test would be asserting the relay
 * against an event main would never accept.
 */
const TELEMETRY_EVENT = {
  severity: "warn",
  category: "desktop.shutdown_failed",
  message: "store thread said something worth reporting",
} as const;

type WorkerListeners = {
  message?: (value: unknown) => void;
  error?: (error: Error) => void;
  exit?: (code: number) => void;
};

type FakeWorker = DbStoreWorkerHandle & {
  sent: DbStoreRequest[];
  terminations: number;
  emit: (message: DbStoreResponse) => void;
  emitExit: (code: number) => void;
};

function makeFakeWorker(): FakeWorker {
  const listeners: WorkerListeners = {};
  const worker: FakeWorker = {
    sent: [],
    terminations: 0,
    on(
      event: "message" | "error" | "exit",
      listener: (payload: never) => void
    ) {
      Reflect.set(listeners, event, listener);
      return worker;
    },
    postMessage(message: DbStoreRequest) {
      worker.sent.push(message);
    },
    terminate() {
      worker.terminations += 1;
      return Promise.resolve(0);
    },
    emit(message: DbStoreResponse) {
      listeners.message?.(message);
    },
    emitExit(code: number) {
      listeners.exit?.(code);
    },
  } as FakeWorker;
  return worker;
}

type Harness = {
  worker: FakeWorker;
  client: ReturnType<typeof createDbStoreClient>;
  /** Outer messages that reached main, in order. */
  posted: DbHostResponse[];
  /** Ordered trace of relay side effects that post nothing. */
  events: string[];
  deaths: string[];
};

function makeHarness(): Harness {
  const worker = makeFakeWorker();
  const posted: DbHostResponse[] = [];
  const events: string[] = [];
  const deaths: string[] = [];
  const client = createDbStoreClient({
    ...createDbHostStoreRelay({
      post: (message) => {
        posted.push(message);
        events.push(`post:${message.kind}`);
      },
      onCommittedWrite: () => events.push("epoch-bump"),
      onWriteTask: (token, phase, taskSeq) =>
        events.push(`write-task:${token}:${phase}:${taskSeq}`),
      onDeath: (reason) => deaths.push(reason),
    }),
    createWorker: () => worker,
  });
  return {
    worker,
    client,
    posted,
    events,
    deaths,
  };
}

/** Open the store so `execute` is legal, without asserting on the handshake. */
async function opened(harness: Harness): Promise<void> {
  const open = harness.client.open({ dataDir: "/tmp/db-store-relay-test" });
  harness.worker.emit({ kind: DbStoreResponseKind.Opened });
  await open;
  harness.posted.length = 0;
  harness.events.length = 0;
}

/**
 * Inner kinds this file does NOT expect to see relayed to main, with the reason.
 *
 * Declared as a table rather than a bare set so the completeness guard can state
 * WHY each is exempt; an unexplained exemption is how a kind quietly stops being
 * covered.
 */
const NON_RELAYED_KINDS: Readonly<Record<string, string>> = {
  [DbStoreResponseKind.Opened]: "correlated reply, settled by the client",
  [DbStoreResponseKind.Result]: "correlated reply, settled by the client",
  [DbStoreResponseKind.Closed]: "correlated reply, settled by the client",
  [DbStoreResponseKind.Heap]:
    "consumed by the client; main's contract carries a pressure LEVEL, not raw bytes (ISS-4823)",
  [DbStoreResponseKind.CommittedWrite]:
    "applied to the dispatcher's insights cache; nothing is posted onward",
  [DbStoreResponseKind.WriteTask]:
    "recorded in the dispatcher's write-dispatch mirror (ISS-7256); main reads it back through the ordinary `importer.hasUndispatchedWrite` op rather than as a push",
};

const STORE_WORKER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/main/database/db-host/db-store-worker.ts"
);
const STORE_PROTOCOL_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/main/database/db-host/db-store-protocol.ts"
);

/** Module specifiers a file imports, split by whether the import is type-only. */
function importsOf(file: string): { value: string[]; type: string[] } {
  const source = createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ScriptTarget.Latest,
    true,
    ScriptKind.TS
  );
  const value: string[] = [];
  const type: string[] = [];
  for (const statement of source.statements) {
    if (!isImportDeclaration(statement)) {
      continue;
    }
    const specifier = statement.moduleSpecifier;
    if (!isStringLiteral(specifier)) {
      continue;
    }
    // `import type { X }` erases wholly; `import { type X }` does not, because
    // the declaration itself still emits unless every named binding is inline
    // type-only. Both forms are checked, since only a fully-erasing import is
    // safe in the bootstrap.
    const clause = statement.importClause;
    const wholeClauseIsType =
      clause?.isTypeOnly === true ||
      (clause?.namedBindings !== undefined &&
        "elements" in clause.namedBindings &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every(
          (element) => element.isTypeOnly === true
        ));
    (wholeClauseIsType ? type : value).push(specifier.text);
  }
  return { value, type };
}

describe("ISS-8246 M1: the store-thread relay", () => {
  it("delivers every worker-origin notification to main, verbatim", async () => {
    const harness = makeHarness();
    await opened(harness);

    harness.worker.emit({
      kind: DbStoreResponseKind.Emit,
      sessionId: "session-1",
    });
    harness.worker.emit({
      kind: DbStoreResponseKind.SessionTerminal,
      sessionId: "session-2",
      status: "inactive",
    });
    harness.worker.emit({
      kind: DbStoreResponseKind.Log,
      message: "store said something",
    });
    harness.worker.emit({
      kind: DbStoreResponseKind.DurableLog,
      level: "warn",
      line: "a durable line",
    });
    harness.worker.emit({
      kind: DbStoreResponseKind.Telemetry,
      event: TELEMETRY_EVENT,
    });

    assert.deepEqual(harness.posted, [
      { kind: DbHostResponseKind.Emit, sessionId: "session-1" },
      {
        kind: DbHostResponseKind.SessionTerminal,
        sessionId: "session-2",
        status: "inactive",
      },
      { kind: DbHostResponseKind.Log, message: "store said something" },
      {
        kind: DbHostResponseKind.DurableLog,
        level: "warn",
        line: "a durable line",
      },
      {
        kind: DbHostResponseKind.Telemetry,
        event: TELEMETRY_EVENT,
      },
    ]);

    // Deep-equality alone would pass on an envelope main REFUSES. Two of these
    // kinds are payload-validated at the outer boundary (`memory-pressure` and
    // `telemetry` hard, `durable-log` on its `line`), and a refusal there is
    // silent for every kind but telemetry — which is the same invisible drop
    // ISS-7882 was filed for. So each relayed message is also held to the guard
    // main actually applies.
    for (const message of harness.posted) {
      assert.ok(
        isDbHostResponse(message),
        `relayed ${message.kind} would be refused at the main-process boundary`
      );
    }
  });

  /**
   * ISS-7256 (whitlockk review) — the notice has to REACH the dispatcher's mirror,
   * not merely exist on the wire. It is consumed here rather than posted onward,
   * so the exhaustiveness guard above cannot see it and this is the only thing
   * that proves the store → dispatcher hop is wired at all.
   */
  it("routes a write-queue transition to the dispatcher's mirror, not to main", async () => {
    const harness = makeHarness();
    await opened(harness);
    harness.worker.emit({
      kind: DbStoreResponseKind.WriteTask,
      token: "session-1",
      phase: WriteQueueTaskPhase.Queued,
      taskSeq: 9,
    });
    assert.deepEqual(harness.events, ["write-task:session-1:queued:9"]);
    assert.deepEqual(
      harness.posted,
      [],
      "nothing is forwarded to main; main asks for it through the importer op"
    );
  });

  it("leaves no inner response kind unaccounted for", () => {
    // Derived from the const object, so a NEW kind fails here until someone
    // decides where it goes. A hand-written list of the kinds that exist today
    // would pass silently and the new signal would go dark — which is precisely
    // how `SessionTerminal` was nearly lost in this design.
    const relayed = new Set<string>([
      DbStoreResponseKind.Emit,
      DbStoreResponseKind.SessionTerminal,
      DbStoreResponseKind.Log,
      DbStoreResponseKind.DurableLog,
      DbStoreResponseKind.Telemetry,
    ]);
    const unaccounted = Object.values(DbStoreResponseKind).filter(
      (kind) => !(relayed.has(kind) || kind in NON_RELAYED_KINDS)
    );
    assert.deepEqual(
      unaccounted,
      [],
      `These inner response kinds are neither relayed to main nor declared as correlated/consumed, so nothing proves they reach anyone: ${unaccounted.join(", ")}`
    );
  });

  it("applies the epoch bump BEFORE the write's own result", async () => {
    // ISS-7110 / PLN-1837 §1.5. The store fires its committed-write observer
    // before the write call returns, so `CommittedWrite` is queued ahead of the
    // `Result`. Eventual delivery is not enough: if the bump landed after, an
    // insights read issued right after a write would still see an epoch-fresh
    // pre-write cache entry and the onboarding-zeros class would survive.
    const harness = makeHarness();
    await opened(harness);

    const write = harness.client
      .execute("importer.importSession", [])
      .then(() => harness.events.push("write-resolved"));

    harness.worker.emit({ kind: DbStoreResponseKind.CommittedWrite });
    // SYNCHRONOUS on arrival — asserted with no await in between, because that
    // is the actual contract and the weaker "bump before result" assertion is
    // not discriminating: a bump deferred by a single `queueMicrotask` still
    // beats the result today (verified by mutation), so it would stay green
    // against a handler that had quietly stopped being synchronous, and flip to
    // red only once someone added an await elsewhere in the chain.
    assert.deepEqual(harness.events, ["epoch-bump"]);

    harness.worker.emit({
      kind: DbStoreResponseKind.Result,
      id: 1,
      ok: true,
      value: undefined,
    });
    await write;

    assert.deepEqual(harness.events, ["epoch-bump", "write-resolved"]);
  });

  it("carries a migration refusal across the hop WITHOUT restarting", async () => {
    // PLN-1837 §1.2 + ISS-4714. A refusal is deterministic, so a crash-and-
    // restart here is an infinite loop; and the `refusalKind` is the only thing
    // that survives structured clone to let the main side rebuild a typed
    // DesktopMigrationError, so dropping it would silently retire the DB-ahead
    // classification.
    const harness = makeHarness();
    const open = harness.client.open({ dataDir: "/tmp/db-store-relay-test" });
    harness.worker.emit({
      kind: DbStoreResponseKind.Opened,
      error: {
        message: "database is ahead of this app build",
        name: "DesktopMigrationError",
        refusalKind: MigrationRefusalKind.Downgrade,
      },
    });

    const error = await open.then(
      () => null,
      (rejection: unknown) => rejection
    );
    assert.ok(error, "open must reject on a refusal");
    assert.equal(
      serializedDbStoreError(error)?.refusalKind,
      MigrationRefusalKind.Downgrade
    );
    // Stay alive: no death reported, so the dispatcher never exits and the
    // supervisor never re-forks into the same deterministic refusal.
    assert.deepEqual(harness.deaths, []);
    assert.equal(harness.worker.terminations, 0);
  });

  it("carries a disk-full verdict on an op error", async () => {
    // ISS-6337 — classified on the store thread, where the driver's result code
    // still exists on a `cause` link the clone flattens away. The dispatcher
    // cannot re-derive it, so it must forward the payload rather than a rebuilt
    // Error.
    const harness = makeHarness();
    await opened(harness);

    const op = harness.client.execute("sessions.getAll", []);
    harness.worker.emit({
      kind: DbStoreResponseKind.Result,
      id: 1,
      ok: false,
      error: {
        message: "database or disk is full",
        storageExhaustionReason: StorageExhaustionReason.SqliteFull,
      },
    });

    const error = await op.then(
      () => null,
      (rejection: unknown) => rejection
    );
    assert.equal(
      serializedDbStoreError(error)?.storageExhaustionReason,
      StorageExhaustionReason.SqliteFull
    );
  });

  it("reports a store-thread exit as a death, and a terminate as not one", async () => {
    const crashed = makeHarness();
    await opened(crashed);
    const inFlight = crashed.client.execute("sessions.getAll", []);
    crashed.worker.emitExit(5);
    await assert.rejects(() => inFlight);
    assert.equal(crashed.deaths.length, 1);

    // The close path terminates on purpose, so the exit it causes must not be
    // read as a crash — that would turn every clean shutdown into a restart.
    const closing = makeHarness();
    await opened(closing);
    await closing.client.terminate();
    closing.worker.emitExit(0);
    assert.deepEqual(closing.deaths, []);
  });

  it("refuses a corrupt Heap payload at the boundary", () => {
    // Named for what it pins: this drives the type guard directly, so it proves
    // the REFUSAL and not the retention that follows from it. Retention itself
    // is asserted end to end through the client in the next test — the two used
    // to be one test carrying the retention name over guard-only assertions.
    //
    // The bad-data rule, at the one inner message that feeds a DECISION rather
    // than a relay: this sample gates whether heavy work parks. The whole
    // impossible set is refused, not just the two everyone remembers — a
    // fractional byte count and a non-finite one are corrupt samples, not small
    // ones, and evicting a valid `high` with either would silently disable the
    // admission gate.
    assert.ok(
      isDbStoreResponse({
        kind: DbStoreResponseKind.Heap,
        heapUsed: 1024,
        rss: 2048,
      })
    );
    for (const bad of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      // Past the safe-integer range the value is no longer exactly
      // representable, so comparing it against a heap threshold stops meaning
      // anything — and `Number.isInteger` answers true for all three.
      Number.MAX_SAFE_INTEGER + 1,
      1e300,
      Number.MAX_VALUE,
    ]) {
      assert.equal(
        isDbStoreResponse({
          kind: DbStoreResponseKind.Heap,
          heapUsed: bad,
          rss: 2048,
        }),
        false,
        `heapUsed=${bad} must be refused at the boundary`
      );
      assert.equal(
        isDbStoreResponse({
          kind: DbStoreResponseKind.Heap,
          heapUsed: 1024,
          rss: bad,
        }),
        false,
        `rss=${bad} must be refused at the boundary`
      );
    }
  });

  it("refuses a malformed payload on every kind that carries one", () => {
    // The guard used to check `kind` alone for everything but Heap. That let a
    // malformed `store-result` carrying a live `id` SETTLE the correlated
    // pending op, so arbitrary data reached main as though the store had
    // returned it. Each case below is a well-formed `kind` with a payload the
    // dispatcher must not act on.
    const malformed: readonly Record<string, unknown>[] = [
      { kind: DbStoreResponseKind.Result, ok: true },
      { kind: DbStoreResponseKind.Result, id: "1", ok: true },
      { kind: DbStoreResponseKind.Result, id: 1.5, ok: true },
      { kind: DbStoreResponseKind.Result, id: -1, ok: true },
      { kind: DbStoreResponseKind.Result, id: 1 },
      { kind: DbStoreResponseKind.Result, id: 1, ok: "yes" },
      { kind: DbStoreResponseKind.Emit },
      { kind: DbStoreResponseKind.Emit, sessionId: "" },
      { kind: DbStoreResponseKind.Emit, sessionId: 7 },
      { kind: DbStoreResponseKind.SessionTerminal, sessionId: "s" },
      { kind: DbStoreResponseKind.SessionTerminal, status: "inactive" },
      { kind: DbStoreResponseKind.Log },
      { kind: DbStoreResponseKind.Log, message: 7 },
      { kind: DbStoreResponseKind.DurableLog, level: "warn" },
      { kind: DbStoreResponseKind.Telemetry },
      { kind: DbStoreResponseKind.Telemetry, event: "not an object" },
      { kind: "store-not-a-kind" },
      { kind: 7 },
      {},
    ];
    for (const message of malformed) {
      assert.equal(
        isDbStoreResponse(message),
        false,
        `must be refused: ${JSON.stringify(message)}`
      );
    }

    // And the well-formed shapes still pass, so the guard is not simply strict.
    const wellFormed: readonly Record<string, unknown>[] = [
      { kind: DbStoreResponseKind.Result, id: 0, ok: true, value: null },
      { kind: DbStoreResponseKind.Result, id: 3, ok: false, error: {} },
      { kind: DbStoreResponseKind.Emit, sessionId: "s" },
      { kind: DbStoreResponseKind.SessionTerminal, sessionId: "s", status: "" },
      { kind: DbStoreResponseKind.Log, message: "" },
      { kind: DbStoreResponseKind.DurableLog, level: "warn", line: "x" },
      { kind: DbStoreResponseKind.Telemetry, event: TELEMETRY_EVENT },
      { kind: DbStoreResponseKind.Opened },
      { kind: DbStoreResponseKind.Closed },
      { kind: DbStoreResponseKind.CommittedWrite },
    ];
    for (const message of wellFormed) {
      assert.ok(
        isDbStoreResponse(message),
        `must be accepted: ${JSON.stringify(message)}`
      );
    }
  });

  it("does not settle a pending op from a malformed result, and says so", async () => {
    // The consequence the guard exists to prevent, driven end to end: a
    // `store-result` with a live id but no `ok` must leave the op outstanding
    // rather than resolving the caller with arbitrary data — and the refusal
    // must be logged, or an op that later dies on its deadline has nothing
    // explaining why.
    const harness = makeHarness();
    await opened(harness);

    let settled = false;
    const op = harness.client
      .execute("sessions.getAll", [])
      .then(() => {
        settled = true;
      })
      .catch(() => {
        settled = true;
      });

    harness.worker.emit({
      kind: DbStoreResponseKind.Result,
      id: 1,
      value: { rows: "arbitrary" },
    } as never);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "a malformed result must not settle the op");
    assert.ok(
      harness.posted.some(
        (message) =>
          message.kind === DbHostResponseKind.Log &&
          message.message.includes("malformed")
      ),
      "the refusal must be logged, not silent"
    );

    // Settle it properly so the test leaves no dangling promise.
    harness.worker.emit({
      kind: DbStoreResponseKind.Result,
      id: 1,
      ok: true,
      value: null,
    });
    await op;
    assert.equal(settled, true);
  });
  it("folds the store heap sample in, and keeps the last good one", async () => {
    const harness = makeHarness();
    await opened(harness);
    assert.equal(harness.client.latestStoreMemory(), null);
    harness.worker.emit({
      kind: DbStoreResponseKind.Heap,
      heapUsed: 3_000_000,
      rss: 9_000_000,
    });
    assert.deepEqual(harness.client.latestStoreMemory(), {
      heapUsed: 3_000_000,
      rss: 9_000_000,
    });

    // The retention half, driven through the real listener rather than the
    // guard: a corrupt sample must not EVICT the good one. Evicting it would
    // silently disable the FEA-3150 admission gate's heap arm, which is the
    // failure the boundary check exists to prevent — and asserting only that the
    // guard returns false never showed that the client honours it.
    for (const bad of [-1, 1.5, Number.NaN]) {
      harness.worker.emit({
        kind: DbStoreResponseKind.Heap,
        heapUsed: bad,
        rss: 9_000_000,
      });
      assert.deepEqual(
        harness.client.latestStoreMemory(),
        { heapUsed: 3_000_000, rss: 9_000_000 },
        `heapUsed=${bad} must not evict the last good sample`
      );
    }
  });
});

describe("ISS-8246 M1: per-class deadlines", () => {
  it("gives every heavy store op the heavy deadline, by derivation", () => {
    // Derived from HEAVY_STORE_OPS rather than restated, so an op promoted to
    // heavy for ADMISSION automatically gets the heavy deadline too. A
    // hand-listed pair here is exactly the side inventory that widens to string
    // and then silently answers with the wrong default.
    for (const storeKey of HEAVY_STORE_OPS) {
      assert.equal(
        storeExecuteDeadlineMs(`${DB_HOST_STORE_OP_PREFIX}${storeKey}`),
        STORE_HEAVY_DEADLINE_MS,
        `${storeKey} is admission-heavy but would be deadlined as a normal invoke`
      );
    }
  });

  it("gives every declared heavy op the heavy deadline", () => {
    // The derivation above passes VACUOUSLY for the corpus-scale ops that are
    // deliberately not admission-heavy: `HEAVY_STORE_OPS` holds only the two
    // transcript backfills, so the pack scan and the catalog fetch used to
    // resolve to the 5-minute budget while the docstring named them as heavy.
    // Tripping it calls `die()`, which exits the whole db-host — so a slow
    // network became a host restart. This iterates the declared set instead.
    const heavy = heavyDeadlineOps();
    assert.ok(heavy.length > 0);
    for (const op of heavy) {
      assert.equal(
        storeExecuteDeadlineMs(op),
        STORE_HEAVY_DEADLINE_MS,
        `${op} is declared heavy but would be deadlined as a normal invoke`
      );
    }
    // Named explicitly as well, so deleting an entry from the table cannot make
    // the loop above pass by covering less.
    for (const op of [
      "importer.importSession",
      `${DB_HOST_STORE_OP_PREFIX}packScanner.run`,
      `${DB_HOST_STORE_OP_PREFIX}catalog.fetch.run`,
    ]) {
      assert.equal(storeExecuteDeadlineMs(op), STORE_HEAVY_DEADLINE_MS, op);
    }
  });

  it("leaves an ordinary read and an ordinary store op on the invoke budget", () => {
    assert.equal(
      storeExecuteDeadlineMs("sessions.getAll"),
      STORE_INVOKE_DEADLINE_MS
    );
    assert.equal(
      storeExecuteDeadlineMs(`${DB_HOST_STORE_OP_PREFIX}plans.confirm`),
      STORE_INVOKE_DEADLINE_MS
    );
  });

  it("keeps every deadline above the layer it wraps", () => {
    // The reviewer's objection was a FLAT 30s copied from the payload worker.
    // Prisma's own transaction timeout is the layer beneath, so anything at or
    // below it would fire on work that layer still considers healthy.
    //
    // Imported, not re-declared: a literal here keeps passing when the real
    // constant moves, which retires the invariant without a signal.
    assert.ok(STORE_INVOKE_DEADLINE_MS > TRANSACTION_TIMEOUT_MS);
    assert.ok(STORE_HEAVY_DEADLINE_MS > STORE_INVOKE_DEADLINE_MS);
  });
});

describe("ISS-8246 M1: the store worker entry is a bootstrap", () => {
  it("statically imports nothing that can pull in the store graph", () => {
    // PLN-1837 §1.1. A static import that throws runs BEFORE the top-frame
    // catch exists, so it surfaces as a `Worker` error event rather than the
    // serialized `Opened` error the boot path needs — and on the dispatcher
    // that becomes an uncaughtException, an exit, and a restart. A migration
    // refusal is deterministic, so that restart refuses again: an infinite
    // loop. Keeping the graph behind a dynamic import is what prevents it.
    const { value } = importsOf(STORE_WORKER_PATH);
    assert.deepEqual(
      value.toSorted(),
      ["./db-store-protocol.js", "node:worker_threads"],
      "db-store-worker.ts must reach the store only through a dynamic import inside its try/catch"
    );
  });

  it("keeps the inner protocol runtime-import-free", () => {
    // The guarantee above is only as good as what `db-store-protocol.js` drags
    // in behind it. Every import there must erase at build, or the bootstrap's
    // "two static imports" is two static SUBGRAPHS.
    const { value } = importsOf(STORE_PROTOCOL_PATH);
    assert.deepEqual(
      value,
      [],
      "db-store-protocol.ts must use `import type` exclusively; a runtime import here re-opens the crash-loop path db-store-worker.ts avoids"
    );
  });
});
