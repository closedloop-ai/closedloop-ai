import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Node } from "typescript6";
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  ScriptKind,
  ScriptTarget,
} from "typescript6";
import { describe, it } from "vitest";
import type { Importer } from "../src/main/dashboard/agent-dashboard-db-types.js";
import {
  callDbHostOp,
  type DbHostInvokeDeps,
  dispatchDbHostInvoke,
  UNDISPATCHED_WRITE_PROBE_OP,
} from "../src/main/database/db-host/db-host-invoke-dispatch.js";
import {
  DB_HOST_EXCLUSIVE_OP,
  EXCLUSIVE_OPS,
} from "../src/main/database/db-host/db-host-op-lane-registry.js";
import {
  BOUNDED_READ_OP_LIMIT,
  createDbHostOpLanes,
} from "../src/main/database/db-host/db-host-op-lanes.js";
import { DB_HOST_STORE_OP_PREFIX } from "../src/main/database/db-host/db-host-store-op-registry.js";
import {
  type WriteDispatchProbe,
  WriteDispatchState,
  WriteQueueCancelOutcome,
} from "../src/main/database/write-queue.js";

/**
 * ISS-5941 — the worker's invoke dispatch, driven for real.
 *
 * `db-host-worker.ts` registers a `process.parentPort` listener at module load,
 * so it can never be imported by a test. The previous guard on this behavior was
 * an AST scan asserting the three `opLanes.*` method names appeared somewhere
 * inside `dispatchInvoke` — which a dead call or an unconditional bypass would
 * have kept green, and which the repo rule on executing the routing decision
 * against synthetic inputs rules out as sufficient. The dispatch body now lives
 * behind an injected-dependency seam (`db-host-invoke-dispatch.ts`), and these
 * tests execute the real branches against synthetic deps.
 *
 * The AST check that remains is a far narrower claim: that the worker still
 * delegates to the seam at all. It is a wiring guard, not the behavior guard.
 */

const FANOUT = 15;
const TURN_BUDGET = 20;
/**
 * The op path main's proxy builds for the ISS-4572 task-scoped eviction. Spelled
 * from `keyof Importer` so renaming the method fails `tsc` here rather than
 * leaving a test that pins a string nothing answers.
 */
const CANCEL_IN_FLIGHT_WRITE_METHOD =
  "cancelInFlightWrite" satisfies keyof Importer;
const CANCEL_IN_FLIGHT_WRITE_OP =
  `importer.${CANCEL_IN_FLIGHT_WRITE_METHOD}` as const;
/** The default answer for harnesses whose case is not about the probe. */
const ABSENT_PROBE: WriteDispatchProbe = {
  state: WriteDispatchState.Absent,
  taskSeq: null,
};
const HEAVY_BACKFILL_OP = "artifactLinks.backfill";
const LIGHT_STORE_OP = "plans.confirm";
const NOT_INITIALIZED = /db-host not initialized/;
const NOT_CALLABLE = /not callable/;

/** Resolves to `"blocked"` after `turns` macrotask turns have elapsed. */
async function turnBudget(turns: number): Promise<"blocked"> {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return "blocked";
}

type Harness = {
  deps: DbHostInvokeDeps;
  /** The `store:` arm of `runOnStore`; a test swaps this, not the whole dep. */
  runStoreOp: (op: string, args: unknown[]) => Promise<unknown>;
  /** Ordered `task:<marker>` / `deliver:<marker>` log, as they happened. */
  events: string[];
  delivered: unknown[];
  active: number;
  maxActive: number;
};

/**
 * A dispatch wired to the REAL lanes (`createDbHostOpLanes()`) over a synthetic
 * runtime root. Every root method records its own entry/exit so the concurrency
 * a branch actually admits is observable, and `deliver` records where in that
 * sequence the result post lands.
 */
