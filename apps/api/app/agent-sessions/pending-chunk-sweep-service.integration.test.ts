/**
 * ISS-8602: the TTL boundary for the orphaned pending-chunk marker sweep,
 * against a real Postgres.
 *
 * The boundary is the whole risk. Clearing the marker of a sequence that is
 * merely SLOW costs that session a full re-send, so every case that varies the
 * AGE axis seeds a LIVE sequence beside the orphan and asserts the sweep hit
 * exactly one — a fixture with only the orphan in it would pass against a
 * predicate that swept everything. The gap case varies a different axis
 * (concurrency) and deliberately seeds one row.
 *
 * Time is pinned by INJECTING `now` into the production entry point rather than
 * by `vi.setSystemTime`: a frozen clock around a live Prisma connection also
 * freezes the driver's own timers, and the injected instant is what every cutoff
 * here is measured from, so no real clock reaches an assertion either way.
 */

import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockEmitTelemetryMetric } = vi.hoisted(() => ({
  mockEmitTelemetryMetric: vi.fn(),
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mockEmitTelemetryMetric,
}));

import {
  createCommittedTestOrganizationTracker,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { IndexKeyOrigin } from "@/lib/index-key-lookup";
import {
  clearOrphanedChunkMarker,
  pendingChunkSweepService,
  selectOrphanedChunkMarkerCandidates,
} from "./pending-chunk-sweep-service";
import { acquireSessionAdvisoryLocks } from "./service/advisory-locks";
import {
  type ChunkGatingInput,
  resolveChunkGating,
} from "./service/chunk-revision-gating";
import { SessionSyncMetric } from "./service/session-sync-metrics";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const NOW = new Date("2026-07-10T12:00:00.000Z");
// Written out here, deliberately NOT imported from the module under test: a
// boundary pinned by the constant it polices stays green when that constant
// moves. 72h = 259_200_000ms.
const TTL_HOURS = 72;
const TTL_MS = 259_200_000;
const EPSILON_MS = 60_000;
/** TTL−ε — still inside the window, so the sequence is live. */
const JUST_INSIDE_TTL = new Date(NOW.getTime() - TTL_MS + EPSILON_MS);
/** TTL+ε — past the window, so the sequence is an orphan. */
const JUST_OUTSIDE_TTL = new Date(NOW.getTime() - TTL_MS - EPSILON_MS);

/**
 * ISS-8602: the two producer bands, as LITERALS. Not imported from the module
 * under test — the sweep's predicate and the desktop's ack contract both key off
 * these exact strings, so reading them from the const object would follow a
 * rename past the compatibility break.
 */
const ROW_LEVEL_BAND = "row_level";
const WHOLE_BATCH_BAND = "whole_batch";

/**
 * A staged sequence the sweep is ALLOWED to reap: the band is what makes it
 * eligible at all, so every AGE-axis case below keeps varying age alone.
 */
const STAGED_MARKER = {
  pendingChunkRevision: 42,
  pendingChunkTotal: 3,
  pendingChunkReceived: 1,
  pendingChunkAckContract: ROW_LEVEL_BAND,
} as const;

const CLEARED_MARKER = {
  pendingChunkRevision: null,
  pendingChunkTotal: null,
  pendingChunkReceived: null,
  pendingChunkAckContract: null,
} as const;

describeIfDb("pendingChunkSweepService.runPendingChunkSweep", () => {
  const tracker = createCommittedTestOrganizationTracker();

  beforeEach(() => {
    mockEmitTelemetryMetric.mockClear();
  });

  afterEach(async () => {
    await tracker.cleanup();
  });

  it("clears the marker past the TTL and leaves the one inside it whole", async () => {
    const organizationId = await tracker.create();
    const user = await createTestUser(organizationId);
    const live = await seedStagedSequence(
      organizationId,
      user.id,
      "live",
      JUST_INSIDE_TTL
    );
    const orphan = await seedStagedSequence(
      organizationId,
      user.id,
      "orphan",
      JUST_OUTSIDE_TTL
    );
    // A row with no sequence staged at all, aged well past the window: proves
    // the count measures markers cleared, not rows old enough to look at.
    const unmarked = await createTestSessionDetail({
      organizationId,
      userId: user.id,
      label: "unmarked",
      lastSyncedAt: JUST_OUTSIDE_TTL,
    });

    const result = await pendingChunkSweepService.runPendingChunkSweep(
      NOW,
      TTL_HOURS,
      organizationId
    );

    expect(result.cleared).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(await readMarker(orphan)).toEqual(CLEARED_MARKER);
    expect(await readMarker(live)).toEqual(STAGED_MARKER);
    expect(await readMarker(unmarked)).toEqual(CLEARED_MARKER);
  });

  it("clears the confirmed band and leaves the unconfirmed ones standing", async () => {
    const organizationId = await tracker.create();
    const user = await createTestUser(organizationId);
    // THREE bands, one age. Every row here is past the TTL, so age cannot be
    // what separates them — only the producer band can. A fixture carrying one
    // band would be satisfied by a predicate that cleared everything or nothing.
    const confirmed = await seedStagedSequence(
      organizationId,
      user.id,
      "confirmed",
      JUST_OUTSIDE_TTL,
      ROW_LEVEL_BAND
    );
    const legacy = await seedStagedSequence(
      organizationId,
      user.id,
      "legacy",
      JUST_OUTSIDE_TTL,
      WHOLE_BATCH_BAND
    );
    // The pre-migration shape, and the reason the migration backfills nothing: a
    // NULL band must read as "do not clear" without anyone writing a branch for
    // it, because at deploy time EVERY staged row looks like this.
    const unknown = await seedStagedSequence(
      organizationId,
      user.id,
      "unknown",
      JUST_OUTSIDE_TTL,
      null
    );

    const result = await pendingChunkSweepService.runPendingChunkSweep(
      NOW,
      TTL_HOURS,
      organizationId
    );

    // Exactly one of three, and WHICH one — a count alone would pass if the
    // sweep had cleared the legacy row and spared the confirmed one.
    expect(result.cleared).toBe(1);
    expect(await readMarker(confirmed)).toEqual(CLEARED_MARKER);
    // Whole, band included. Clearing a legacy row's marker is the data-loss path
    // this gate exists to close: that client already deleted its outbox rows, so
    // a chunk delivered afterwards would land foreign and be gone for good.
    expect(await readMarker(legacy)).toEqual({
      ...STAGED_MARKER,
      pendingChunkAckContract: WHOLE_BATCH_BAND,
    });
    expect(await readMarker(unknown)).toEqual({
      ...STAGED_MARKER,
      pendingChunkAckContract: null,
    });
    // Both declined rows are COUNTED, not merely spared. An uncounted skip is
    // indistinguishable from a fleet with nothing to sweep.
    expect(result.skippedUnconfirmedAck).toBe(2);
    expect(mockEmitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric:
          "agent_sessions.sync.orphaned_chunk_marker_skipped_unconfirmed_ack",
        count: 2,
      })
    );
  });

  // ISS-8602 (review: davetho, P1 on #7092). The band gate is a data-loss
  // guard, and the case above proves only its FIRST half — that the legacy row's
  // marker survives the sweep. What the reviewer asked to see is the second
  // half, which is the half the loss actually happens in: that a
  // no-`wantsAcceptedSessionIds` client RESUMING its tail after the TTL has
  // elapsed still lands that tail. A marker left standing is worth nothing if
  // the resumed chunk is refused anyway.
  //
  // Both bands are seeded and driven through the SAME resumed chunk so the
  // assertion cannot be vacuous: `isForeignChunk` is shown to be reachable on
  // this exact input shape, and the only thing separating the two rows is
  // whether the sweep was allowed to clear the marker. That is what makes the
  // gate — not the age, not the chunk — the thing under test.
  it("still applies a legacy client's resumed tail after the TTL, where a cleared one is refused", async () => {
    const organizationId = await tracker.create();
    const user = await createTestUser(organizationId);
    const legacy = await seedStagedSequence(
      organizationId,
      user.id,
      "legacy-resume",
      JUST_OUTSIDE_TTL,
      WHOLE_BATCH_BAND
    );
    const confirmed = await seedStagedSequence(
      organizationId,
      user.id,
      "confirmed-resume",
      JUST_OUTSIDE_TTL,
      ROW_LEVEL_BAND
    );

    await pendingChunkSweepService.runPendingChunkSweep(
      NOW,
      TTL_HOURS,
      organizationId
    );

    // Read the rows back and gate against what Postgres ACTUALLY holds, not
    // against the fixture: the sweep is the step under test, so re-stating the
    // marker here would decide the answer before `resolveChunkGating` saw it.
    const legacyDecision = resolveChunkGating(
      await resumedTailGatingInput(legacy)
    );
    const confirmedDecision = resolveChunkGating(
      await resumedTailGatingInput(confirmed)
    );

    // The whole point of declining the legacy band. Its marker still names the
    // sequence, so chunk 1 of 3 at revision 42 matches that identity, is written
    // rather than dropped, and advances the received count. Without the gate the
    // client has already deleted this row from its outbox, so a refusal here is
    // the tail gone for good.
    expect(legacyDecision.isForeignChunk).toBe(false);
    expect(legacyDecision.pendingChunkPatch).toEqual({
      pendingChunkReceived: 2,
    });

    // The same chunk against the row the sweep WAS allowed to clear: no staged
    // identity remains for it to match, so it is foreign and writes nothing.
    // That is the cost the gate is buying off, and it is safe to pay HERE only
    // because this producer echoes accepted ids and will re-send.
    expect(confirmedDecision.isForeignChunk).toBe(true);
  });

  it("counts only the scoped organization's declined markers", async () => {
    const organizationId = await tracker.create();
    const user = await createTestUser(organizationId);
    const otherOrganizationId = await tracker.create();
    const otherUser = await createTestUser(otherOrganizationId);
    await seedStagedSequence(
      organizationId,
      user.id,
      "declined-in-scope",
      JUST_OUTSIDE_TTL,
      WHOLE_BATCH_BAND
    );
    // Same band, same age, different org. The count shares its org clause with
    // the drain's predicate, so this pins that the SHARED half is actually
    // applied on the count path too rather than only on the clear path.
    await seedStagedSequence(
      otherOrganizationId,
      otherUser.id,
      "declined-out-of-scope",
      JUST_OUTSIDE_TTL,
      WHOLE_BATCH_BAND
    );

    const result = await pendingChunkSweepService.runPendingChunkSweep(
      NOW,
      TTL_HOURS,
      organizationId
    );

    expect(result.cleared).toBe(0);
    // One, not two: an unscoped count would report both and silently leak
    // another tenant's backlog into this org's number.
    expect(result.skippedUnconfirmedAck).toBe(1);
  });

  it("emits the repair once per run, carrying the markers it cleared", async () => {
    const organizationId = await tracker.create();
    const user = await createTestUser(organizationId);
    await seedStagedSequence(organizationId, user.id, "live", JUST_INSIDE_TTL);
    await seedStagedSequence(
      organizationId,
      user.id,
      "orphan-a",
      JUST_OUTSIDE_TTL
    );
    await seedStagedSequence(
      organizationId,
      user.id,
      "orphan-b",
      JUST_OUTSIDE_TTL
    );

    await pendingChunkSweepService.runPendingChunkSweep(
      NOW,
      TTL_HOURS,
      organizationId
    );

    // `agent-sessions/AGENTS.md`: a repair path must emit its telemetry metric
    // and the test must assert the emission. ONE emission for the run, carrying
    // the two markers cleared rather than the three sessions seeded.
    //
    // What this case does NOT pin: cleared-vs-SELECTED. The predicate already
    // excludes the live row, so both readings are 2 here. That distinction is
    // pinned by the gap case below and by "reports the count the UPDATE
    // changed, never the count it selected" in the unit suite.
    // ISS-8602: counted per METRIC NAME, not per call. The run now emits a
    // second, separate name for the markers it declined, so a bare call count
    // here would move with that sibling instead of policing this one. The
    // "once per run" expectation is unchanged and still the point.
    expect(
      mockEmitTelemetryMetric.mock.calls.filter(
        ([event]) =>
          event?.metric === SessionSyncMetric.OrphanedChunkMarkerCleared
      )
    ).toHaveLength(1);
    expect(mockEmitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.OrphanedChunkMarkerCleared,
        count: 2,
        ttlHours: TTL_HOURS,
      })
    );
  });

  it("still reports a zero repair when every staged sequence is inside the TTL", async () => {
    const organizationId = await tracker.create();
    const user = await createTestUser(organizationId);
    await seedStagedSequence(organizationId, user.id, "live", JUST_INSIDE_TTL);

    const result = await pendingChunkSweepService.runPendingChunkSweep(
      NOW,
      TTL_HOURS,
      organizationId
    );

    expect(result.cleared).toBe(0);
    // A suppressed zero would make a healthy fleet and a cron that stopped
    // running the same no-data read.
    expect(mockEmitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.OrphanedChunkMarkerCleared,
        count: 0,
      })
    );
  });

  it("spares a sequence whose last chunk landed exactly at the cutoff", async () => {
    const organizationId = await tracker.create();
    const user = await createTestUser(organizationId);
    const atCutoff = await seedStagedSequence(
      organizationId,
      user.id,
      "at-cutoff",
      new Date(NOW.getTime() - TTL_MS)
    );

    const result = await pendingChunkSweepService.runPendingChunkSweep(
      NOW,
      TTL_HOURS,
      organizationId
    );

    // The window is half-open: `lt`, not `lte`. A row exactly at the cutoff has
    // not yet outlived the TTL. Nothing else in this suite distinguishes the
    // two — every other fixture sits a minute clear of the boundary.
    expect(result.cleared).toBe(0);
    expect(await readMarker(atCutoff)).toEqual(STAGED_MARKER);
  });

  it("leaves another organization's orphan untouched when scoped", async () => {
    const sweptOrg = await tracker.create();
    const sparedOrg = await tracker.create();
    const sweptUser = await createTestUser(sweptOrg);
    const sparedUser = await createTestUser(sparedOrg);
    const swept = await seedStagedSequence(
      sweptOrg,
      sweptUser.id,
      "swept",
      JUST_OUTSIDE_TTL
    );
    // A live sequence in the SWEPT org, so this case constrains the age
    // predicate too. Without it the org filter alone satisfies every assertion
    // and dropping `lastSyncedAt: { lt: cutoff }` would leave the case green.
    const sweptOrgLive = await seedStagedSequence(
      sweptOrg,
      sweptUser.id,
      "swept-org-live",
      JUST_INSIDE_TTL
    );
    const spared = await seedStagedSequence(
      sparedOrg,
      sparedUser.id,
      "spared",
      JUST_OUTSIDE_TTL
    );

    const result = await pendingChunkSweepService.runPendingChunkSweep(
      NOW,
      TTL_HOURS,
      sweptOrg
    );

    expect(result.cleared).toBe(1);
    expect(await readMarker(swept)).toEqual(CLEARED_MARKER);
    expect(await readMarker(sweptOrgLive)).toEqual(STAGED_MARKER);
    expect(await readMarker(spared)).toEqual(STAGED_MARKER);
  });

  it("spares a sequence whose next chunk lands between the select and the update", async () => {
    const organizationId = await tracker.create();
    const user = await createTestUser(organizationId);
    const resuming = await seedStagedSequence(
      organizationId,
      user.id,
      "resuming",
      JUST_OUTSIDE_TTL
    );
    const cutoff = new Date(NOW.getTime() - TTL_MS);

    const [candidate] = await withDb((db) =>
      selectOrphanedChunkMarkerCandidates(db, cutoff, organizationId)
    );
    // A chunk of the staged sequence commits between the page read and the
    // clear — the one window the per-session lock does NOT cover, because the
    // page read takes no lock. Under READ COMMITTED the UPDATE sees the
    // refreshed `lastSyncedAt`, so the executed predicate, not the captured id,
    // is what has to spare the row.
    await withDb((db) =>
      db.sessionDetail.update({
        where: { artifactId: resuming },
        data: { lastSyncedAt: NOW, pendingChunkReceived: 2 },
        select: { artifactId: true },
      })
    );

    const outcome = await withDb.tx((tx) =>
      clearOrphanedChunkMarker(
        tx,
        candidate as NonNullable<typeof candidate>,
        cutoff,
        organizationId
      )
    );

    expect(outcome).toBe("spared");
    expect(await readMarker(resuming)).toEqual({
      ...STAGED_MARKER,
      pendingChunkReceived: 2,
    });
  });

  it("leaves the marker whole when an apply holds the session mid-sequence", async () => {
    const organizationId = await tracker.create();
    const user = await createTestUser(organizationId);
    const contended = await seedStagedSequence(
      organizationId,
      user.id,
      "contended",
      JUST_OUTSIDE_TTL
    );
    const externalSessionId = await readExternalSessionId(contended);

    // ISS-8602 (review: whitlockk). The strand-producing order, on two real
    // connections. An interior-chunk apply takes the per-session advisory lock
    // and has ALREADY read the staged marker; its patch writes
    // `pendingChunkReceived` ALONE. If the sweep clears the triple in that
    // window, the apply's commit lands that count beside a NULL revision and
    // total — the half-marker `schema.prisma` forbids, and one this sweep can
    // never reap again because its own predicate needs a non-NULL revision.
    const applyHoldsLock = createDeferred();
    const sweepFinished = createDeferred();
    const apply = withDb.tx(
      async (tx) => {
        await acquireSessionAdvisoryLocks(
          tx,
          externalSessionId,
          IndexKeyOrigin.Wire
        );
        applyHoldsLock.resolve();
        await sweepFinished.promise;
        await tx.sessionDetail.update({
          where: { artifactId: contended },
          data: { lastSyncedAt: NOW, pendingChunkReceived: 2 },
          select: { artifactId: true },
        });
      },
      { timeout: HOLDER_TRANSACTION_TIMEOUT_MS }
    );

    let result: Awaited<
      ReturnType<typeof pendingChunkSweepService.runPendingChunkSweep>
    >;
    try {
      await applyHoldsLock.promise;
      result = await pendingChunkSweepService.runPendingChunkSweep(
        NOW,
        TTL_HOURS,
        organizationId
      );
    } finally {
      sweepFinished.resolve();
      await apply;
    }

    // Whole, not half: the apply's interior patch advanced the received count
    // and both identity columns still stand. Asserted FIRST so a regression
    // shows the stranded marker itself rather than only the count that led to
    // it.
    expect(await readMarker(contended)).toEqual({
      ...STAGED_MARKER,
      pendingChunkReceived: 2,
    });
    // The sweep refused the candidate rather than racing it.
    expect(result.cleared).toBe(0);
    expect(result.exitCode).toBe(0);
  });
});

