import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSqliteDashboardQueries } from "../src/main/database/dashboard-queries.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { deferred } from "./deferred.js";

/**
 * ISS-6501: `getWorkflowData`'s seven raw aggregates must be issued as ONE
 * concurrent batch.
 *
 * None of them consumes another's result, so a serial `await` chain left the
 * 2-connection reader pool with exactly one statement in flight no matter how
 * the dispatches round-robined across it. The ROWS are identical either way —
 * only the overlap changes — so the assertion is on peak in-flight dispatches,
 * never on elapsed time.
 */

/**
 * The width of the batch under test: `depthRow`, `durationRow`,
 * `subagentTypes`, `edges`, `toolTransitions`, `toolCounts`, `cooccurrence`.
 * Collapsing two of them into one query is a real change and should be a
 * visible one here.
 */
const WORKFLOW_RAW_AGGREGATES = 7;
/**
 * The 1-based dispatch that fails in the drain test. FIRST in the batch, so a
 * `Promise.all` that unwound on it would settle the whole op with all SIX
 * siblings still on the pool — the widest form of the leak under test.
 */
const FAILING_READ_DISPATCH = 1;
const FAILING_READ_MESSAGE = "workflow raw aggregate failed";
/**
 * Microtask turns drained before asserting the op has NOT settled. `Promise.all`
 * unwinds purely on the microtask queue, so draining it is a complete proof —
 * no clock, no sleep, nothing timing-sensitive to assert on.
 */
const MICROTASK_DRAIN_TURNS = 20;
/**
 * Explicit bound for the drain test, which blocks on a deferred rather than the
 * runner default: if the batch ever narrows below {@link WORKFLOW_RAW_AGGREGATES}
 * its dispatch barrier never opens, and that must fail loudly rather than hang.
 */
const DRAIN_TEST_TIMEOUT_MS = 30_000;
/**
 * The two 1-based dispatches that fail in the array-order test, chosen so time
 * order and array order DISAGREE: the later array position rejects immediately
 * while the earlier one rejects only once the batch is released. A rethrow that
 * surfaced whichever error arrived first would name
 * {@link LATE_ARRAY_FAILURE_MESSAGE}; the contract is that it names
 * {@link EARLY_ARRAY_FAILURE_MESSAGE}.
 */
const EARLY_ARRAY_FAILING_DISPATCH = 2;
const LATE_ARRAY_FAILING_DISPATCH = 5;
const EARLY_ARRAY_FAILURE_MESSAGE = "earlier aggregate in array order failed";
const LATE_ARRAY_FAILURE_MESSAGE = "later aggregate failed sooner in time";
const NOW = "2026-06-22T00:00:00.000Z";
const STARTED_AT = "2026-06-20T10:00:00.000Z";
/** +60s and +120s from {@link STARTED_AT}, so the duration AVG is 90. */
const S1_UPDATED_AT = "2026-06-20T10:01:00.000Z";
const S2_UPDATED_AT = "2026-06-20T10:02:00.000Z";

/**
 * Count `prisma.read` dispatches that are in flight simultaneously.
 *
 * Yields several microtasks inside the tracked window (the `lib/db-fanout.test`
 * shape) so overlapping dispatches are observed in flight together before any
 * of them settles — a batch that happened to settle synchronously would
 * otherwise read as serial.
 */
function trackPeakReads(prisma: DesktopPrisma) {
  const state = { inFlight: 0, peak: 0, dispatches: 0 };
  const tracked: DesktopPrisma = {
    ...prisma,
    read: async (fn) => {
      state.inFlight += 1;
      state.dispatches += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      try {
        return await prisma.read(fn);
      } finally {
        state.inFlight -= 1;
      }
    },
  };
  return { tracked, state };
}

/**
 * Fail one `prisma.read` dispatch and hold every sibling read open until
 * released, so the rejection path can be observed while the batch is still busy.
 *
 * `completed` counts the siblings that reached their real read, which is what
 * makes the post-rejection assertion about DRAINING rather than about the error
 * merely propagating.
 */