function makeHarness(): Harness {
  const harness: Harness = {
    active: 0,
    maxActive: 0,
    delivered: [],
    events: [],
    runStoreOp: () => Promise.reject(new Error("replaced below")),
    deps: undefined as unknown as DbHostInvokeDeps,
  };
  const track = async (marker: unknown): Promise<unknown> => {
    harness.active += 1;
    harness.maxActive = Math.max(harness.maxActive, harness.active);
    harness.events.push(`task:${String(marker)}`);
    // Cross several turns so an unbounded branch would certainly interleave.
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    harness.active -= 1;
    return marker;
  };
  const root = {
    syncSource: {
      aggregateUsage: track,
      loadSyncedSessions: track,
      loadUsageSessions: track,
      countSessions: track,
      notAFunction: 7,
    },
    dashboard: { getInsights: track, getPlans: track },
  };
  // ISS-8246 M1 — the `store:` half of `runOnStore`, swappable per test. It is a
  // harness field rather than a `deps` override because `runOnStore` now serves
  // BOTH halves: a test that replaced the whole function would take the dotted
  // path down with it and stop exercising `callDbHostOp`.
  harness.runStoreOp = (_op: string, args: unknown[]) => track(args[0]);
  harness.deps = {
    lanes: createDbHostOpLanes(),
    isOpen: () => true,
    // The dotted branch calls PRODUCTION `callDbHostOp` against the fake
    // runtime, so op resolution, the not-callable refusal, and the apply are
    // all still the real ones — they moved to the store thread, they did not
    // stop being covered.
    runOnStore: (op: string, args: unknown[]) =>
      op.startsWith(DB_HOST_STORE_OP_PREFIX)
        ? harness.runStoreOp(op, args)
        : callDbHostOp(root, op, args),
    // A pass-through stand-in for InsightsResultCache: no caching, so every
    // call reaches the compute and the exclusive gate behind it.
    probeUndispatchedWrite: () => ABSENT_PROBE,
    getInsights: (args, compute) =>
      compute(() => undefined).then(() => args[0]),
    deliver: (value: unknown) => {
      harness.delivered.push(value);
      harness.events.push(`deliver:${String(value)}`);
    },
  };
  return harness;
}

const WORKER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/main/database/db-host/db-host-worker.ts"
);

/** Free-function calls made inside the worker's `handleInvoke`, in order. */
function readCallsInHandleInvoke(): string[] {
  const source = createSourceFile(
    WORKER_PATH,
    readFileSync(WORKER_PATH, "utf8"),
    ScriptTarget.Latest,
    true,
    ScriptKind.TS
  );
  let handleInvoke: Node | undefined;
  forEachChild(source, (node) => {
    if (
      isFunctionDeclaration(node) &&
      node.name?.getText(source) === "handleInvoke"
    ) {
      handleInvoke = node;
    }
  });
  if (!handleInvoke) {
    throw new Error("handleInvoke not found in db-host-worker.ts");
  }
  const calls: string[] = [];
  const visit = (node: Node): void => {
    if (isCallExpression(node) && isIdentifier(node.expression)) {
      calls.push(node.expression.getText(source));
    }
    forEachChild(node, visit);
  };
  forEachChild(handleInvoke, visit);
  return calls;
}