function seedStagedSequence(
  organizationId: string,
  userId: string,
  label: string,
  lastSyncedAt: Date,
  ackContract: string | null = ROW_LEVEL_BAND
): Promise<string> {
  return createTestSessionDetail({
    organizationId,
    userId,
    label,
    lastSyncedAt,
    cost: { ...STAGED_MARKER, pendingChunkAckContract: ackContract },
  });
}

/**
 * How long the stand-in apply may hold the session lock open.
 *
 * STRICTLY UNDER the tier's own `testTimeout` (30s in
 * `vitest.config.integration.mts`), which `integration-suite-timeout-budget.test.ts`
 * enforces (ISS-8542) and which this bound previously sat exactly on. Equal is
 * the detached-transaction race itself, not a near miss: Prisma arms a
 * transaction's clock after BEGIN and Vitest arms the test's before it, so at
 * equal values the test fails first and leaves this transaction running detached
 * — holding both a pooled connection and the session advisory lock, and naming
 * nothing.
 *
 * 10s is sized against the work it has to outlast rather than against the tier
 * bound: the holder waits for ONE `runPendingChunkSweep` over a single
 * organization whose whole population is this test's one contended row — a
 * select, a refused `pg_try_advisory_xact_lock`, and a count. That is
 * sub-second on a warm database, so this leaves roughly an order of magnitude of
 * headroom, and an overrun now fails inside the tier naming this test instead of
 * outlasting the job.
 */
