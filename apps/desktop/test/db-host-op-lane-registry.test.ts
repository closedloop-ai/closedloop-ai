import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BOUNDED_READ_OPS,
  DB_HOST_EXCLUSIVE_OP,
  DB_HOST_OP_LANE_REGISTRY,
  DbHostAdmissionLane,
  EXCLUSIVE_OPS,
} from "../src/main/database/db-host/db-host-op-lane-registry.js";
import {
  BOUNDED_READ_OP_LIMIT,
  BRANCHES_PAGE_MAX_CONCURRENT_BOUNDED_OPS,
  createDbHostOpLanes,
} from "../src/main/database/db-host/db-host-op-lanes.js";

/**
 * ISS-5957 — the RUNTIME half of the db-host admission-lane REGISTRY.
 *
 * Split from `db-host-op-lanes.test.ts`, which owns the lane MECHANISM (FIFO,
 * permit release, admission parking, timing attribution). This file owns the
 * DECLARATION: which op takes which lane, that the bounded set is derived from
 * those declarations rather than restated beside them, and that the ops ISS-5957
 * newly admits actually share the one ceiling.
 *
 * The COMPILE-TIME half — the guard that makes a lane declaration mandatory, and
 * the `@ts-expect-error` counterfactuals proving it rejects an undeclared heavy
 * op — is `type-tests/db-host-op-lane-coverage.ts`, compiled by
 * `typecheck:type-tests`. A runtime test cannot observe `tsc`, so neither file
 * is the whole guard.
 *
 * As in the sibling file, every concurrency assertion here EXECUTES the
 * production routing decision and asserts no wall-clock timing (gated by
 * `no-timing-assertions`).
 */

const FANOUT = 15;

/** Bytes a single in-flight read is modelled as holding live. */
const PER_TASK_RETAINED_BYTES = 1024 * 1024;