describe("dispatchDbHostInvoke — the real routing branches", () => {
  it("caps the bounded-read branch at the lane ceiling", async () => {
    // The branch itself, executed: a fan-out of a gated op through the real
    // dispatch and the real lanes. Pre-fix (`runInvokeOp` a passthrough, or the
    // call site deleted) this reads FANOUT.
    const harness = makeHarness();

    await Promise.all(
      Array.from({ length: FANOUT }, (_unused, i) =>
        dispatchDbHostInvoke("syncSource.aggregateUsage", [i], harness.deps)
      )
    );

    assert.equal(harness.maxActive, BOUNDED_READ_OP_LIMIT);
    assert.equal(harness.delivered.length, FANOUT);
  });

  it("caps a dashboard whole-corpus read through the SAME branch, not the insights one", async () => {
    // ISS-6027 through the real dispatch rather than the lanes alone. The
    // regression it guards is specific to this file: `dashboard.getInsights` is
    // intercepted by an EQUALITY check on the op, and broadening that to a
    // `dashboard.` prefix would route all ten new members into the single-flight
    // cache instead of the bounded lane — un-gating them with the lane suite
    // still green. `maxActive` is what distinguishes the two paths: the insights
    // branch computes under `runExclusive`, so misrouting reads 1 rather than
    // the lane's ceiling. The delivery assertions below cannot make that call —
    // the stand-in cache does not cache, so it runs the compute once per
    // invocation and hands every caller its own result through either branch.
    const harness = makeHarness();

    await Promise.all(
      Array.from({ length: FANOUT }, (_unused, i) =>
        dispatchDbHostInvoke("dashboard.getPlans", [i], harness.deps)
      )
    );

    assert.equal(harness.maxActive, BOUNDED_READ_OP_LIMIT);
    assert.equal(harness.delivered.length, FANOUT);
    assert.deepEqual(
      harness.delivered,
      Array.from({ length: FANOUT }, (_unused, i) => i),
      "per-caller result preservation: the lane defers calls, it does not fold them together"
    );
  });

  it("leaves an ungated invoke op uncapped, so the gate is a filter and not a blanket", async () => {
    const harness = makeHarness();

    await Promise.all(
      Array.from({ length: FANOUT }, (_unused, i) =>
        dispatchDbHostInvoke("syncSource.countSessions", [i], harness.deps)
      )
    );

    assert.equal(harness.maxActive, FANOUT);
  });

  it("serializes a heavy store op and leaves a light one immediate", async () => {
    const heavy = makeHarness();
    await Promise.all(
      Array.from({ length: 4 }, (_unused, i) =>
        dispatchDbHostInvoke(
          `${DB_HOST_STORE_OP_PREFIX}${HEAVY_BACKFILL_OP}`,
          [i],
          heavy.deps
        )
      )
    );
    assert.equal(heavy.maxActive, 1);

    const light = makeHarness();
    await Promise.all(
      Array.from({ length: 4 }, (_unused, i) =>
        dispatchDbHostInvoke(
          `${DB_HOST_STORE_OP_PREFIX}${LIGHT_STORE_OP}`,
          [i],
          light.deps
        )
      )
    );
    assert.equal(light.maxActive, 4);
  });

  it("shares ONE exclusive gate between the insights recompute and a heavy backfill", async () => {
    // They must never run together — that summed peak is what FEA-3150's mutex
    // exists to prevent. Two separate gates would leave this at 2.
    const harness = makeHarness();

    await Promise.all([
      dispatchDbHostInvoke(DB_HOST_EXCLUSIVE_OP, ["insights"], harness.deps),
      dispatchDbHostInvoke(
        `${DB_HOST_STORE_OP_PREFIX}${HEAVY_BACKFILL_OP}`,
        ["backfill"],
        harness.deps
      ),
    ]);

    assert.equal(harness.maxActive, 1);
    assert.equal(harness.delivered.length, 2);
  });

  it("routes EVERY registry-declared exclusive op to the exclusive gate", async () => {
    // ISS-5957 review (T2). Before this, `Exclusive` was a LABEL: the registry
    // declared it and the dispatcher hard-coded `"dashboard.getInsights"`, so
    // the two could disagree with nothing failing. This drives the real dispatch
    // for every op the REGISTRY declares exclusive and asserts each one reached
    // the width-1 gate — which is only true while the dispatcher reads its
    // routing from that same declaration.
    //
    // The signal is the insights CACHE seam, not a lane count: an op the
    // dispatcher failed to intercept falls through to `runInvokeOp`, never
    // reaches `deps.getInsights`, and so is absent from `cacheSeen`. Hard-code
    // the dispatcher to a different op and this reads `[]`.
    assert.ok(EXCLUSIVE_OPS.size > 0, "a vacuous set would pass every assert");

    for (const op of EXCLUSIVE_OPS) {
      const harness = makeHarness();
      const cacheSeen: string[] = [];
      const deps: DbHostInvokeDeps = {
        ...harness.deps,
        getInsights: (args, compute) => {
          cacheSeen.push(op);
          return harness.deps.getInsights(args, compute);
        },
      };

      await dispatchDbHostInvoke(op, [op], deps);

      assert.deepEqual(cacheSeen, [op], `${op} must reach the exclusive gate`);
      assert.equal(harness.delivered.length, 1);
    }
  });

  it("sends an op the registry does NOT declare exclusive through runInvokeOp", async () => {
    // The other direction of the same disagreement: a dispatcher that widened
    // its interception (an op PREFIX rather than the registry's membership)
    // would pull a bounded dashboard read into the width-1 gate and behind the
    // insights cache, which would serve it another op's cached value.
    const harness = makeHarness();
    const cacheSeen: string[] = [];
    const deps: DbHostInvokeDeps = {
      ...harness.deps,
      getInsights: (args, compute) => {
        cacheSeen.push("cache");
        return harness.deps.getInsights(args, compute);
      },
    };
    const boundedDashboardOp = "dashboard.getPlans";
    assert.ok(!EXCLUSIVE_OPS.has(boundedDashboardOp));

    await dispatchDbHostInvoke(boundedDashboardOp, ["plans"], deps);

    assert.deepEqual(cacheSeen, []);
    assert.deepEqual(harness.delivered, ["plans"]);
  });

  it("runs a bounded read CONCURRENTLY with an exclusive backfill", async () => {
    // The reason this is a semaphore and not a second `runExclusive`: an
    // interactive read must not serialize behind a full backfill. Raced against
    // event-loop turns, not a clock — timing assertions are gated in this repo.
    const harness = makeHarness();
    let releaseBackfill = (): void => {
      // replaced synchronously below
    };
    const backfillHeld = new Promise<void>((resolve) => {
      releaseBackfill = resolve;
    });
    harness.runStoreOp = async () => {
      harness.events.push("task:backfill");
      await backfillHeld;
      return "backfill";
    };

    const backfill = dispatchDbHostInvoke(
      `${DB_HOST_STORE_OP_PREFIX}${HEAVY_BACKFILL_OP}`,
      [],
      harness.deps
    );
    await new Promise((resolve) => setImmediate(resolve));
    const read = dispatchDbHostInvoke(
      "syncSource.aggregateUsage",
      ["read"],
      harness.deps
    ).then(() => "read" as const);

    assert.equal(await Promise.race([read, turnBudget(TURN_BUDGET)]), "read");
    releaseBackfill();
    await backfill;
    assert.deepEqual(harness.delivered, ["read", "backfill"]);
  });

  // ISS-8246 M1 — this is also the §1.6 regression, and it did not need a new
  // case: the value now crosses TWO structured clones (store thread →
  // dispatcher, then dispatcher → main) and both must sit inside one permit, or
  // a corpus-sized read escapes BOUNDED_READ_OP_LIMIT while a copy is still in
  // flight. `runOnStore` covers the first — it resolves only when the store's
  // reply has landed — and `deliver` the second, and the assertion below spans
  // from the start of one to the completion of the other. Hoisting either out
  // of the lane callback reddens this.
  it("holds the lane permit until the result is DELIVERED, not merely produced", async () => {
    // whitlockk: the permit used to end when the callable resolved, but the result
    // then still had to flow through `measureOp` and be structured-cloned by
    // `postMessage` in the worker's message handler. `release()` hands the
    // permit straight to the next waiter, so a further hydration could start
    // while a corpus-sized value was still live through the clone — the
    // `limit × one result set` heap bound did not cover the real IPC lifetime.
    //
    // Pinned by ORDER (deterministic, not a timing assertion): run one more op
    // than the ceiling admits, and the queued one must not begin until an
    // earlier result has actually been delivered. With `deliver` moved back
    // outside `runInvokeOp`, release hands the permit over a full turn before
    // the post, so the queued task starts FIRST and this goes red.
    const harness = makeHarness();
    const markers = Array.from(
      { length: BOUNDED_READ_OP_LIMIT + 1 },
      (_unused, i) => `op${i}`
    );

    await Promise.all(
      markers.map((marker) =>
        dispatchDbHostInvoke(
          "syncSource.aggregateUsage",
          [marker],
          harness.deps
        )
      )
    );

    const queuedStart = harness.events.indexOf(
      `task:${markers.at(-1) as string}`
    );
    const firstDelivery = harness.events.findIndex((event) =>
      event.startsWith("deliver:")
    );
    assert.ok(queuedStart >= 0 && firstDelivery >= 0);
    assert.ok(
      queuedStart > firstDelivery,
      `the queued op must start only after a delivery released a permit — got ${harness.events.join(", ")}`
    );
    assert.equal(harness.delivered.length, markers.length);
  });

  it("delivers the insights result OUTSIDE the gate, since the cache fans one value to many callers", async () => {
    // The deliberate exception to the rule above: `InsightsResultCache`
    // single-flights the recompute and serves later hits without entering a
    // lane at all, so one caller's permit cannot span another caller's post.
    // Every requester must still get its own delivery.
    const harness = makeHarness();
    const shared = { value: "insights" };
    let computes = 0;
    harness.deps = {
      ...harness.deps,
      getInsights: async (_args, compute) => {
        computes += 1;
        await compute(() => undefined);
        return shared;
      },
    };

    await Promise.all(
      Array.from({ length: 3 }, (_unused, i) =>
        dispatchDbHostInvoke(DB_HOST_EXCLUSIVE_OP, [i], harness.deps)
      )
    );

    assert.equal(computes, 3);
    assert.deepEqual(harness.delivered, [shared, shared, shared]);
  });

  it("delivers nothing and throws when the op is missing or not callable", async () => {
    const harness = makeHarness();

    await assert.rejects(
      () => dispatchDbHostInvoke("syncSource.notAFunction", [], harness.deps),
      NOT_CALLABLE
    );
    await assert.rejects(
      () => dispatchDbHostInvoke("syncSource.nope", [], harness.deps),
      NOT_CALLABLE
    );
    assert.deepEqual(harness.delivered, []);
  });

  it("refuses every branch before the runtime is open", async () => {
    const harness = makeHarness();
    const closed: DbHostInvokeDeps = { ...harness.deps, isOpen: () => false };

    for (const op of [
      "syncSource.aggregateUsage",
      `${DB_HOST_STORE_OP_PREFIX}${HEAVY_BACKFILL_OP}`,
      DB_HOST_EXCLUSIVE_OP,
    ]) {
      await assert.rejects(
        () => dispatchDbHostInvoke(op, [], closed),
        NOT_INITIALIZED
      );
    }
    assert.deepEqual(harness.delivered, []);
  });

  it("is the seam the worker's handleInvoke actually delegates to", () => {
    // Narrow wiring guard only — the behavior is covered above. Without it,
    // deleting the delegation leaves every test in this file green against a
    // seam nothing calls.
    assert.ok(
      readCallsInHandleInvoke().includes("dispatchDbHostInvoke"),
      "handleInvoke must dispatch through db-host-invoke-dispatch.ts"
    );
  });
});