const HOLDER_TRANSACTION_TIMEOUT_MS = 10_000;

function createDeferred() {
  let resolve: () => void = () => {
    // Replaced synchronously by the Promise executor below.
  };
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function readExternalSessionId(artifactId: string): Promise<string> {
  return withDb(async (db) => {
    const row = await db.sessionDetail.findUniqueOrThrow({
      where: { artifactId },
      select: { externalSessionId: true },
    });
    return row.externalSessionId;
  });
}

/**
 * The gating input for the NEXT chunk of the staged sequence, built from the
 * row as it stands after the sweep.
 *
 * Chunk 1 of 3 at revision 42 is the interior tail of `STAGED_MARKER` — the
 * delivery whose patch writes `pendingChunkReceived` alone, and the one whose
 * refusal costs a whole-batch producer the tail it has already deleted. Every
 * `existing*` value is READ, never restated, so a marker the sweep cleared and
 * one it declined produce different decisions here rather than the same one.
 */
async function resumedTailGatingInput(
  artifactId: string
): Promise<ChunkGatingInput> {
  const row = await withDb((db) =>
    db.sessionDetail.findUniqueOrThrow({
      where: { artifactId },
      select: {
        dataRevision: true,
        pendingChunkRevision: true,
        pendingChunkTotal: true,
        pendingChunkReceived: true,
      },
    })
  );
  return {
    incomingRevision: STAGED_MARKER.pendingChunkRevision,
    chunk: { index: 1, total: STAGED_MARKER.pendingChunkTotal },
    existingRevision: row.dataRevision,
    existingPendingRevision: row.pendingChunkRevision,
    existingPendingTotal: row.pendingChunkTotal,
    existingPendingReceived: row.pendingChunkReceived,
  };
}

async function readMarker(artifactId: string) {
  return await withDb((db) =>
    db.sessionDetail.findUniqueOrThrow({
      where: { artifactId },
      select: {
        pendingChunkRevision: true,
        pendingChunkTotal: true,
        pendingChunkReceived: true,
        // ISS-8602: without this column in the projection, a clear that left the
        // band behind — or a stage that never wrote one — reads as correct.
        pendingChunkAckContract: true,
      },
    })
  );
}