/**
 * A task that records how many lane tasks are in flight while it runs, and the
 * peak bytes RETAINED across them. A model, not a `process.memoryUsage()` sample
 * — peak retention is `maxActive x PER_TASK_RETAINED_BYTES` by construction,
 * which is the multiplier the lane exists to bound. Real before/after heap
 * numbers live in the PR.
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
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      tracker.active -= 1;
    },
  };
  return tracker;
}

describe("db-host op lane registry", () => {
  it("shares ONE ceiling across the ISS-5957 additions and the Sessions reads", async () => {
    // ISS-5957, driven with LITERAL op names rather than the set, so it fails on
    // pre-fix code instead of tautologically following whatever the set holds.
    // Each of these three ran with NO permit before this change:
    // `aggregateAnalytics` (ISS-5941's own top-ranked residual) and the two
    // named Branch read facades. Interleaved with a Sessions read on ONE
    // `createDbHostOpLanes()`, because the property that bounds memory is that
    // their peaks cannot SUM — one semaphore per op name would admit
    // 4 × limit concurrent corpus reads and still look bounded per op.
    const lanes = createDbHostOpLanes();
    const tracker = makeTracker();
    const ops = [
      "syncSource.aggregateAnalytics",
      "readBranchCanonicalActivityRows",
      "readBranchMetricEventEvidence",
      "syncSource.aggregateUsage",
    ];

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
    // The bound that matters: peak retention is the ceiling's worth across ALL
    // four ops, not one ceiling's worth each and not the whole fan-out's.
    assert.equal(
      tracker.peakRetainedBytes,
      BOUNDED_READ_OP_LIMIT * PER_TASK_RETAINED_BYTES
    );
    assert.ok(
      tracker.peakRetainedBytes < FANOUT * ops.length * PER_TASK_RETAINED_BYTES,
      "ungated, all four fan-outs would retain their result sets at once"
    );
    assert.equal(tracker.active, 0);
  });

  it("admits a Branches-shaped request at its derived width without queueing it", async () => {
    // ISS-5957. `BRANCHES_PAGE_MAX_CONCURRENT_BOUNDED_OPS` is a DERIVED FACT
    // about the call sites, established by reading them — every Branches entry
    // point (`getSharedBranchesPageData`, the standalone list, the detail read,
    // the analytics and cohort readers) awaits `readBranchCanonicalActivityRows`
    // after the `Promise.all` carrying `readBranchMetricEventEvidence`, so one
    // request never wants a second permit.
    //
    // Be precise about what this test can and cannot do. It CANNOT observe that
    // call-site structure, so it would NOT catch someone restructuring those
    // reads into a single `Promise.all` — that stays a review-owned invariant,
    // and the constant is the thing a reviewer re-derives. What it DOES execute
    // is the consequence the constant is kept for: a request of that derived
    // width, driven through the real lane at the real ceiling, runs without ever
    // waiting. If the ceiling were ever dropped below the Branches width, this
    // fails.
    const lanes = createDbHostOpLanes();
    const tracker = makeTracker();
    const branchOps = [
      "readBranchCanonicalActivityRows",
      "readBranchMetricEventEvidence",
    ];

    // One Branches request's worth of concurrent bounded work, at its derived
    // peak — issued together so a ceiling narrower than that width would show up
    // as a lower observed concurrency.
    await Promise.all(
      Array.from(
        { length: BRANCHES_PAGE_MAX_CONCURRENT_BOUNDED_OPS },
        (_u, i) =>
          lanes.runInvokeOp(
            branchOps[i % branchOps.length] as string,
            tracker.task
          )
      )
    );

    assert.equal(
      tracker.maxActive,
      BRANCHES_PAGE_MAX_CONCURRENT_BOUNDED_OPS,
      "a lone Branches request must run at its full derived width, unqueued"
    );
    assert.ok(
      BRANCHES_PAGE_MAX_CONCURRENT_BOUNDED_OPS <= BOUNDED_READ_OP_LIMIT,
      "the ceiling must leave room for one whole Branches request"
    );
    assert.equal(tracker.active, 0);
  });

  it("declares a lane for every named op, and derives the set from those declarations", () => {
    // ISS-5957 — the RUNTIME half of the guard (its compile-time half is
    // `type-tests/db-host-op-lane-coverage.ts`). This drives the real derivation:
    // every op the registry declares `BoundedRead` must appear in
    // BOUNDED_READ_OPS under its namespace prefix, and nothing else may.
    // A second hand-written list — the thing ISS-5941 and ISS-6027 both drifted
    // against — could not satisfy this without being identical to the first.
    const derived = DB_HOST_OP_LANE_REGISTRY.flatMap(([prefix, lanes]) =>
      Object.entries(lanes)
        .filter(([, lane]) => lane === DbHostAdmissionLane.BoundedRead)
        .map(([name]) => (prefix === "" ? name : `${prefix}.${name}`))
    );

    assert.deepEqual([...BOUNDED_READ_OPS].sort(), derived.sort());
    // Not vacuous: a registry that declared nothing bounded would pass the
    // equality above against an empty set.
    assert.ok(derived.length > 0);
    // Every declared lane is a real member of the enum, so a typo'd literal
    // cannot silently read as "ungated".
    const lanesDeclared = DB_HOST_OP_LANE_REGISTRY.flatMap(([, lanes]) =>
      Object.values(lanes)
    );
    assert.ok(
      lanesDeclared.every((lane) =>
        Object.values(DbHostAdmissionLane).includes(lane)
      )
    );
  });

  it("declares the insights op EXCLUSIVE rather than leaving it unclassified", () => {
    // The registry has to say something about `getInsights` — that is the point
    // of an exhaustive map. It must say `Exclusive` (dispatch routes it to the
    // width-1 gate ahead of `runInvokeOp`) and it must NOT reach the bounded set,
    // where membership would be dead code reading like a second, contradictory
    // admission decision.
    const dashboard = DB_HOST_OP_LANE_REGISTRY.find(
      ([prefix]) => prefix === "dashboard"
    )?.[1];
    const insightsName = DB_HOST_EXCLUSIVE_OP.split(".")[1] as string;

    assert.equal(dashboard?.[insightsName], DbHostAdmissionLane.Exclusive);
    assert.ok(!BOUNDED_READ_OPS.has(DB_HOST_EXCLUSIVE_OP));
  });

  it("derives the EXCLUSIVE set from the declarations, same as the bounded one", () => {
    // ISS-5957 review (T2). `EXCLUSIVE_OPS` is what `dispatchDbHostInvoke`
    // matches, so it has to be the registry's own declaration rather than a
    // second list beside it — the same property the bounded set is held to
    // above. Driven through the real registry, so a hand-written set could not
    // satisfy it without being identical to the declarations.
    const derived = DB_HOST_OP_LANE_REGISTRY.flatMap(([prefix, lanes]) =>
      Object.entries(lanes)
        .filter(([, lane]) => lane === DbHostAdmissionLane.Exclusive)
        .map(([name]) => (prefix === "" ? name : `${prefix}.${name}`))
    );

    assert.deepEqual([...EXCLUSIVE_OPS].sort(), derived.sort());
    // The exported single path and the derived set are the same fact. The type
    // (`DashboardOpLaneMap`) is what makes the size-1 claim hold; this pins the
    // runtime consequence the dispatcher's insights-cache branch relies on.
    assert.deepEqual([...EXCLUSIVE_OPS], [DB_HOST_EXCLUSIVE_OP]);
    // The two lanes must not overlap: an op in both would be routed by whichever
    // branch the dispatcher happened to check first.
    assert.ok([...EXCLUSIVE_OPS].every((op) => !BOUNDED_READ_OPS.has(op)));
  });
});
