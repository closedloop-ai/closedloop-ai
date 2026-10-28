import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockWithDb, mockWithDbTx, mockEmitTelemetryMetric } = vi.hoisted(
  () => ({
    mockWithDb: vi.fn(),
    mockWithDbTx: vi.fn(),
    mockEmitTelemetryMetric: vi.fn(),
  })
);

// The page read and the per-candidate clear each take their client as a
// parameter, so only the sweep's own `withDb` / `withDb.tx` boundaries need
// standing in for — which is what makes the drain, its catch, and the real
// try-lock decision reachable without a database.
vi.mock("@repo/database", () => ({
  withDb: Object.assign(mockWithDb, { tx: mockWithDbTx }),
  SessionOrigin: { DESKTOP_SYNC: "DESKTOP_SYNC" },
  Prisma: {},
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mockEmitTelemetryMetric,
}));

import {
  clearOrphanedChunkMarker,
  clearOrphanedChunkMarkersBatch,
  countUnconfirmedAckMarkers,
  orphanedChunkMarkerWhere,
  PENDING_CHUNK_TTL_HOURS,
  PendingChunkClearOutcome,
  pendingChunkCutoff,
  pendingChunkSweepService,
  selectOrphanedChunkMarkerCandidates,
  unconfirmedAckMarkerWhere,
} from "./pending-chunk-sweep-service";

describe("the orphan window", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is fixed at the desktop's outer retry horizon", () => {
    // 72 written out rather than imported from the module under test: a policy
    // pinned by the constant it polices moves silently with it. 72h is
    // `SESSION_MISSING_MAX_RETRY_AGE_MS` — 3 x the 24h dead-letter cap — the
    // longest any desktop lane keeps retrying.
    expect(PENDING_CHUNK_TTL_HOURS).toBe(72);
  });

  it("ignores an operator override in the environment", async () => {
    // ISS-8602 (review: davetho). The window is policy, not configuration:
    // the 72h derivation is the safety argument, and an env read would let a
    // one-hour override discard it with no owner, no schema, and no docs path.
    // Re-introducing the read turns this red.
    vi.stubEnv("PENDING_CHUNK_TTL_HOURS", "1");
    mockWithDb.mockImplementation((run: (db: unknown) => unknown) =>
      Promise.resolve(
        run({
          sessionDetail: {
            findMany: () => Promise.resolve([]),
            count: () => Promise.resolve(0),
          },
        })
      )
    );

    const result = await pendingChunkSweepService.runPendingChunkSweep(
      new Date("2026-07-10T12:00:00.000Z")
    );

    expect(result.ttlHours).toBe(72);
    expect(result.cutoff).toBe("2026-07-07T12:00:00.000Z");
  });
});

