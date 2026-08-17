import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_READER_POOL_SIZE } from "../src/main/database/connection-pragmas.js";
import {
  BOUNDED_READ_OPS,
  DB_HOST_EXCLUSIVE_OP,
} from "../src/main/database/db-host/db-host-op-lane-registry.js";
import {
  BOUNDED_READ_OP_LIMIT,
  createDbHostOpLanes,
  HEAVY_STORE_OPS,
  SESSIONS_PAGE_MAX_CONCURRENT_BOUNDED_OPS,
} from "../src/main/database/db-host/db-host-op-lanes.js";
import {
  type BoundedLaneTiming,
  createBoundedOpLane,
} from "../src/main/database/db-host/heavy-op-gate.js";
import { SKILL_SHADOW_INVENTORY_REPAIR_OP } from "../src/main/database/skill-shadow-inventory-repair-boundary.js";
import { SessionFacetDimension } from "../src/main/session/shared-agent-sessions-facet-usage.js";

/**
 * ISS-5941 — an UNBOUNDED FAN-OUT on the db-host's generic invoke path: the
 * heavy `syncSource` reads reached the single worker with no admission control
 * at all, and ~15 concurrent calls each held their own corpus-sized result set
 * live. FEA-3150's governor existed but was wired only to two `store:`
 * backfills and the insights recompute.
 *
 * NOT premised on "exit code 5 = heap OOM" — PR #2806 corrected that reading
 * (the code is a signal number; the real cause was a patched libsql connection
 * leak), and `shared-branches-api.ts` warns against reprising it. The premise
 * here is the direct measurement: an ungated 15-way fan-out holds 2174/2173 MB
 * of peak JS heap against a ~4 GiB cage, and a larger corpus reproduces a REAL
 * heap OOM with the `FATAL ERROR: Ineffective mark-compacts` banner and rc=134.
 * See the header of `db-host-op-lanes.ts`.
 *
 * These tests EXECUTE the production routing decision (`createDbHostOpLanes`,
 * which `dispatchInvoke` consumes) rather than asserting that a predicate exists
 * somewhere. They pin the two properties that actually bound memory — the
 * concurrency ceiling and the resulting peak WORKING SET — and deliberately
 * assert no wall-clock timing (gated by `no-timing-assertions`).
 *
 * Every concurrency assertion below fails on pre-fix code: without the lane,
 * `runInvokeOp` is a passthrough and `maxActive` reaches the full fan-out width.
 */

const BOOM = /boom/;
const FANOUT = 15;

/**
 * A member of `HEAVY_STORE_OPS`. The two `*.backfill` keys have no canonical
 * exported constant anywhere (unlike `SKILL_SHADOW_INVENTORY_REPAIR_OP`), so the
 * literal is named once here rather than repeated at each call site.
 */
const HEAVY_BACKFILL_OP = "artifactLinks.backfill";

/**
 * Event-loop turns to allow a lane task before declaring it blocked. Counting
 * TURNS rather than milliseconds keeps this load-insensitive — a wall-clock
 * timeout would be a timing assertion, which is gated in this repo.
 */
const TURN_BUDGET = 20;

/** Resolves to `"blocked"` after `turns` macrotask turns have elapsed. */
async function turnBudget(turns: number): Promise<"blocked"> {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return "blocked";
}

/** Bytes a single in-flight read is modelled as holding live. */
const PER_TASK_RETAINED_BYTES = 1024 * 1024;

/**
 * A task that records how many lane tasks are in flight while it runs, and the
 * peak bytes RETAINED across them.
 *
 * The retained figure is a model, not a `process.memoryUsage()` sample: each task
 * allocates and holds `PER_TASK_RETAINED_BYTES` for its whole duration, so peak
 * retention is `maxActive x PER_TASK_RETAINED_BYTES` by construction. That is the
 * point — the OOM was linear in how many corpus-sized result sets coexisted, and
 * this pins the multiplier. Sampling real RSS here would measure the GC, not the
 * bound; the real before/after RSS numbers live in the PR.
 */
function makeTracker(): {
  task: () => Promise<void>;
  maxActive: number;
  active: number;
  peakRetainedBytes: number;
} {
  const tracker = {
    active: 0,
    maxActive: 0,
    peakRetainedBytes: 0,
    task: async (): Promise<void> => {
      tracker.active += 1;
      tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
      const held = new Uint8Array(PER_TASK_RETAINED_BYTES);
      held[0] = 1;
      tracker.peakRetainedBytes = Math.max(
        tracker.peakRetainedBytes,
        tracker.active * held.byteLength
      );
      // Cross several macrotask turns so an unbounded lane would certainly
      // interleave the whole fan-out.
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      tracker.active -= 1;
    },
  };
  return tracker;
}