describe("ISS-8246 M3: a write eviction is an ordinary store op", () => {
  it("forwards the eviction to the store thread instead of answering it here", async () => {
    const evictedSessionId = "session-1";
    const reason = new Error("historical import evicted");
    const storeCalls: { op: string; args: unknown[] }[] = [];
    const delivered: unknown[] = [];
    // The store answers only when this is released, so "the dispatcher waited"
    // is observable rather than assumed. A `Promise.resolve` fake cannot tell a
    // forwarded answer from a synthesized one.
    let answerStore: (outcome: unknown) => void = () => undefined;
    const storeAnswer = new Promise<unknown>((resolve) => {
      answerStore = resolve;
    });
    const deps: DbHostInvokeDeps = {
      lanes: createDbHostOpLanes(),
      isOpen: () => true,
      runOnStore: (op: string, args: unknown[]) => {
        storeCalls.push({ op, args });
        return storeAnswer;
      },
      probeUndispatchedWrite: () => {
        throw new Error("an eviction must not take the probe branch");
      },
      getInsights: () =>
        Promise.reject(new Error("an eviction must not take the cache branch")),
      deliver: (value: unknown) => {
        delivered.push(value);
      },
    };

    const dispatched = dispatchDbHostInvoke(
      CANCEL_IN_FLIGHT_WRITE_OP,
      [evictedSessionId, reason],
      deps
    );
    await turnBudget(TURN_BUDGET);

    // The whole point of the case: there is NO dispatcher-side answer for an
    // eviction. The write queue that owns both outcomes lives on the store
    // thread, so the request travels the same path as every other op and is
    // picked up only when that thread's loop turns — which is why
    // `IMPORT_EVICTION_CLASSIFY_TIMEOUT_MS` still governs after M1 and why
    // PLN-1837 M3's "Queued becomes trivially correct" does not hold.
    //
    // The ARGUMENTS are asserted, not just the op path: ISS-4572 eviction is
    // task-scoped, so a dispatcher that forwarded the call while dropping or
    // rewriting the session id would evict the wrong write — or none — and an
    // op-only assertion would stay green through it.
    assert.deepEqual(storeCalls, [
      { op: CANCEL_IN_FLIGHT_WRITE_OP, args: [evictedSessionId, reason] },
    ]);
    assert.deepEqual(
      delivered,
      [],
      "main must not be told an outcome the store has not reported"
    );

    answerStore(WriteQueueCancelOutcome.Queued);
    await dispatched;

    assert.deepEqual(delivered, [WriteQueueCancelOutcome.Queued]);
  });
});

