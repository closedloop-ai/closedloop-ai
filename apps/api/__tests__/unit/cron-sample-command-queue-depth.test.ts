/**
 * ISS-8453 AC-004 — GET /api/cron/sample-command-queue-depth.
 *
 * The gauge this route publishes already existed; what did not exist was any
 * emitter that runs without a live relay socket, so a target holding a backlog
 * with no connected desktop published no queue depth at all.
 *
 * What these cases pin, precisely: the route's inputs are two table reads and
 * nothing else, every sampled target gets a value including a zero, the warn
 * fires at the threshold and is bounded per tick, the per-tick gauge budget is
 * bounded and spends itself on backlogs before zeros, and a failed read is loud
 * rather than silent. They drive the route, so the pure emission logic in
 * `queue-depth-publisher.ts` is covered through its production caller rather
 * than in isolation. The query predicates themselves are pinned next to the
 * queries, in desktop-command-dispatch-queries.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must precede all imports
// ---------------------------------------------------------------------------

const {
  mockCountQueued,
  mockSweepPage,
  mockMarkSwept,
  mockAwaitingSweep,
  mockReconcile,
  mockEmitQueueMetric,
} = vi.hoisted(() => ({
  mockCountQueued: vi.fn(),
  mockSweepPage: vi.fn(),
  mockMarkSwept: vi.fn(),
  mockAwaitingSweep: vi.fn(),
  mockReconcile: vi.fn(),
  mockEmitQueueMetric: vi.fn(),
}));

import { createLogMockModule } from "../fixtures/mock-modules";

vi.mock("@repo/observability/log", () => createLogMockModule());

vi.mock("@/lib/desktop-command-dispatch-queries", () => ({
  countQueuedCommandsByTarget: mockCountQueued,
  reconcileQueuedCounters: mockReconcile,
  countTargetsAwaitingSweep: mockAwaitingSweep,
  listQueueDepthSweepPage: mockSweepPage,
  markQueueDepthSwept: mockMarkSwept,
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitQueueMetric: mockEmitQueueMetric,
}));

vi.mock("@/lib/route-utils", () => ({
  scheduleLogFlush: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { log } from "@repo/observability/log";
import { FilterToken } from "@repo/observability/telemetry/filter-tokens";
import { ORIGIN } from "@repo/observability/telemetry/origin";
import {
  COMMAND_BACKLOG_WARN_THRESHOLD,
  MAX_RECONCILED_TARGETS_PER_TICK,
  MAX_SAMPLED_TARGETS,
  MIN_ROTATION_SLOTS_PER_TICK,
} from "@/app/cron/sample-command-queue-depth/queue-depth-publisher";
import { GET } from "@/app/cron/sample-command-queue-depth/route";

const CRON_SECRET = "test-secret";

function makeRequest(token: string = CRON_SECRET): Request {
  return new Request("http://localhost/api/cron/sample-command-queue-depth", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
}

function backlog(computeTargetId: string, queuedCount: number) {
  return { computeTargetId, queuedCount };
}

type Depth = { computeTargetId: string; queuedCount: number };

/**
 * Drives the route with a backlog page and a sweep page. `sweep` carries each
 * target's real depth now, so a caller states what the counter says rather than
 * relying on the route to invent a zero.
 */
async function callWith(
  sweep: Depth[],
  backlogs: Depth[],
  backlogHasMore = false,
  awaitingSweep = 0
): Promise<Response> {
  mockSweepPage.mockResolvedValue(sweep);
  mockCountQueued.mockResolvedValue({ backlogs, hasMore: backlogHasMore });
  mockAwaitingSweep.mockResolvedValue(awaitingSweep);
  mockReconcile.mockResolvedValue(
    sweep.map((target) => ({
      computeTargetId: target.computeTargetId,
      counter: target.queuedCount,
      actualQueuedRows: target.queuedCount,
    }))
  );
  mockMarkSwept.mockResolvedValue(sweep.length);
  return await GET(makeRequest());
}