describe("pendingChunkCutoff", () => {
  it("subtracts the window in hours from now", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
      expect(pendingChunkCutoff(new Date(), 72).toISOString()).toBe(
        "2026-07-07T12:00:00.000Z"
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("orphanedChunkMarkerWhere", () => {
  const cutoff = new Date("2026-07-07T12:00:00.000Z");

  it("selects only a staged sequence that has received nothing since the cutoff", () => {
    const where = orphanedChunkMarkerWhere(cutoff, null);

    expect(where.pendingChunkRevision).toEqual({ not: null });
    // The anchor is RECEIVE time. `lastActivityAt` is session time, so a
    // historical re-parse would look ancient the moment chunk 0 landed.
    expect(where.lastSyncedAt).toEqual({ lt: cutoff });
    expect(where.artifact).toBeUndefined();
  });

  it("clears only a producer confirmed to speak the row-level ack", () => {
    // ISS-8602 (review: davetho). An EQUALITY test is the fail-safe: under
    // SQL's three-valued logic neither a NULL nor a band this build cannot name
    // satisfies it, so every row staged before the column existed is out of
    // reach with no backfill. A `not: 'whole_batch'` here would compile, read as
    // equivalent, and sweep every one of them.
    const where = orphanedChunkMarkerWhere(cutoff, null);

    expect(where.pendingChunkAckContract).toBe("row_level");
  });

  it("bounds the selection to one organization when scoped", () => {
    const where = orphanedChunkMarkerWhere(cutoff, "org-1");

    expect(where.artifact).toEqual({ is: { organizationId: "org-1" } });
  });
});

describe("unconfirmedAckMarkerWhere", () => {
  const cutoff = new Date("2026-07-07T12:00:00.000Z");

  it("counts the declined bands over the same aged population", () => {
    const declined = unconfirmedAckMarkerWhere(cutoff, null);
    const clearable = orphanedChunkMarkerWhere(cutoff, null);

    // Same age axis as the clearable set, so the two counts partition one
    // population rather than measuring different windows.
    expect(declined.pendingChunkRevision).toEqual(
      clearable.pendingChunkRevision
    );
    expect(declined.lastSyncedAt).toEqual(clearable.lastSyncedAt);
    // The NULL arm is SPELLED OUT rather than left to `not`, whose three-valued
    // behaviour on a nullable column would drop every unset row — which is the
    // majority of this population and the whole reason it is counted. The second
    // arm keeps an unrecognized future band counted rather than lost between the
    // two predicates.
    expect(declined.OR).toEqual([
      { pendingChunkAckContract: null },
      { NOT: { pendingChunkAckContract: "row_level" } },
    ]);
  });

  it("bounds the count to one organization when scoped", () => {
    expect(unconfirmedAckMarkerWhere(cutoff, "org-1").artifact).toEqual({
      is: { organizationId: "org-1" },
    });
  });
});

describe("countUnconfirmedAckMarkers", () => {
  it("counts against the cutoff it was handed, never a fresh clock", async () => {
    const cutoff = new Date("2026-07-07T12:00:00.000Z");
    const count = vi.fn().mockResolvedValue(7);

    const result = await countUnconfirmedAckMarkers(
      { sessionDetail: { count } } as never,
      cutoff,
      null
    );

    expect(result).toBe(7);
    expect(count).toHaveBeenCalledWith({
      where: unconfirmedAckMarkerWhere(cutoff, null),
    });
  });
});

const CUTOFF = new Date("2026-07-07T12:00:00.000Z");

describe("selectOrphanedChunkMarkerCandidates", () => {
  it("reads the lock identity alongside the artifact id", async () => {
    const findMany = vi.fn().mockResolvedValue([]);

    await selectOrphanedChunkMarkerCandidates(
      { sessionDetail: { findMany } } as never,
      CUTOFF,
      null
    );

    // `external_session_id` is what `tryAcquireSessionAdvisoryLocks` hashes.
    // Drop it from the projection and the clear below has no key to lock on.
    expect(findMany.mock.calls[0]?.[0]?.select).toEqual({
      artifactId: true,
      externalSessionId: true,
    });
    expect(findMany.mock.calls[0]?.[0]?.where).toEqual(
      orphanedChunkMarkerWhere(CUTOFF, null)
    );
  });

  it("bounds the selection by the same number the drain pages on", async () => {
    const findMany = vi.fn().mockResolvedValue([]);

    await selectOrphanedChunkMarkerCandidates(
      { sessionDetail: { findMany } } as never,
      CUTOFF,
      null
    );

    // 500 — `SESSION_DELETE_BATCH_SIZE`, written out rather than imported for
    // the reason the paging case below is: the drain calls a page SHORT, and
    // therefore the population drained, by comparing it against that constant.
    // Importing the constant here would let the bound and the termination test
    // move together and assert nothing. The bound used to arrive as a caller
    // parameter, which `no-terminal-cap-threaded` reports and which could set
    // the two to different numbers — a full page read as short, ending the walk
    // with markers still standing.
    expect(findMany.mock.calls[0]?.[0]?.take).toBe(500);
  });
});

describe("clearOrphanedChunkMarker", () => {
  const candidate = {
    artifactId: "a-1",
    externalSessionId: "session-1",
  } as const;

  it("clears all four sequence columns, not the revision alone", async () => {
    const tx = lockedTx({ legacy: true, current: true, updatedCount: 1 });

    const outcome = await clearOrphanedChunkMarker(
      tx.client,
      candidate,
      CUTOFF,
      null
    );

    // `schema.prisma`: "All FOUR are NULL when no chunked sequence is
    // mid-apply". Clearing the revision alone leaves a half-open marker that is
    // neither the steady state nor a live sequence.
    //
    // ISS-8602 added the fourth. The band is part of the marker, so a clear that
    // left it behind would strand a live `row_level` beside a NULL revision —
    // the same half-marker shape, and the next chunk 0 would re-stage over a
    // stale record of who the producer was. An exact-equality assertion is what
    // makes that a failure rather than an unnoticed extra column.
    expect(tx.updateMany.mock.calls[0]?.[0]?.data).toEqual({
      pendingChunkRevision: null,
      pendingChunkTotal: null,
      pendingChunkReceived: null,
      pendingChunkAckContract: null,
    });
    expect(outcome).toBe(PendingChunkClearOutcome.Cleared);
  });

  it("re-checks the full selection predicate inside the UPDATE", async () => {
    const tx = lockedTx({ legacy: true, current: true, updatedCount: 1 });

    await clearOrphanedChunkMarker(tx.client, candidate, CUTOFF, "org-1");

    // Trusting the captured id would reap a row whose next chunk committed in
    // the page-read->update gap; that chunk has already pushed `lastSyncedAt`
    // past the cutoff, so re-running the predicate is what spares it. The org
    // scope rides along, so a widened selection cannot cross tenants either.
    expect(tx.updateMany.mock.calls[0]?.[0]?.where).toEqual({
      AND: [orphanedChunkMarkerWhere(CUTOFF, "org-1"), { artifactId: "a-1" }],
    });
  });

  it("reports a row the recheck refused as spared, not cleared", async () => {
    const tx = lockedTx({ legacy: true, current: true, updatedCount: 0 });

    const outcome = await clearOrphanedChunkMarker(
      tx.client,
      candidate,
      CUTOFF,
      null
    );

    // The drain pages on the candidate count; the repair metric counts only
    // what the UPDATE changed. Collapsing them would report a row the recheck
    // spared as repaired.
    expect(outcome).toBe(PendingChunkClearOutcome.Spared);
  });

  it("writes nothing when a live apply holds the session", async () => {
    const tx = lockedTx({ legacy: false, current: false, updatedCount: 1 });

    const outcome = await clearOrphanedChunkMarker(
      tx.client,
      candidate,
      CUTOFF,
      null
    );

    // ISS-8602 (review: whitlockk). The apply holding this lock has already read
    // the staged marker and will write `pendingChunkReceived` ALONE when it
    // commits. Clearing here would leave that count beside a NULL revision and
    // total — a half-marker `schema.prisma` says cannot exist and this sweep's
    // own predicate can never reach again.
    expect(tx.updateMany).not.toHaveBeenCalled();
    expect(outcome).toBe(PendingChunkClearOutcome.Contended);
  });

  it("writes nothing when only the legacy half of the lock pair is held", async () => {
    const tx = lockedTx({ legacy: true, current: false, updatedCount: 1 });

    const outcome = await clearOrphanedChunkMarker(
      tx.client,
      candidate,
      CUTOFF,
      null
    );

    // Both halves are the lock. Treating a partial acquisition as success would
    // let this sweep and an apply that took only the 64-bit key overlap.
    expect(tx.updateMany).not.toHaveBeenCalled();
    expect(outcome).toBe(PendingChunkClearOutcome.Contended);
  });
});

describe("clearOrphanedChunkMarkersBatch", () => {
  beforeEach(() => {
    mockWithDb.mockReset();
    mockWithDbTx.mockReset();
  });

  it("counts cleared, spared and contended candidates separately", async () => {
    installPage([candidateAt(1), candidateAt(2), candidateAt(3)]);
    mockWithDbTx
      .mockResolvedValueOnce(PendingChunkClearOutcome.Cleared)
      .mockResolvedValueOnce(PendingChunkClearOutcome.Spared)
      .mockResolvedValueOnce(PendingChunkClearOutcome.Contended);

    const batch = await clearOrphanedChunkMarkersBatch(CUTOFF, null);

    expect(batch).toEqual({
      candidateCount: 3,
      processed: 3,
      cleared: 1,
      skippedByContention: 1,
      stoppedOnDeadline: false,
    });
  });

  it("opens one transaction per candidate", async () => {
    installPage([candidateAt(1), candidateAt(2)]);
    mockWithDbTx.mockResolvedValue(PendingChunkClearOutcome.Cleared);

    await clearOrphanedChunkMarkersBatch(CUTOFF, null);

    // One session's lock pair per transaction is what keeps the sweep out of
    // any deadlock cycle; a single transaction over the page would hold up to
    // `batchSize` session locks at once and lose the whole page to one of them.
    expect(mockWithDbTx).toHaveBeenCalledTimes(2);
  });

  it("opens no transaction when nothing is orphaned", async () => {
    installPage([]);

    const batch = await clearOrphanedChunkMarkersBatch(CUTOFF, null);

    expect(mockWithDbTx).not.toHaveBeenCalled();
    expect(batch).toEqual({
      candidateCount: 0,
      processed: 0,
      cleared: 0,
      skippedByContention: 0,
      stoppedOnDeadline: false,
    });
  });
});

describe("runPendingChunkSweep", () => {
  const NOW = new Date("2026-07-10T12:00:00.000Z");
  // 500 — `SESSION_DELETE_BATCH_SIZE`, written out rather than imported so the
  // paging case cannot silently stop paging if that constant changes.
  const FULL_BATCH = 500;

  beforeEach(() => {
    mockWithDb.mockReset();
    mockWithDbTx.mockReset();
    mockEmitTelemetryMetric.mockReset();
    pageRead.mockReset();
    markerCount.mockReset();
    markerCount.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    // Unconditional: a case that throws between `useFakeTimers` and a trailing
    // restore would leak a frozen clock into every later case in this worker.
    vi.useRealTimers();
  });

  it("keeps paging while a batch comes back full, summing what it cleared", async () => {
    installPages([
      fullPage(FULL_BATCH),
      [candidateAt(1), candidateAt(2), candidateAt(3)],
    ]);
    mockWithDbTx.mockResolvedValue(PendingChunkClearOutcome.Cleared);

    const result = await pendingChunkSweepService.runPendingChunkSweep(
      NOW,
      72,
      null
    );

    // Stopping after the first full batch would strand the rest until tomorrow.
    expect(pageRead).toHaveBeenCalledTimes(2);
    expect(result.cleared).toBe(503);
    expect(result.exitCode).toBe(0);
  });

  it("keeps draining past a contended candidate (ISS-8602, review: marisolashgrove)", async () => {
    installPages([
      fullPage(FULL_BATCH),
      [candidateAt(1), candidateAt(2), candidateAt(3)],
    ]);
    mockWithDbTx.mockImplementation(() =>
      Promise.resolve(
        mockWithDbTx.mock.calls.length === 1
          ? PendingChunkClearOutcome.Contended
          : PendingChunkClearOutcome.Cleared
      )
    );

    const result = await pendingChunkSweepService.runPendingChunkSweep(
      NOW,
      72,
      null
    );

    // ONE live apply holding ONE session says nothing about the other 499, and
    // nothing about the next page. Ending the drain there capped this sweep at
    // 500 markers a day on any day a single row in page 1 was mid-write.
    expect(pageRead).toHaveBeenCalledTimes(2);
    expect(result.cleared).toBe(FULL_BATCH - 1 + 3);
    // Still reported as unfinished: contention stops being a reason to STOP
    // without becoming a licence to claim the queue was emptied.
    expect(mockEmitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({ skippedByContention: 1, incomplete: true })
    );
    expect(result.summary).toContain("incomplete");
  });

  it("stops when a full page moved nothing out of the candidate set", async () => {
    // Every candidate contended: none was read, none written, all still match,
    // so the next read returns the identical page and the loop cannot converge.
    // A THIRD page is queued so deleting the no-progress break fails this on the
    // page count rather than spinning forever.
    installPages([fullPage(FULL_BATCH), fullPage(FULL_BATCH), []]);
    mockWithDbTx.mockResolvedValue(PendingChunkClearOutcome.Contended);

    const result = await pendingChunkSweepService.runPendingChunkSweep(
      NOW,
      72,
      null
    );

    expect(pageRead).toHaveBeenCalledTimes(1);
    expect(result.cleared).toBe(0);
    expect(mockEmitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 0,
        skippedByContention: FULL_BATCH,
        incomplete: true,
      })
    );
    expect(result.summary).toContain("incomplete");
  });

  it("stops the drain at its time budget between pages and reports it incomplete", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // The LAST transaction of the page is what carries the run past the
    // ceiling, so the page itself finishes under its deadline and it is the
    // between-pages check that has to stop the drain. 240_000 is
    // `PENDING_CHUNK_SWEEP_TIME_BUDGET_MS`, written out rather than imported so
    // a widened budget cannot move this boundary silently.
    let pagesRead = 0;
    installDbStub();
    pageRead.mockImplementation(() => {
      pagesRead += 1;
      // A SHORT page on the fourth read, so deleting the budget check below
      // fails this case on the page count instead of spinning forever.
      return Promise.resolve(pagesRead > 3 ? [] : fullPage(FULL_BATCH));
    });
    mockWithDbTx.mockImplementation(() => {
      if (mockWithDbTx.mock.calls.length === FULL_BATCH) {
        vi.setSystemTime(new Date(Date.now() + 240_000 + 1));
      }
      return Promise.resolve(PendingChunkClearOutcome.Cleared);
    });

    const result = await pendingChunkSweepService.runPendingChunkSweep(
      NOW,
      72,
      null
    );

    // The route's `maxDuration = 300` kill is not catchable: paging on would
    // lose the metric, the response, and the Slack alert for a prefix this run
    // really did repair.
    expect(pageRead).toHaveBeenCalledTimes(1);
    expect(mockWithDbTx).toHaveBeenCalledTimes(FULL_BATCH);
    expect(result.cleared).toBe(FULL_BATCH);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("incomplete");
    expect(mockEmitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({ count: FULL_BATCH, incomplete: true })
    );
  });

  it("stops INSIDE a page when the budget runs out mid-page (ISS-8602, review: marisolashgrove)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // The ceiling bounded the LOOP and not the PAGE: a page is up to 500 SERIAL
    // transactions, so one entered with budget left could spend the whole
    // reserved tail and be killed by the platform anyway. 1_000ms a transaction
    // against the 240_000ms budget puts the boundary at transaction 240 — well
    // inside the page, which is the case that could not be expressed before.
    installPage(fullPage(FULL_BATCH));
    mockWithDbTx.mockImplementation(() => {
      vi.setSystemTime(new Date(Date.now() + 1000));
      return Promise.resolve(PendingChunkClearOutcome.Cleared);
    });

    const result = await pendingChunkSweepService.runPendingChunkSweep(
      NOW,
      72,
      null
    );

    // 240 transactions, not 500: the page abandoned its remainder rather than
    // running it past the deadline.
    expect(mockWithDbTx).toHaveBeenCalledTimes(240);
    expect(pageRead).toHaveBeenCalledTimes(1);
    // The prefix it DID commit is still reported — every clear committed in its
    // own transaction, so a partial page is a partial repair, not a lost one.
    expect(result.cleared).toBe(240);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("incomplete");
  });

  it("reports a fully drained run as complete", async () => {
    installPages([[candidateAt(1)]]);
    mockWithDbTx.mockResolvedValue(PendingChunkClearOutcome.Cleared);

    const result = await pendingChunkSweepService.runPendingChunkSweep(
      NOW,
      72,
      null
    );

    // The counterpart the case above needs: if every exit said "incomplete",
    // the word would carry no information.
    expect(result.summary).not.toContain("incomplete");
    expect(mockEmitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({ incomplete: false })
    );
  });

  it("keeps the markers a committed batch cleared when a later batch throws", async () => {
    installPages([fullPage(FULL_BATCH)]);
    pageRead.mockRejectedValueOnce(new Error("connection reset"));
    mockWithDbTx.mockResolvedValue(PendingChunkClearOutcome.Cleared);

    const result = await pendingChunkSweepService.runPendingChunkSweep(
      NOW,
      72,
      null
    );

    // Each clear is its own committed transaction, so the first 500 really are
    // repaired. Reporting 0 here would under-count a repair that happened.
    expect(result.exitCode).toBe(1);
    expect(result.cleared).toBe(FULL_BATCH);
    expect(result.summary).toContain("connection reset");
    // `agent-sessions/AGENTS.md`: the repair must emit its metric, and the test
    // must assert the emission. The errored exit is a repair too.
    expect(mockEmitTelemetryMetric).toHaveBeenCalledTimes(1);
    // `exitCode` rides the metric so a partial sweep is queryable as one. Drop
    // it and this payload is byte-identical to a clean run that cleared 500.
    expect(mockEmitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({ count: FULL_BATCH, exitCode: 1 })
    );
  });

  it("counts the declined bands and emits them as their own metric", async () => {
    installPages([[candidateAt(1)]]);
    mockWithDbTx.mockResolvedValue(PendingChunkClearOutcome.Cleared);
    markerCount.mockResolvedValue(4);

    const result = await pendingChunkSweepService.runPendingChunkSweep(
      NOW,
      72,
      null
    );

    expect(result.skippedUnconfirmedAck).toBe(4);
    // ITS OWN metric, not a field on the repair count: the two describe opposite
    // outcomes for the same candidate, so one counter would report a declined
    // row as a repaired one. Both emissions, asserted together, so a run that
    // emitted only one of them fails.
    expect(mockEmitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: "agent_sessions.sync.orphaned_chunk_marker_cleared",
        count: 1,
      })
    );
    expect(mockEmitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric:
          "agent_sessions.sync.orphaned_chunk_marker_skipped_unconfirmed_ack",
        count: 4,
      })
    );
  });

  it("still emits a measured zero when every producer band is confirmed", async () => {
    installPages([[candidateAt(1)]]);
    mockWithDbTx.mockResolvedValue(PendingChunkClearOutcome.Cleared);
    markerCount.mockResolvedValue(0);

    const result = await pendingChunkSweepService.runPendingChunkSweep(
      NOW,
      72,
      null
    );

    // A MEASURED zero is real information and must be reported: suppressing it
    // would make "the fleet holds nothing back" and "the cron stopped running"
    // one no-data read. Distinct from the unmeasured case below, which is null.
    expect(result.skippedUnconfirmedAck).toBe(0);
    expect(mockEmitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric:
          "agent_sessions.sync.orphaned_chunk_marker_skipped_unconfirmed_ack",
        count: 0,
      })
    );
  });

  it("reports the declined count as unmeasured, not zero, when the drain threw", async () => {
    installPages([fullPage(FULL_BATCH)]);
    pageRead.mockRejectedValueOnce(new Error("connection reset"));
    mockWithDbTx.mockResolvedValue(PendingChunkClearOutcome.Cleared);

    const result = await pendingChunkSweepService.runPendingChunkSweep(
      NOW,
      72,
      null
    );

    // The count runs AFTER the drain, so an errored run never measured this
    // population. `null` says so; a 0 would claim "no markers are being held
    // back" on exactly the runs that know least — a fabricated measurement the
    // root `AGENTS.md` bad-data rule forbids.
    expect(result.exitCode).toBe(1);
    expect(result.skippedUnconfirmedAck).toBeNull();
    // And nothing is emitted under that name, so a summing consumer cannot read
    // an unmeasured run as a clean one. The repair metric still fires, which is
    // what makes the absence readable rather than silent.
    expect(mockEmitTelemetryMetric).toHaveBeenCalledTimes(1);
    expect(mockEmitTelemetryMetric).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metric:
          "agent_sessions.sync.orphaned_chunk_marker_skipped_unconfirmed_ack",
      })
    );
  });

  it("names the declined count in the summary a human actually reads", async () => {
    installPages([[candidateAt(1)]]);
    mockWithDbTx.mockResolvedValue(PendingChunkClearOutcome.Cleared);
    markerCount.mockResolvedValue(4123);

    const result = await pendingChunkSweepService.runPendingChunkSweep(
      NOW,
      72,
      null
    );

    // The summary is the log message, the 200 body AND the Slack alert. Reporting
    // `cleared` alone makes the first runs after deploy — where nothing is
    // backfilled, so the whole staged population is declined — read identically
    // to a genuinely empty fleet.
    expect(result.summary).toContain("declined 4123");
  });

  it("says nothing about declining when it declined nothing, or could not tell", async () => {
    installPages([[candidateAt(1)]]);
    mockWithDbTx.mockResolvedValue(PendingChunkClearOutcome.Cleared);
    markerCount.mockResolvedValue(0);

    const measuredZero = await pendingChunkSweepService.runPendingChunkSweep(
      NOW,
      72,
      null
    );

    // The counterpart the case above needs: if every summary said "declined",
    // the word would carry no information. A measured zero has nothing to report.
    expect(measuredZero.summary).not.toContain("declined");
  });

  it("skips the declined count when the drain spent its reserve, and says unmeasured", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // One page that consumes past the count's reserve. 240_000 and 30_000 are
    // `PENDING_CHUNK_SWEEP_TIME_BUDGET_MS` and `PENDING_CHUNK_COUNT_RESERVE_MS`,
    // written out rather than imported so widening either cannot move this
    // boundary silently. 211_000 is one second past 240_000 − 30_000.
    installDbStub();
    pageRead.mockImplementation(() => {
      vi.setSystemTime(new Date(Date.now() + 211_000));
      return Promise.resolve([candidateAt(1)]);
    });
    mockWithDbTx.mockResolvedValue(PendingChunkClearOutcome.Cleared);
    markerCount.mockResolvedValue(9);

    const result = await pendingChunkSweepService.runPendingChunkSweep(
      NOW,
      72,
      null
    );

    // The count is NOT attempted: an unbounded read in the tail the emission and
    // response need can push the request past the route's uncatchable
    // `maxDuration`, losing the record of clears that already committed.
    expect(markerCount).not.toHaveBeenCalled();
    // And the repair it did do is still reported, with the count unmeasured
    // rather than a fabricated 0 — `markerCount` was primed with 9, so a run that
    // ignored the reserve would report 9 here and fail this case.
    expect(result.cleared).toBe(1);
    expect(result.skippedUnconfirmedAck).toBeNull();
    expect(mockEmitTelemetryMetric).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metric:
          "agent_sessions.sync.orphaned_chunk_marker_skipped_unconfirmed_ack",
      })
    );
  });

  it("uses the fixed TTL and sweeps every org when called the way the cron calls it", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    mockWithDb.mockImplementation((run: (db: unknown) => unknown) =>
      run({ sessionDetail: { findMany, count } })
    );

    // No arguments — `route.ts` calls it exactly this way.
    const result = await pendingChunkSweepService.runPendingChunkSweep();

    expect(result.ttlHours).toBe(72);
    expect(result.summary).toContain("idle > 72h");
    // Unscoped: the cron is platform-wide, so an `artifact` scope here would
    // silently sweep only one organization.
    expect(findMany.mock.calls[0]?.[0]?.where?.artifact).toBeUndefined();
  });
});