function holdSiblingReads(prisma: DesktopPrisma) {
  const release = deferred();
  const batchDispatched = deferred();
  const state = { dispatches: 0, completed: 0, settled: false };
  const tracked: DesktopPrisma = {
    ...prisma,
    read: async (fn) => {
      state.dispatches += 1;
      if (state.dispatches >= WORKFLOW_RAW_AGGREGATES) {
        batchDispatched.resolve();
      }
      if (state.dispatches === FAILING_READ_DISPATCH) {
        throw new Error(FAILING_READ_MESSAGE);
      }
      await release.promise;
      const rows = await prisma.read(fn);
      state.completed += 1;
      return rows;
    },
  };
  return { tracked, state, release, batchDispatched };
}

/**
 * Fail TWO `prisma.read` dispatches with time order and array order deliberately
 * inverted, so the rethrown error identifies WHICH rule the batch follows.
 *
 * Separate from {@link holdSiblingReads} because that helper's single failure is
 * first in both orders and so cannot tell them apart.
 */
function holdWithInvertedFailureOrder(prisma: DesktopPrisma) {
  const release = deferred();
  const batchDispatched = deferred();
  const state = { dispatches: 0 };
  const tracked: DesktopPrisma = {
    ...prisma,
    read: async (fn) => {
      state.dispatches += 1;
      const dispatch = state.dispatches;
      if (dispatch >= WORKFLOW_RAW_AGGREGATES) {
        batchDispatched.resolve();
      }
      if (dispatch === LATE_ARRAY_FAILING_DISPATCH) {
        throw new Error(LATE_ARRAY_FAILURE_MESSAGE);
      }
      await release.promise;
      if (dispatch === EARLY_ARRAY_FAILING_DISPATCH) {
        throw new Error(EARLY_ARRAY_FAILURE_MESSAGE);
      }
      return await prisma.read(fn);
    },
  };
  return { tracked, release, batchDispatched };
}