function emittedFor(targetId: string) {
  return mockEmitQueueMetric.mock.calls
    .map((call) => call[0])
    .find((payload) => payload.computeTargetId === targetId);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = CRON_SECRET;
});

afterEach(() => {
  Reflect.deleteProperty(process.env, "CRON_SECRET");
});

describe("GET /api/cron/sample-command-queue-depth — auth", () => {
  it("returns 401 for a wrong token and reads no table", async () => {
    const response = await GET(makeRequest("wrong-secret"));

    expect(response.status).toBe(401);
    expect(mockSweepPage).not.toHaveBeenCalled();
    expect(mockCountQueued).not.toHaveBeenCalled();
    expect(mockMarkSwept).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/sample-command-queue-depth — sampling", () => {
  // The full emit shape, not just the value: `filterToken` is the attribute a
  // pipeline rule matches on, so dropping it would publish points no rule can
  // find while every value assertion stayed green.
  it("emits the full gauge payload per target", async () => {
    await callWith([backlog("target-a", 43)], [backlog("target-a", 43)]);

    expect(mockEmitQueueMetric).toHaveBeenCalledWith({
      metric: "queued_command_count",
      value: 43,
      computeTargetId: "target-a",
      origin: ORIGIN,
      filterToken: FilterToken.CommandQueued,
    });
  });

  // The hello path publishes an explicit 0, so a second producer that emitted
  // only non-zero depths would leave a drained backlog reporting its stale peak
  // forever under a `last` rollup. Since ISS-8674 that zero is MEASURED — it is
  // the target's counter, carried by the sweep read — not a value the route
  // fills in for a target the backlog page did not name.
  it("emits a measured zero for a swept target with no backlog", async () => {
    await callWith(
      [backlog("target-a", 5), backlog("target-b", 0)],
      [backlog("target-a", 5)]
    );

    expect(emittedFor("target-b")).toMatchObject({
      metric: "queued_command_count",
      value: 0,
    });
    expect(mockEmitQueueMetric).toHaveBeenCalledTimes(2);
  });

  // The false-zero regression, made falsifiable. Every OTHER sweep-only target
  // in this file carries depth 0, so a mutation that discarded the sweep's
  // measured value and filled in a zero — the exact pre-ISS-8674 bug — would
  // leave them all green. This one is sweep-only AND non-zero, so it is the
  // case that goes red.
  it("emits a sweep-only target's real depth, never a filled-in zero", async () => {
    await callWith([backlog("swept-only", 9)], []);

    expect(emittedFor("swept-only")).toMatchObject({
      metric: "queued_command_count",
      value: 9,
    });
  });

  it("returns 200 and emits nothing when the fleet is empty", async () => {
    const response = await callWith([], []);

    expect(response.status).toBe(200);
    expect(mockEmitQueueMetric).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/sample-command-queue-depth — backlog warn", () => {
  it("warns for a target at the threshold", async () => {
    await callWith(
      [backlog("target-a", COMMAND_BACKLOG_WARN_THRESHOLD)],
      [backlog("target-a", COMMAND_BACKLOG_WARN_THRESHOLD)]
    );

    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      "command.queue.backlog_exceeded",
      expect.objectContaining({
        computeTargetId: "target-a",
        queuedCommandCount: COMMAND_BACKLOG_WARN_THRESHOLD,
      })
    );
  });

  it("stays silent one command below the threshold", async () => {
    await callWith(
      [backlog("target-a", COMMAND_BACKLOG_WARN_THRESHOLD)],
      [backlog("target-a", COMMAND_BACKLOG_WARN_THRESHOLD - 1)]
    );

    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
    // Still gauged: below the warn line is data, not absence.
    expect(mockEmitQueueMetric).toHaveBeenCalledTimes(1);
  });

  // A fleet-wide stall puts every target over the threshold at once. The warn
  // channel must not become the outage, and the suppressed remainder must be
  // counted rather than dropped silently.
  it("caps warns per tick, naming the deepest and counting the rest", async () => {
    const deep = Array.from({ length: 14 }, (_, index) =>
      backlog(`target-${index}`, 100 + index)
    );

    await callWith(deep, deep);

    expect(vi.mocked(log.warn)).toHaveBeenCalledTimes(10);
    // Deepest first, so the ten that survive the cap are the actionable ones.
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      "command.queue.backlog_exceeded",
      expect.objectContaining({ computeTargetId: "target-13" })
    );
    expect(vi.mocked(log.warn)).not.toHaveBeenCalledWith(
      "command.queue.backlog_exceeded",
      expect.objectContaining({ computeTargetId: "target-0" })
    );
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining("sampling complete"),
      expect.objectContaining({ exceededCount: 14, warnsSuppressed: 4 })
    );
  });

  // 20 is a deliberate, independent literal. Deriving the boundary from the
  // exported constant would keep this green at any value, including one raised
  // past the depth the incident reached.
  it("holds the shipped threshold at 20", () => {
    expect(COMMAND_BACKLOG_WARN_THRESHOLD).toBe(20);
  });
});

describe("GET /api/cron/sample-command-queue-depth — later-call failure", () => {
  // Only the first read's rejection was covered. The route's claim is that it
  // never goes dark silently, and that has to hold for the WRITE and the reads
  // after it too — a refactor lifting one of them out of the try block would
  // turn a failed tick into an unhandled rejection with no error line.
  it("returns 500 and logs when the stamp write rejects", async () => {
    mockSweepPage.mockResolvedValue([backlog("target-a", 0)]);
    mockCountQueued.mockResolvedValue({ backlogs: [], hasMore: false });
    mockMarkSwept.mockRejectedValue(new Error("deadlock detected"));

    const response = await GET(makeRequest());

    expect(response.status).toBe(500);
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.stringContaining("sampling failed"),
      expect.objectContaining({ error: expect.any(Error) })
    );
  });
});