/** The drain's page read, so paging is asserted on the statement that pages. */
const pageRead = vi.fn();
/** ISS-8602: the post-drain declined-band count. */
const markerCount = vi.fn();

function candidateAt(index: number) {
  return {
    artifactId: `a-${index}`,
    externalSessionId: `session-${index}`,
  };
}

function fullPage(size: number) {
  return Array.from({ length: size }, (_, index) => candidateAt(index));
}

/**
 * ISS-8602: the sweep makes TWO kinds of read through `withDb` — the drain's page
 * read and, after the drain, the declined-band count. Routing the callback
 * through a stub lets each land on its own statement, so a page-count assertion
 * measures paging rather than every `withDb` call the run happened to make.
 */
function installDbStub() {
  mockWithDb.mockImplementation((run: (db: unknown) => unknown) =>
    Promise.resolve(
      run({ sessionDetail: { findMany: pageRead, count: markerCount } })
    )
  );
}

/** Answers the sweep's page read with one fixed page, forever. */
function installPage(candidates: ReturnType<typeof candidateAt>[]) {
  installDbStub();
  pageRead.mockResolvedValue(candidates);
}

/** Answers the sweep's page reads with these pages, in order. */
function installPages(pages: ReturnType<typeof candidateAt>[][]) {
  installDbStub();
  for (const page of pages) {
    pageRead.mockResolvedValueOnce(page);
  }
}

/**
 * A transaction client whose two `pg_try_advisory_xact_lock` statements answer
 * as configured, so `clearOrphanedChunkMarker` runs the REAL acquisition
 * decision rather than a stubbed one.
 */
function lockedTx(config: {
  legacy: boolean;
  current: boolean;
  updatedCount: number;
}) {
  const acquired = [config.legacy, config.current];
  let call = 0;
  const queryRaw = vi.fn(() => {
    const result = [{ acquired: acquired[call] === true }];
    call += 1;
    return Promise.resolve(result);
  });
  const updateMany = vi.fn().mockResolvedValue({ count: config.updatedCount });
  return {
    client: {
      $queryRaw: queryRaw,
      sessionDetail: { updateMany },
    } as never,
    queryRaw,
    updateMany,
  };
}