/**
 * ISS-7256 (whitlockk review) — the ONE op the dispatcher answers itself.
 *
 * The eviction case above pins that a queue MUTATION still forwards. This is its
 * counterpart, and the asymmetry is the design: the read-only probe is asked at a
 * deadline that fires BECAUSE the store thread is inside a long synchronous
 * write, so forwarding it parks the request on the very thread whose blockage is
 * the question. The bound then waits out its own backstop, gets no evidence, and
 * takes the old expiry path — ISS-7256 fixing nothing in the production topology.
 */
describe("ISS-7256: the undispatched-write probe is answered by the dispatcher", () => {
  it("never forwards the probe, even while the store thread answers nothing", async () => {
    const storeCalls: { op: string; args: unknown[] }[] = [];
    const delivered: unknown[] = [];
    const probed: string[] = [];
    const queuedProbe: WriteDispatchProbe = {
      state: WriteDispatchState.Queued,
      taskSeq: 41,
    };
    const deps: DbHostInvokeDeps = {
      lanes: createDbHostOpLanes(),
      isOpen: () => true,
      // A store that never answers ANYTHING — the blocked thread, modelled.
      runOnStore: (op: string, args: unknown[]) => {
        storeCalls.push({ op, args });
        return new Promise<unknown>(() => undefined);
      },
      probeUndispatchedWrite: (token: string) => {
        probed.push(token);
        return queuedProbe;
      },
      getInsights: () =>
        Promise.reject(new Error("the probe must not take the cache branch")),
      deliver: (value: unknown) => {
        delivered.push(value);
      },
    };

    await dispatchDbHostInvoke(
      UNDISPATCHED_WRITE_PROBE_OP,
      ["session-1"],
      deps
    );
    await turnBudget(TURN_BUDGET);

    assert.deepEqual(
      storeCalls,
      [],
      "the probe must never reach the thread whose blockage it asks about"
    );
    assert.deepEqual(
      probed,
      ["session-1"],
      "and the session id must survive the hop, or it answers about the wrong write"
    );
    assert.deepEqual(delivered, [queuedProbe]);
  });

  it("resolves an unusable token to Absent rather than inventing a waiter", async () => {
    const delivered: unknown[] = [];
    const probed: string[] = [];
    const deps: DbHostInvokeDeps = {
      lanes: createDbHostOpLanes(),
      isOpen: () => true,
      runOnStore: () => Promise.reject(new Error("must not forward")),
      probeUndispatchedWrite: (token: string) => {
        probed.push(token);
        return ABSENT_PROBE;
      },
      getInsights: () => Promise.reject(new Error("must not cache")),
      deliver: (value: unknown) => {
        delivered.push(value);
      },
    };

    // `args` crossed a structured clone, so its shape is not constrained by the
    // caller's types.
    await dispatchDbHostInvoke(UNDISPATCHED_WRITE_PROBE_OP, [42], deps);

    assert.deepEqual(probed, [""], "a non-string token is not passed through");
    assert.deepEqual(delivered, [ABSENT_PROBE]);
  });

  it("refuses before the store is open, like every other op", async () => {
    const deps: DbHostInvokeDeps = {
      lanes: createDbHostOpLanes(),
      isOpen: () => false,
      runOnStore: () => Promise.reject(new Error("must not forward")),
      probeUndispatchedWrite: () => {
        throw new Error("must not probe before open");
      },
      getInsights: () => Promise.reject(new Error("must not cache")),
      deliver: () => undefined,
    };
    await assert.rejects(
      dispatchDbHostInvoke(UNDISPATCHED_WRITE_PROBE_OP, ["s"], deps),
      NOT_INITIALIZED
    );
  });
});