describe("createBoundedOpLane", () => {
  it("never exceeds its limit, and bounds peak working set to limit × per-task", async () => {
    const lane = createBoundedOpLane({ limit: 2 });
    const tracker = makeTracker();

    await Promise.all(
      Array.from({ length: FANOUT }, () => lane.runBounded(tracker.task))
    );

    assert.equal(tracker.maxActive, 2);
    // The bound that matters: peak retained bytes is limit × one task's set,
    // NOT fan-out × one task's set (which is what OOM-killed the worker).
    assert.equal(tracker.peakRetainedBytes, 2 * PER_TASK_RETAINED_BYTES);
    assert.ok(
      tracker.peakRetainedBytes < FANOUT * PER_TASK_RETAINED_BYTES,
      "an unbounded lane would retain the full fan-out at once"
    );
    assert.equal(tracker.active, 0);
  });

  it("coerces a degenerate limit to 1 rather than deadlocking", async () => {
    // 0 admits nothing; NaN makes every `active < limit` compare false, which
    // would wedge the lane permanently rather than merely narrow it.
    for (const limit of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const lane = createBoundedOpLane({ limit });
      const tracker = makeTracker();

      await Promise.all(
        Array.from({ length: 4 }, () => lane.runBounded(tracker.task))
      );

      // Every non-finite or non-positive width falls back to the safest lane
      // that still makes progress: width 1.
      assert.equal(
        tracker.maxActive,
        1,
        `limit ${String(limit)} must still admit work`
      );
    }
  });

  it("releases the permit when a task rejects, so the lane cannot wedge", async () => {
    const lane = createBoundedOpLane({ limit: 1 });

    await assert.rejects(
      () => lane.runBounded(() => Promise.reject(new Error("boom"))),
      BOOM
    );
    // A wedged lane would never resolve this.
    assert.equal(await lane.runBounded(() => Promise.resolve("ok")), "ok");
  });

  it("runs waiters in FIFO order so a steady arrival stream cannot starve one", async () => {
    const lane = createBoundedOpLane({ limit: 1 });
    const order: number[] = [];

    await Promise.all(
      Array.from({ length: 5 }, (_unused, i) =>
        lane.runBounded(async () => {
          await new Promise((resolve) => setImmediate(resolve));
          order.push(i);
        })
      )
    );

    assert.deepEqual(order, [0, 1, 2, 3, 4]);
  });

  it("keeps FIFO order across STAGGERED arrivals, not just a same-turn burst", async () => {
    // The FIFO test above enqueues every caller in one turn. This one staggers
    // them — `late` asks only after `queued` is already parked — which is the
    // shape a real fan-out has (renderer requests arriving over several turns).
    //
    // Deliberately NOT claimed: that this discriminates permit-hand-off from
    // decrement-then-drain. It does not. Both are synchronous in one function
    // body with no turn boundary between them, so no arrival can observe the
    // intermediate state under either strategy — see the note on `release()`.
    const lane = createBoundedOpLane({ limit: 1 });
    const order: string[] = [];
    let releaseHolder = (): void => {
      // replaced synchronously below
    };
    const holderDone = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    const holder = lane.runBounded(async () => {
      order.push("holder");
      await holderDone;
    });
    // Let `holder` take the only permit before anyone else asks.
    await new Promise((resolve) => setImmediate(resolve));
    const queued = lane.runBounded(() => {
      order.push("queued");
      return Promise.resolve();
    });
    // `late` asks strictly after `queued` is already parked in `waiting`.
    await new Promise((resolve) => setImmediate(resolve));
    const late = lane.runBounded(() => {
      order.push("late");
      return Promise.resolve();
    });

    releaseHolder();
    await Promise.all([holder, queued, late]);

    assert.deepEqual(order, ["holder", "queued", "late"]);
  });

  it("awaits the admission gate before the task runs", async () => {
    const events: string[] = [];
    const lane = createBoundedOpLane({
      limit: 1,
      admit: async () => {
        events.push("admit");
        await new Promise((resolve) => setImmediate(resolve));
      },
    });

    await lane.runBounded(() => {
      events.push("task");
      return Promise.resolve();
    });

    assert.deepEqual(events, ["admit", "task"]);
  });

  it("holds NO permit while parked in admission, so parking cannot block the lane", async () => {
    // Regression on the H4 shape: when `admit` ran under a held permit, a queue
    // of parked ops blocked every other bounded read behind them. Here the gate
    // parks the first caller until we release it; a second caller whose gate is
    // already clear must still get through.
    let releaseFirstAdmit = (): void => {
      // replaced synchronously below
    };
    const firstParked = new Promise<void>((resolve) => {
      releaseFirstAdmit = resolve;
    });
    let admitCalls = 0;
    const lane = createBoundedOpLane({
      limit: 1,
      admit: () => {
        admitCalls += 1;
        return admitCalls === 1 ? firstParked : Promise.resolve();
      },
    });

    const ran: string[] = [];
    const parked = lane.runBounded(async () => {
      ran.push("parked");
      await Promise.resolve();
    });
    const clear = lane.runBounded(async () => {
      ran.push("clear");
      await Promise.resolve();
    });

    // The second op completes while the first is still parked in admission.
    await clear;
    assert.deepEqual(ran, ["clear"]);

    releaseFirstAdmit();
    await parked;
    assert.deepEqual(ran, ["clear", "parked"]);
  });

  it("re-consults pressure for a QUEUED op, but not for a fast-path one", async () => {
    // A queued op may have sat behind the lane arbitrarily long, so its first
    // pressure reading is stale exactly when it is about to allocate. A
    // fast-path op just read it and must not pay for a second check.
    let admitCalls = 0;
    const lane = createBoundedOpLane({
      limit: 1,
      admit: () => {
        admitCalls += 1;
        return Promise.resolve();
      },
    });

    // Runs immediately: 1 admit, no queueing.
    await lane.runBounded(() => Promise.resolve());
    assert.equal(
      admitCalls,
      1,
      "a fast-path op consults admission exactly once"
    );

    // Two at once: the first takes the permit (1 admit), the second queues and
    // must re-consult after acquiring (2 admits) — 3 more in total.
    admitCalls = 0;
    await Promise.all([
      lane.runBounded(async () => {
        await new Promise((resolve) => setImmediate(resolve));
      }),
      lane.runBounded(() => Promise.resolve()),
    ]);
    assert.equal(
      admitCalls,
      3,
      "the queued op re-consults pressure after acquiring its permit"
    );
  });

  it("HOLDS its permit while parked in the post-acquire check, unlike the pre-acquire one", async () => {
    // The counterpart to the test above, and the pair is the point: counting
    // `admit` calls cannot tell which SIDE of the permit a wait landed on, so
    // neither the two-call assertion nor the pre-acquire test pins step 2's
    // real cost. Step 2 parks WITH a permit held — a deliberate trade (a task
    // about to allocate should keep the lane narrow under pressure), not the
    // behavior the pre-acquire check exists to avoid. This asserts it rather
    // than leaving the docblock to claim it.
    let releaseSecondAdmit = (): void => {
      // replaced synchronously below
    };
    const secondAdmitParked = new Promise<void>((resolve) => {
      releaseSecondAdmit = resolve;
    });
    let admitCalls = 0;
    const lane = createBoundedOpLane({
      limit: 1,
      // Call 1: `holder`'s pre-acquire (fast path, no post-acquire check).
      // Call 2: `queued`'s pre-acquire. Call 3: `queued`'s POST-acquire — park
      // there, holding the lane's only permit. Call 4+: `late`'s pre-acquire.
      admit: () => {
        admitCalls += 1;
        return admitCalls === 3 ? secondAdmitParked : Promise.resolve();
      },
    });

    const ran: string[] = [];
    let releaseHolder = (): void => {
      // replaced synchronously below
    };
    const holderDone = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = lane.runBounded(async () => {
      ran.push("holder");
      await holderDone;
    });
    await new Promise((resolve) => setImmediate(resolve));
    const queued = lane.runBounded(() => {
      ran.push("queued");
      return Promise.resolve();
    });
    // Hand the permit to `queued`, which immediately parks in its post-acquire
    // check still holding it.
    releaseHolder();
    await holder;

    // `late`'s own admission is clear, so the ONLY thing that can stop it is the
    // permit `queued` is sitting on while parked. Raced against event-loop
    // turns, not a clock — a timing assertion is gated in this repo.
    const late = lane
      .runBounded(() => {
        ran.push("late");
        return Promise.resolve();
      })
      .then(() => "late" as const);
    const outcome = await Promise.race([late, turnBudget(TURN_BUDGET)]);

    assert.equal(
      outcome,
      "blocked",
      "a post-acquire park must hold its permit — moving that wait outside the permit would let `late` through"
    );
    assert.deepEqual(ran, ["holder"]);

    releaseSecondAdmit();
    await Promise.all([queued, late]);
    assert.deepEqual(ran, ["holder", "queued", "late"]);
  });

  it("releases the permit when the post-acquire admission gate rejects", async () => {
    // The second `admit` runs INSIDE the try, with a permit genuinely held, so a
    // rejection there must still release. (The first runs OUTSIDE it, holding
    // nothing — releasing there would drive `active` negative.)
    let admitCalls = 0;
    const lane = createBoundedOpLane({
      limit: 1,
      admit: () => {
        admitCalls += 1;
        // Reject only the post-acquire check of the SECOND (queued) caller.
        return admitCalls === 3
          ? Promise.reject(new Error("boom"))
          : Promise.resolve();
      },
    });

    const holder = lane.runBounded(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
    const rejected = lane.runBounded(() => Promise.resolve("never"));

    await holder;
    await assert.rejects(() => rejected, BOOM);
    // If that permit leaked, the lane would now be permanently full.
    assert.equal(await lane.runBounded(() => Promise.resolve("ok")), "ok");
  });

  it("admits every op even when the admission gate gives up under sustained pressure", async () => {
    // The FEA-3150 contract: admission THROTTLES, it never starves. Model the
    // real `awaitMemoryPressureClearForAdmission`, which parks for a BOUNDED
    // number of ticks and then resolves anyway while pressure is still high.
    let parks = 0;
    const lane = createBoundedOpLane({
      limit: 2,
      admit: async () => {
        parks += 1;
        await new Promise((resolve) => setImmediate(resolve));
      },
    });
    const results = await Promise.all(
      Array.from({ length: FANOUT }, (_unused, i) =>
        lane.runBounded(() => Promise.resolve(i))
      )
    );
    assert.equal(parks, FANOUT, "every op consults the admission gate");
    assert.deepEqual(
      results,
      Array.from({ length: FANOUT }, (_u, i) => i),
      "nothing is dropped or reordered by a gate that defers"
    );
  });
});

describe("createDbHostOpLanes — the production routing decision", () => {
  it("bounds every gated op through ONE SHARED ceiling, not one ceiling each", async () => {
    // Deliberately a single `createDbHostOpLanes()` with all the gated op names
    // INTERLEAVED through it. Driving each name against its own fresh lane —
    // which this test used to do — proves only that each is bounded in
    // isolation: a regression to one semaphore per op name would admit
    // `BOUNDED_READ_OPS.size × limit` concurrent reads, exactly the summed
    // working set the lane exists to cap, and stay green.
    const lanes = createDbHostOpLanes();
    const tracker = makeTracker();
    const ops = [...BOUNDED_READ_OPS];

    await Promise.all(
      Array.from({ length: FANOUT * ops.length }, (_unused, i) =>
        lanes.runInvokeOp(ops[i % ops.length] as string, tracker.task)
      )
    );

    assert.equal(
      tracker.maxActive,
      BOUNDED_READ_OP_LIMIT,
      `${ops.join(" + ")} must share one ceiling`
    );
    // The bound that matters is on the SUM: peak retention is the ceiling's
    // worth, not one ceiling's worth per op name.
    assert.equal(
      tracker.peakRetainedBytes,
      BOUNDED_READ_OP_LIMIT * PER_TASK_RETAINED_BYTES
    );
    assert.ok(
      BOUNDED_READ_OP_LIMIT < FANOUT,
      "the ceiling must actually bound the fan-out"
    );
    assert.equal(tracker.active, 0);
  });

  it("routes the heavy syncSource, dashboard AND named Branch reads, and nothing else", () => {
    // Pinned explicitly: the set is the contract, and silently widening it would
    // queue interactive reads behind heavy ones. `loadUsageSessions` is the
    // `canUseAggregateSessionFilters` fallback — leaving it out let every
    // cost/model/harness-filtered Sessions request re-create the unbounded
    // working set on the 2s poll.
    //
    // ISS-6027: the `dashboard.*` reads ISS-5938 moved onto the SAME reader pool
    // are members too. `getPacks`/`getAnalytics`/`getCoreFeatures` reach the pool
    // through internal calls that take no permit of their own, so gating the
    // outer op is the only thing that bounds them.
    //
    // ISS-5957 adds `syncSource.aggregateAnalytics` (ISS-5941's own top-ranked
    // residual, measured at 27.1s for ONE call on a real 4,285-session corpus)
    // and the two NAMED Branch read facades. The raw `prisma.client.*` Branch
    // corpus reads are deliberately still absent — they are unreachable by op
    // name, which is the gap `db-host-op-lane-registry.ts` records.
    assert.deepEqual([...BOUNDED_READ_OPS].sort(), [
      "dashboard.getAnalytics",
      "dashboard.getCoreFeatures",
      "dashboard.getPacks",
      "dashboard.getPlans",
      "dashboard.getPullRequests",
      "dashboard.getSkills",
      "dashboard.getSubAgents",
      "dashboard.getTokenAnalytics",
      "dashboard.getTools",
      "dashboard.getWorkflowData",
      "readBranchCanonicalActivityRows",
      "readBranchMetricEventEvidence",
      "syncSource.aggregateAnalytics",
      "syncSource.aggregateUsage",
      "syncSource.loadSyncedSessions",
      "syncSource.loadUsageSessions",
    ]);
  });

  it("shares ONE ceiling between a dashboard read and a Sessions read", async () => {
    // ISS-6027, driven with LITERAL op names rather than the set, so it fails on
    // pre-fix code instead of tautologically following whatever the set holds.
    // The state this rules out is the one BOUNDED_READ_OP_LIMIT's own comment
    // says a ceiling of 2 avoids: a whole-corpus `getPlans` occupying a reader
    // slot while an `aggregateUsage` holds a permit and executes no SQL, waiting
    // on the adapter's per-connection mutex. Asserted as a CONCURRENCY bound —
    // no duration appears here, per that constant's standing warning that no
    // latency measurement exists at any ceiling.
    const lanes = createDbHostOpLanes();
    const tracker = makeTracker();
    const ops = ["dashboard.getPlans", "syncSource.aggregateUsage"];

    await Promise.all(
      Array.from({ length: FANOUT * ops.length }, (_unused, i) =>
        lanes.runInvokeOp(ops[i % ops.length] as string, tracker.task)
      )
    );

    assert.equal(tracker.maxActive, BOUNDED_READ_OP_LIMIT);
    assert.equal(
      tracker.peakRetainedBytes,
      BOUNDED_READ_OP_LIMIT * PER_TASK_RETAINED_BYTES
    );
    assert.equal(tracker.active, 0);
  });

  it("keeps the insights op OUT of the bounded lane — it has its own", () => {
    // `dispatchDbHostInvoke` routes it to the EXCLUSIVE lane behind the FEA-2055
    // cache and returns before `runInvokeOp`, so membership here would be dead
    // code that reads like a second, contradictory admission decision.
    assert.ok(!BOUNDED_READ_OPS.has(DB_HOST_EXCLUSIVE_OP));
  });

  it("leaves cheap invoke ops UNGATED so the UI never queues behind a heavy read", async () => {
    const lanes = createDbHostOpLanes();
    const tracker = makeTracker();

    // A control the fix must NOT capture: a metadata-only count. If this were
    // gated too, the assertion below would read BOUNDED_READ_OP_LIMIT instead.
    await Promise.all(
      Array.from({ length: FANOUT }, () =>
        lanes.runInvokeOp("syncSource.countSessions", tracker.task)
      )
    );

    assert.equal(tracker.maxActive, FANOUT);
  });

  it("serializes heavy store ops and leaves light ones immediate", async () => {
    const lanes = createDbHostOpLanes();
    const heavy = makeTracker();
    const light = makeTracker();

    await Promise.all([
      ...Array.from({ length: 4 }, () =>
        lanes.runStoreOp(HEAVY_BACKFILL_OP, heavy.task)
      ),
      ...Array.from({ length: 4 }, () =>
        lanes.runStoreOp(SKILL_SHADOW_INVENTORY_REPAIR_OP, light.task)
      ),
    ]);

    assert.equal(heavy.maxActive, 1);
    assert.equal(light.maxActive, 4);
    assert.ok(HEAVY_STORE_OPS.has(HEAVY_BACKFILL_OP));
    assert.ok(!HEAVY_STORE_OPS.has(SKILL_SHADOW_INVENTORY_REPAIR_OP));
  });

  it("runs a bounded read CONCURRENTLY with an exclusive backfill", async () => {
    // The whole reason this is a semaphore and not a second `runExclusive`: a
    // Sessions read must not be serialized behind a full transcript backfill for
    // the backfill's entire duration (the failure HEAVY_STORE_OPS was narrowed
    // to avoid). Routing BOUNDED_READ_OPS through the mutex would leave every
    // other test in this file green while reintroducing exactly that freeze.
    const lanes = createDbHostOpLanes();
    const order: string[] = [];
    let releaseBackfill = (): void => {
      // replaced synchronously below
    };
    const backfillHeld = new Promise<void>((resolve) => {
      releaseBackfill = resolve;
    });

    const backfill = lanes.runStoreOp(HEAVY_BACKFILL_OP, async () => {
      order.push("backfill:start");
      await backfillHeld;
      order.push("backfill:end");
    });
    // Let the backfill take the exclusive gate before the read asks.
    await new Promise((resolve) => setImmediate(resolve));

    // The read must complete while the backfill is STILL holding the mutex.
    // Raced against a bounded number of event-loop TURNS (not a wall-clock
    // timeout — timing assertions are gated) so that a regression routing this
    // op through the mutex fails the assertion instead of hanging the runner.
    const read = lanes
      .runInvokeOp("syncSource.aggregateUsage", () => {
        order.push("read");
        return Promise.resolve();
      })
      .then(() => "read" as const);
    const outcome = await Promise.race([read, turnBudget(TURN_BUDGET)]);

    assert.equal(
      outcome,
      "read",
      "a bounded read must not serialize behind an exclusive backfill"
    );
    assert.deepEqual(order, ["backfill:start", "read"]);
    releaseBackfill();
    await backfill;
    assert.deepEqual(order, ["backfill:start", "read", "backfill:end"]);
  });

  it("holds the ceiling at 2 — below one page request's width, on purpose", () => {
    // The value itself, pinned. It was 4 (one whole page request's width) and is
    // deliberately 2: at the same fan-out, 2 roughly halved peak JS heap where 4
    // cut it 38%, and heap is the axis with numbers behind it. NO latency
    // measurement exists at any ceiling, so nothing here asserts one.
    assert.equal(BOUNDED_READ_OP_LIMIT, 2);
    // The accepted cost, stated as an assertion rather than a comment: a
    // fully-filtered page request wants more than the lane admits, so it DOES
    // queue against itself. If someone raises the ceiling back to one request's
    // width, this fails and they have to come read why it is 2.
    assert.ok(
      BOUNDED_READ_OP_LIMIT < SESSIONS_PAGE_MAX_CONCURRENT_BOUNDED_OPS,
      "the ceiling is deliberately below one page request's width — see BOUNDED_READ_OP_LIMIT"
    );
    // The facet-scoping phase is the widest one, and there are exactly four
    // facet dimensions (Owner, Harness, Model, Repository) it can fan out over.
    // That is a fact about the page, and it is what the ceiling queues.
    assert.equal(
      SESSIONS_PAGE_MAX_CONCURRENT_BOUNDED_OPS,
      Object.keys(SessionFacetDimension).length
    );
    // Landing exactly on the reader pool is a useful coincidence, not the
    // derivation: a phase made only of connection-holding `aggregateUsage` reads
    // executes 2-wide regardless of permits, so there the ceiling costs nothing.
    // Narrower than the pool WOULD idle a reader connection, so this is the real
    // floor. (An earlier revision asserted `limit >= pool` "so SQL throughput is
    // never the binding constraint" — backwards; the pool IS the constraint.)
    assert.equal(BOUNDED_READ_OP_LIMIT, DEFAULT_READER_POOL_SIZE);
    // And strictly below the fan-out it exists to cut, or the lane is
    // decorative. A ceiling raised "just to be safe" past the fan-out fails here.
    assert.ok(
      BOUNDED_READ_OP_LIMIT < FANOUT,
      "a ceiling at or above the fan-out bounds nothing"
    );
  });

  it("returns each op's own result unchanged — the bound defers, never truncates", async () => {
    const lanes = createDbHostOpLanes();
    const rows = Array.from({ length: FANOUT }, (_unused, i) => [i, i + 1]);

    const results = await Promise.all(
      rows.map((row) =>
        lanes.runInvokeOp("syncSource.aggregateUsage", () =>
          Promise.resolve(row)
        )
      )
    );

    // No caller gets a partial or lazily-truncated aggregate back.
    assert.deepEqual(results, rows);
  });

  it("propagates a gated op's rejection to its own caller", async () => {
    const lanes = createDbHostOpLanes();
    await assert.rejects(
      () =>
        lanes.runInvokeOp("syncSource.loadSyncedSessions", () =>
          Promise.reject(new Error("boom"))
        ),
      BOOM
    );
    // And the lane still serves the next caller.
    assert.equal(
      await lanes.runInvokeOp("syncSource.loadSyncedSessions", () =>
        Promise.resolve("ok")
      ),
      "ok"
    );
  });
});

/**
 * The lane's ADMISSION BREAKDOWN.
 *
 * Motivation, measured rather than argued: driving the real store against a
 * clone of a 2.1 GB / 2,962-session population, ONE `pageData` read costs ~2.1s
 * of pure execution while the Sessions view refetches every 2.0s. Service time
 * therefore exceeds the poll interval, the bounded lane's two permits are the
 * contended resource, and reads miss their 10s deadline having spent most of
 * that time WAITING rather than running.
 *
 * `db-ops.jsonl` cannot show that: `measureOp` starts its clock when the worker
 * dispatches the op, so a lane wait is billed to the op as execution and "the
 * query is slow" reads identically to "the query queued". These tests pin the
 * split that distinguishes them.
 *
 * The clock is INJECTED throughout — no assertion here reads the real clock, so
 * nothing below can flake on a loaded machine, and the attribution is exact.
 */
describe("bounded lane admission breakdown", () => {
  /** A clock the test advances by hand; `tick` is the only source of time. */
  function fakeClock(): { now: () => number; tick: (ms: number) => void } {
    let value = 0;
    return {
      now: () => value,
      tick: (ms: number) => {
        value += ms;
      },
    };
  }

  it("bills a queued op's wait to queueMs, NOT to execMs", async () => {
    const clock = fakeClock();
    const seen: BoundedLaneTiming[] = [];
    const lane = createBoundedOpLane({ limit: 1, now: clock.now });

    // Occupy the single permit with a task the test releases by hand.
    let releaseFirst: () => void = () => undefined;
    const first = lane.runBounded(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
      (t) => seen.push(t)
    );
    await Promise.resolve();

    // A second op arrives and must queue. Time passes while it is BLOCKED.
    const second = lane.runBounded(
      () => {
        clock.tick(5); // its own execution
        return Promise.resolve();
      },
      (t) => seen.push(t)
    );
    await Promise.resolve();
    clock.tick(9000); // 9s spent purely waiting for the permit

    releaseFirst();
    await Promise.all([first, second]);

    const queuedTrip = seen.find((t) => t.queued);
    assert.ok(queuedTrip, "the second op should have queued");
    // The whole point: 9s of waiting is NOT execution.
    assert.equal(queuedTrip.queueMs, 9000);
    assert.equal(queuedTrip.execMs, 5);
    // And it saw the lane already full when it arrived.
    assert.equal(queuedTrip.activeOnArrival, 1);
  });

  it("records a fast-path acquire as unqueued with no wait", async () => {
    const clock = fakeClock();
    const seen: BoundedLaneTiming[] = [];
    const lane = createBoundedOpLane({ limit: 2, now: clock.now });

    await lane.runBounded(
      () => {
        clock.tick(120);
        return Promise.resolve();
      },
      (t) => seen.push(t)
    );

    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.queued, false);
    assert.equal(seen[0]?.queueMs, 0);
    assert.equal(seen[0]?.reAdmitMs, 0);
    assert.equal(seen[0]?.execMs, 120);
    assert.equal(seen[0]?.activeOnArrival, 0);
  });

  it("attributes a pre-admission memory-pressure park to admitMs, not execMs", async () => {
    const clock = fakeClock();
    const seen: BoundedLaneTiming[] = [];
    const lane = createBoundedOpLane({
      limit: 2,
      now: clock.now,
      admit: () => {
        clock.tick(5000); // the FEA-3150 bounded park
        return Promise.resolve();
      },
    });

    await lane.runBounded(
      () => {
        clock.tick(30);
        return Promise.resolve();
      },
      (t) => seen.push(t)
    );

    // A pressure park is a distinct cause from a permit wait, so it must not be
    // folded into either the queue wait or the execution.
    assert.equal(seen[0]?.admitMs, 5000);
    assert.equal(seen[0]?.queueMs, 0);
    assert.equal(seen[0]?.execMs, 30);
  });

  it("tags each timing with the op name and reports nothing for UNGATED ops", async () => {
    const seen: string[] = [];
    const lanes = createDbHostOpLanes({
      onBoundedTiming: (op) => seen.push(op),
    });

    await lanes.runInvokeOp("syncSource.aggregateUsage", () =>
      Promise.resolve(1)
    );
    // `countSessions` is deliberately ungated, so it never enters the lane and
    // must not manufacture a lane row.
    await lanes.runInvokeOp("syncSource.countSessions", () =>
      Promise.resolve(2)
    );

    assert.deepEqual(seen, ["syncSource.aggregateUsage"]);
  });

  it("is fail-open: a throwing observer cannot change the op's result", async () => {
    const lane = createBoundedOpLane({ limit: 1 });
    const value = await lane.runBounded(
      () => Promise.resolve("payload"),
      () => {
        throw new Error("observer boom");
      }
    );
    assert.equal(value, "payload");
  });

  /**
   * A clock that succeeds for the reads taken BEFORE the task and throws from
   * the read taken after it. The unqueued, no-`admit` path reads three stamps
   * before dispatch (arrival, admitted, acquired) and one from the `finally`,
   * so `> 3` isolates the post-task read exactly.
   */
  function clockThatThrowsAfterTask(): () => number {
    let reads = 0;
    return () => {
      reads += 1;
      if (reads > 3) {
        throw new Error("clock boom");
      }
      return reads;
    };
  }

  it("is fail-open when the clock throws BEFORE the task: the op still runs", async () => {
    const seen: BoundedLaneTiming[] = [];
    let ran = false;
    const lane = createBoundedOpLane({
      limit: 1,
      now: () => {
        throw new Error("clock boom");
      },
    });

    // Counterfactual (unguarded): the pre-dispatch stamp read throws, so
    // `runBounded` rejects and the database task never executes at all.
    const value = await lane.runBounded(
      () => {
        ran = true;
        return Promise.resolve("payload");
      },
      (t) => seen.push(t)
    );

    assert.equal(ran, true);
    assert.equal(value, "payload");
    // And nothing is reported: a row with no usable stamps is absent, not zero.
    assert.deepEqual(seen, []);
  });

  it("is fail-open when the clock throws in the FINALLY: the op's result survives", async () => {
    const seen: BoundedLaneTiming[] = [];
    const lane = createBoundedOpLane({
      limit: 1,
      now: clockThatThrowsAfterTask(),
    });

    // Counterfactual (unguarded): the `execMs` read throws from inside the
    // `finally`, REPLACING the resolved value with an instrumentation error.
    const value = await lane.runBounded(
      () => Promise.resolve("payload"),
      (t) => seen.push(t)
    );

    assert.equal(value, "payload");
    assert.deepEqual(seen, []);
  });

  it("is fail-open when the clock throws in the FINALLY: the op's own error survives", async () => {
    const lane = createBoundedOpLane({
      limit: 1,
      now: clockThatThrowsAfterTask(),
    });

    // Counterfactual (unguarded): the caller sees "clock boom" instead of the
    // real failure, and the op's actual error is lost. Asserted on the EXACT
    // message rather than `BOOM` — `/boom/` also matches "clock boom", so the
    // loose matcher would stay green against the very substitution under test.
    await assert.rejects(
      () =>
        lane.runBounded(
          () => Promise.reject(new Error("boom")),
          () => undefined
        ),
      (error: unknown) => {
        assert.equal((error as Error).message, "boom");
        return true;
      }
    );
  });

  it("drops a lane row rather than reporting a non-finite duration", async () => {
    const seen: BoundedLaneTiming[] = [];
    const lane = createBoundedOpLane({ limit: 1, now: () => Number.NaN });

    const value = await lane.runBounded(
      () => Promise.resolve("payload"),
      (t) => seen.push(t)
    );

    // Counterfactual (unguarded): the analyzer receives a row whose every
    // duration is NaN and computes percentiles over it.
    assert.equal(value, "payload");
    assert.deepEqual(seen, []);
  });

  it("still reports a timing when the op REJECTS, so a failure is not invisible", async () => {
    const seen: BoundedLaneTiming[] = [];
    const lane = createBoundedOpLane({ limit: 1 });
    await assert.rejects(
      () =>
        lane.runBounded(
          () => Promise.reject(new Error("boom")),
          (t) => seen.push(t)
        ),
      BOOM
    );
    assert.equal(seen.length, 1);
  });
});