describe("GET /api/cron/sample-command-queue-depth — counter drift", () => {
  // The counter is written by a trigger in the same transaction as every
  // command write, so it cannot drift while that holds. This is the alarm for
  // it having stopped holding — a disabled trigger, a bad migration, a restore
  // taken with --disable-triggers. An over-count renders as a phantom backlog
  // that never clears, which is a MORE authoritative lie than the visible cap
  // Option A was chosen over.
  it("warns per drifted target, naming both numbers", async () => {
    mockSweepPage.mockResolvedValue([backlog("target-a", 7)]);
    mockCountQueued.mockResolvedValue({ backlogs: [], hasMore: false });
    mockAwaitingSweep.mockResolvedValue(0);
    mockMarkSwept.mockResolvedValue(1);
    mockReconcile.mockResolvedValue([
      { computeTargetId: "target-a", counter: 7, actualQueuedRows: 3 },
    ]);

    await GET(makeRequest());

    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      "command.queue.counter_drift",
      expect.objectContaining({
        computeTargetId: "target-a",
        queuedCommandCount: 7,
        actualQueuedRows: 3,
        delta: 4,
      })
    );
  });

  // The other direction, and the reason the check is an exact count rather than
  // a cheaper "does any queued row exist" probe: a counter of 0 against real
  // rows is a backlog the gauge is hiding entirely.
  it("warns when the counter under-reports real rows", async () => {
    await callWith([backlog("target-a", 0)], []);
    vi.clearAllMocks();

    mockSweepPage.mockResolvedValue([backlog("target-a", 0)]);
    mockCountQueued.mockResolvedValue({ backlogs: [], hasMore: false });
    mockAwaitingSweep.mockResolvedValue(0);
    mockMarkSwept.mockResolvedValue(1);
    mockReconcile.mockResolvedValue([
      { computeTargetId: "target-a", counter: 0, actualQueuedRows: 5 },
    ]);

    await GET(makeRequest());

    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      "command.queue.counter_drift",
      expect.objectContaining({ queuedCommandCount: 0, actualQueuedRows: 5 })
    );
  });

  // Silence on a healthy fleet. A detector that warned on every tick would be
  // ignored within a day, which is the same as having none.
  it("says nothing when every counter reconciles", async () => {
    await callWith(
      [backlog("target-a", 4), backlog("target-b", 0)],
      [backlog("target-a", 4)]
    );

    expect(vi.mocked(log.warn)).not.toHaveBeenCalledWith(
      "command.queue.counter_drift",
      expect.anything()
    );
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining("sampling complete"),
      expect.objectContaining({ driftedTargetCount: 0, targetsReconciled: 2 })
    );
  });

  // The bound. Reconciliation counts real queued rows, so an unbounded sample
  // is the fleet-wide aggregate this ticket removed, running on a slower
  // cadence — the cap is what keeps it a spot check.
  it("reconciles no more than the per-tick reconciliation budget", async () => {
    const rotation = Array.from(
      { length: MAX_RECONCILED_TARGETS_PER_TICK + 40 },
      (_, index) => backlog(`target-${index}`, 0)
    );

    await callWith(rotation, []);

    expect(mockReconcile).toHaveBeenCalledWith(
      rotation
        .slice(0, MAX_RECONCILED_TARGETS_PER_TICK)
        .map((target) => target.computeTargetId)
    );
  });

  // Taken from the sweep page's HEAD, which is its least-recently-swept end, so
  // the sample advances with the rotation. Sampling the tail, or the backlog
  // page, would re-check the same targets forever and never reach the fleet.
  it("draws the reconciliation sample from the least-recently-swept end", async () => {
    await callWith(
      [backlog("oldest", 0), backlog("newer", 0)],
      [backlog("busy", 9)]
    );

    expect(mockReconcile).toHaveBeenCalledWith(["oldest", "newer"]);
  });

  // A reconciliation that answered for nothing must not manufacture drift.
  it("does not report drift when the reconciliation returned nothing", async () => {
    mockSweepPage.mockResolvedValue([backlog("target-a", 7)]);
    mockCountQueued.mockResolvedValue({ backlogs: [], hasMore: false });
    mockAwaitingSweep.mockResolvedValue(0);
    mockMarkSwept.mockResolvedValue(1);
    mockReconcile.mockResolvedValue([]);

    await GET(makeRequest());

    expect(vi.mocked(log.warn)).not.toHaveBeenCalledWith(
      "command.queue.counter_drift",
      expect.anything()
    );
  });
});