test("ISS-6501: getWorkflowData issues its independent raw aggregates concurrently", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dashboard-workflow-conc-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  try {
    for (const [id, updatedAt] of [
      ["s1", S1_UPDATED_AT],
      ["s2", S2_UPDATED_AT],
    ]) {
      await db.run(
        `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
         VALUES ($1, $1, $2, $3, $4, $5)`,
        id,
        "inactive",
        STARTED_AT,
        updatedAt,
        "claude"
      );
    }
    // s1: main → worker → auditor (max depth 2). s2: main → worker (depth 1).
    for (const [id, sessionId, parentId, type, subagentType] of [
      ["a1", "s1", null, "main", null],
      ["a2", "s1", "a1", "subagent", "worker"],
      ["a3", "s1", "a2", "subagent", "auditor"],
      ["a4", "s2", null, "main", null],
      ["a5", "s2", "a4", "subagent", "worker"],
    ]) {
      await db.run(
        `INSERT INTO agents (id, session_id, status, parent_agent_id, type, subagent_type)
         VALUES ($1, $2, 'completed', $3, $4, $5)`,
        id,
        sessionId,
        parentId,
        type,
        subagentType
      );
    }

    const { tracked, state } = trackPeakReads(db.prisma);
    const dashboard = createSqliteDashboardQueries(tracked);
    const workflow = await dashboard.getWorkflowData(new Date(NOW));

    // A serial `await` chain peaks at 1 here regardless of how many reads it
    // makes. Asserted as a FLOOR on the batch width rather than as
    // `peak === dispatches`, so adding a genuinely dependent pool read later
    // (one that must await the batch) does not read as a regression.
    assert.ok(
      state.dispatches >= WORKFLOW_RAW_AGGREGATES,
      `the probe needs the whole batch to have any power; saw ${state.dispatches} raw reads`
    );
    assert.ok(
      state.peak >= WORKFLOW_RAW_AGGREGATES,
      `the independent raw aggregates must be in flight together; peaked at ${state.peak} of ${state.dispatches}`
    );

    // The batch must also land in its declared order. `depthRow`/`durationRow`
    // and `edges`/`cooccurrence` are pairwise type-identical, so a transposed
    // destructure would typecheck and silently swap two facets.
    assert.equal(workflow.stats.avgDepth, 1.5);
    assert.equal(workflow.stats.avgDurationSec, 90);
    // An edge's source is a PARENT agent's type, so 'auditor' — a leaf here —
    // can never appear as one; the co-occurrence pairs do carry it.
    assert.deepEqual(workflow.orchestration.edges, [
      { source: "main", target: "worker", weight: 2 },
      { source: "worker", target: "auditor", weight: 1 },
    ]);
    assert.ok(
      workflow.cooccurrence.some((pair) => pair.source === "auditor"),
      "co-occurrence pairs are sorted by agent type, so 'auditor' leads two of them"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * ISS-6501 (wongk review): the batch must DRAIN before it unwinds.
 *
 * `dashboard.getWorkflowData` holds a `BOUNDED_READ_OPS` permit for the life of
 * the op, so a bare `Promise.all` — which rejects the instant one read fails —
 * returned the permit while the other six reads were still queued on the reader
 * pool. Retries could then stack detached work past the lane's ceiling of 2.
 */
test("ISS-6501: a failed raw aggregate drains its sibling reads before unwinding", {
  timeout: DRAIN_TEST_TIMEOUT_MS,
}, async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "dashboard-workflow-drain-")
  );
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  try {
    const { tracked, state, release, batchDispatched } = holdSiblingReads(
      db.prisma
    );
    const dashboard = createSqliteDashboardQueries(tracked);

    const call = dashboard.getWorkflowData(new Date(NOW));
    // Attached in the same turn the call is made, so the rejection is always
    // handled and the flag records settlement rather than the assertion timing
    // deciding it.
    const observed = call.then(
      () => {
        state.settled = true;
      },
      () => {
        state.settled = true;
      }
    );

    await batchDispatched.promise;
    for (let turn = 0; turn < MICROTASK_DRAIN_TURNS; turn += 1) {
      await Promise.resolve();
    }
    assert.equal(
      state.settled,
      false,
      "the op must stay pending — and so keep its lane permit — while sibling reads are still on the pool"
    );

    release.resolve();
    await assert.rejects(call, { message: FAILING_READ_MESSAGE });
    await observed;
    assert.equal(
      state.completed,
      WORKFLOW_RAW_AGGREGATES - 1,
      "every sibling read must have settled before the op rejected"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * ISS-6501 (wongk review): "then rethrow the first error" — first in ARRAY
 * order, which is the rule the drained batch actually follows and the one its
 * call-site comment claims.
 *
 * The drain test above cannot pin this: its single failure is first in both
 * orders, so it stays green under either rule. Here the orders disagree, and a
 * batch that surfaced whichever rejection landed soonest would report the wrong
 * aggregate — sending a reader at the fifth query when the second is what broke.
 */
test("ISS-6501: the drained batch rethrows the first failure in array order", {
  timeout: DRAIN_TEST_TIMEOUT_MS,
}, async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "dashboard-workflow-order-")
  );
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  try {
    const { tracked, release, batchDispatched } = holdWithInvertedFailureOrder(
      db.prisma
    );
    const dashboard = createSqliteDashboardQueries(tracked);

    const call = dashboard.getWorkflowData(new Date(NOW));
    // Attached in the same turn as the call so the rejection is always handled,
    // never left to race the awaits below.
    const observed = call.then(
      () => undefined,
      () => undefined
    );

    await batchDispatched.promise;
    release.resolve();
    await assert.rejects(call, {
      message: EARLY_ARRAY_FAILURE_MESSAGE,
    });
    await observed;
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