describe("GET /api/cron/sample-command-queue-depth — failure", () => {
  // A sampler built to end a blind spot must not go dark silently itself: the
  // 500 trips Vercel's cron alerting, and the error line says which read broke.
  it("returns 500 and logs the error when a read rejects", async () => {
    mockSweepPage.mockResolvedValue([backlog("target-a", 0)]);
    mockCountQueued.mockRejectedValue(new Error("connection terminated"));

    const response = await GET(makeRequest());

    expect(response.status).toBe(500);
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.stringContaining("sampling failed"),
      expect.objectContaining({ error: expect.any(Error) })
    );
    expect(mockEmitQueueMetric).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/sample-command-queue-depth — per-tick sampling cap", () => {
  // Registering a compute target needs only a distinct machine name and no
  // quota, so an unbounded per-target loop on a five-minute cron is work one
  // account can inflate permanently.
  it("emits no more than the cap even when the fleet is larger", async () => {
    const rotation = Array.from(
      { length: MAX_SAMPLED_TARGETS + 25 },
      (_, index) => backlog(`target-${index}`, 0)
    );

    await callWith(rotation, [], true);

    expect(mockEmitQueueMetric).toHaveBeenCalledTimes(MAX_SAMPLED_TARGETS);
  });

  // A bound tick must defer a SHALLOW queue, never the deep one an operator is
  // trying to see. The deep target sits at the very end of the sweep page, so
  // only the backlog page's precedence gets it emitted at all.
  it("spends the budget on the deepest backlogs before the rotation", async () => {
    const rotation = Array.from({ length: MAX_SAMPLED_TARGETS }, (_, index) =>
      backlog(`shallow-${index}`, 0)
    );

    await callWith(
      [...rotation, backlog("deep-target", 43)],
      [backlog("deep-target", 43)]
    );

    expect(emittedFor("deep-target")).toMatchObject({ value: 43 });
    expect(mockEmitQueueMetric).toHaveBeenCalledTimes(MAX_SAMPLED_TARGETS);
  });

  // The truthfulness bar. A tick that covered part of the fleet reports how
  // much is still owed as a NUMBER — a boolean "truncated" could not
  // distinguish one deferred target from ten thousand, and nothing would say
  // the rest are coming.
  it("reports how much of the fleet still owes a sweep", async () => {
    await callWith([backlog("target-a", 0)], [], false, 4200);

    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining("sampling complete"),
      expect.objectContaining({ targetsAwaitingSweep: 4200 })
    );
  });

  // The complement, and the case that makes the number load-bearing: a fully
  // covered fleet must report zero outstanding rather than a stale figure.
  it("reports a complete cycle as nothing awaiting", async () => {
    await callWith([backlog("target-a", 3)], [backlog("target-a", 3)]);

    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining("sampling complete"),
      expect.objectContaining({
        targetsAwaitingSweep: 0,
        targetsSampled: 1,
        backlogPageTruncated: false,
      })
    );
  });

  it("reports a truncated backlog page from its probe row", async () => {
    await callWith([backlog("target-a", 1)], [], true);

    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining("sampling complete"),
      expect.objectContaining({ backlogPageTruncated: true })
    );
  });

  // The stamp is what turns the cap from a discard into a deferral. Without it
  // the rotation never advances and the same head is re-served forever, which
  // is the permanent omission this ticket exists to end — and every emission
  // assertion above stays green while it happens.
  //
  // ROTATION TARGETS ONLY. Stamping `deep` because the backlog page named it
  // would keep every deep backlog permanently fresh and pinned at the
  // rotation's tail, so it would never come up for the reconciliation sample —
  // the counters most likely to be lying would be the ones never checked.
  it("stamps the rotation targets it gauged, and not the backlog page's", async () => {
    await callWith(
      [backlog("target-a", 0), backlog("target-b", 0)],
      [backlog("deep", 9)]
    );

    expect(mockMarkSwept).toHaveBeenCalledWith(
      ["target-a", "target-b"],
      expect.any(Date)
    );
  });

  // ONE `cycleStart` threads into both the stamp and the progress count. Two
  // independent `new Date()` captures would race: a target stamped at T2 with
  // the count taken at T1 < T2 reads as still owing a sweep it has already had,
  // so the tick under-reports its own completeness. `expect.any(Date)` on the
  // stamp alone cannot see that.
  it("counts progress against the same instant it stamped with", async () => {
    await callWith([backlog("target-a", 0)], []);

    const stampedAt = mockMarkSwept.mock.calls[0][1];
    expect(stampedAt).toBeInstanceOf(Date);
    expect(mockAwaitingSweep).toHaveBeenCalledWith(stampedAt);
  });

  // THE STARVATION CASE. A fleet-wide stall puts every target over the
  // threshold at once — the condition ISS-8673 and ISS-8686 make routine — so
  // the backlog page arrives full. Emitting it before the rotation with no
  // reservation means no rotation entry is ever reached, nothing is stamped,
  // and the rest of the fleet is permanently omitted again: the exact defect
  // this ticket exists to end, re-created by the deepest-first preference.
  it("advances the rotation even when the backlog page fills the budget", async () => {
    const saturated = Array.from({ length: MAX_SAMPLED_TARGETS }, (_, index) =>
      backlog(`deep-${index}`, 500 - index)
    );
    const rotation = Array.from({ length: MAX_SAMPLED_TARGETS }, (_, index) =>
      backlog(`rotation-${index}`, 0)
    );

    await callWith(rotation, saturated);

    const stamped = mockMarkSwept.mock.calls[0][0];
    expect(stamped).toHaveLength(MIN_ROTATION_SLOTS_PER_TICK);
    expect(stamped[0]).toBe("rotation-0");
    // The budget is still spent in full, and still deepest-first.
    expect(mockEmitQueueMetric).toHaveBeenCalledTimes(MAX_SAMPLED_TARGETS);
    expect(emittedFor("deep-0")).toMatchObject({ value: 500 });
    // And the tick says it left rotation work behind rather than implying it
    // swept the fleet.
    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining("sampling complete"),
      expect.objectContaining({ sweepDeferred: true })
    );
  });

  // The complement. Hardcoding `sweepDeferred` either way passes one of these
  // two and fails the other.
  it("reports no deferral when the budget covered both reads", async () => {
    await callWith([backlog("target-a", 0)], [backlog("target-a", 0)]);

    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining("sampling complete"),
      expect.objectContaining({ sweepDeferred: false })
    );
  });

  // The response body is the operator-facing summary of the tick. Nothing read
  // it, so a dropped or reordered field shipped green.
  it("states the tick's coverage and drift in the response body", async () => {
    const response = await callWith(
      [backlog("target-a", 4)],
      [backlog("target-a", 4)],
      false,
      12
    );

    await expect(response.text()).resolves.toBe(
      "OK: sampled 1 targets, 1 with a backlog, 0 over threshold, deepest 4, 12 awaiting sweep, 0 drifted of 1 reconciled"
    );
  });

  // A backlog page filled exactly to the cap is what a complete fleet of
  // exactly that size returns, so it is NOT evidence that a target was omitted.
  // Deriving truncation from the page length instead of the read's probe row
  // reports a fully covered 500-target fleet as partial and turns
  // `targetsWithBacklog` into a floor it is not.
  it("reports no truncation for exactly a cap-full backlog page", async () => {
    const full = Array.from({ length: MAX_SAMPLED_TARGETS }, (_, index) =>
      backlog(`target-${index}`, 3)
    );

    await callWith(full, full);

    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining("sampling complete"),
      expect.objectContaining({
        backlogPageTruncated: false,
        targetsWithBacklog: MAX_SAMPLED_TARGETS,
        targetsSampled: MAX_SAMPLED_TARGETS,
      })
    );
  });

  // One target past the cap: the read's probe row saw it, so the flag must be
  // set even though the page it returns is the same size as the honest one
  // above. The two cases differ only in that signal, which is the point.
  it("reports truncation when one target lies past the backlog cap", async () => {
    const full = Array.from({ length: MAX_SAMPLED_TARGETS }, (_, index) =>
      backlog(`target-${index}`, 3)
    );

    await callWith(full, full, true);

    expect(vi.mocked(log.info)).toHaveBeenCalledWith(
      expect.stringContaining("sampling complete"),
      expect.objectContaining({
        backlogPageTruncated: true,
        targetsWithBacklog: MAX_SAMPLED_TARGETS,
      })
    );
  });

  it("asks each read for the shipped bound", async () => {
    await callWith([backlog("target-a", 0)], []);

    expect(mockSweepPage).toHaveBeenCalledWith(MAX_SAMPLED_TARGETS);
    expect(mockCountQueued).toHaveBeenCalledWith(MAX_SAMPLED_TARGETS);
  });

  // A deliberate, independent literal. Deriving it from the exported constant
  // would keep every case above green at any value, including one raised back
  // to an unbounded fleet scan.
  it("holds the shipped cap at 500", () => {
    expect(MAX_SAMPLED_TARGETS).toBe(500);
  });
});
