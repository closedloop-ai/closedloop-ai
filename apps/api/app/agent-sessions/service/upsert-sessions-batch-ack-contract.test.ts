/**
 * The BATCH-LEVEL ROW-LEVEL-ACK CONTRACT: who speaks it, and what it licenses.
 *
 * Split out of `upsert-sessions-batch.test.ts` by ISS-8622, which pushed that
 * file past the 1,000-line ceiling. The seam is a real one rather than a line
 * count: both blocks below turn on `payload.wantsAcceptedSessionIds` and on
 * nothing else. ISS-8271 owns what the flag's PRESENCE licenses — a partial
 * result the desktop can read, hence a hold instead of a rejection — and
 * ISS-8622 owns counting its ABSENCE, which is the evidence PRD-699 §8.3's next
 * narrowing step is gated on. Everything else about the batch (slice isolation,
 * back-links, discovery, tiling strips) stays in the original file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(
    vi.fn((fn: (db: unknown) => unknown) => fn({})),
    { tx: vi.fn() }
  ),
  emitTelemetryMetric: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  recordObservedRepositories: vi.fn(),
  upsertSessionSlice: vi.fn(),
  stampIngestSyncWatermark: vi.fn(),
  stampIngestWatermarkAfterFailedBatch: vi.fn(),
}));

vi.mock("@repo/database", () => ({ withDb: mocks.withDb }));
vi.mock("@repo/observability/log", () => ({
  log: { error: mocks.logError, warn: mocks.logWarn },
}));
vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mocks.emitTelemetryMetric,
}));
vi.mock("@/lib/github/observed-repository-store", () => ({
  recordObservedRepositories: mocks.recordObservedRepositories,
}));
vi.mock("./upsert-session-slice", () => ({
  upsertSessionSlice: mocks.upsertSessionSlice,
}));
vi.mock("./ingest-sync-stamp", () => ({
  stampIngestSyncWatermark: mocks.stampIngestSyncWatermark,
  stampIngestWatermarkAfterFailedBatch:
    mocks.stampIngestWatermarkAfterFailedBatch,
}));
vi.mock("./project-resolution", () => ({
  resolveProjectResolution: vi.fn().mockResolvedValue({
    artifactProjectById: new Map(),
  }),
}));
vi.mock("./artifact-links/slug-links", () => ({
  resolveArtifactSlugMap: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("@/app/settings/frustration-setting-service", () => ({
  frustrationSettingService: { isFrustrationEnabled: async () => false },
}));

import {
  buildBatch,
  buildPayload,
  buildRowLevelAckPayload,
  buildSession,
} from "@/__tests__/support/agent-sessions/upsert-sessions-batch.test-fixtures";
import { HeldRevisionRequiresRowLevelAckError } from "@/lib/desktop-agent-sessions-errors";
import { EmissionRollupCause } from "@/lib/observability/fixed-window-emission-throttle";
import { legacyAckContractThrottle } from "./row-level-ack-contract-telemetry";
import { SessionSyncMetric } from "./session-sync-metrics";
import { upsertSessionsBatch } from "./upsert-sessions-batch";
import {
  SessionGateHoldReason,
  WireDataRevisionSkipReason,
} from "./wire-data-revision";

const ORGANIZATION_ID = "org-batch-ack-1";
const CONTEXT = {
  organizationId: ORGANIZATION_ID,
  userId: "user-batch-ack-1",
  computeTargetId: "target-batch-ack-1",
};

/**
 * The throttle is module-level state with a process lifetime, so a case that
 * emitted for this (org, target) would silence the NEXT case's first
 * occurrence — a pass that depends on file order. Reset by name; `clearAllMocks`
 * does not reach it.
 */
beforeEach(() => {
  vi.clearAllMocks();
  legacyAckContractThrottle.clear();
  mocks.withDb.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({
      computeTarget: {
        findFirst: async () => ({ id: CONTEXT.computeTargetId }),
      },
    })
  );
  mocks.withDb.tx.mockImplementation((fn: (tx: unknown) => unknown) => fn({}));
  mocks.upsertSessionSlice.mockImplementation(
    (_tx: unknown, _input: { session: { externalSessionId: string } }) => ({
      persisted: true,
      observedRepositoryFullNames: [],
      indexKeyProjections: 0,
    })
  );
  mocks.recordObservedRepositories.mockResolvedValue(undefined);
});

/**
 * ISS-8271 (cr-15119): the revision-hold contract at the batch boundary — the
 * one aggregated `sentinel_revision_held` emission, and the up-front rejection
 * of a batch that cannot read the partial ack a hold depends on.
 */
describe("upsertSessionsBatch — held-revision handling (ISS-8271)", () => {
  it("aggregates held slices into ONE emission per reason carrying the batch count", async () => {
    mocks.upsertSessionSlice.mockImplementation(() => ({
      persisted: false,
      observedRepositoryFullNames: [],
      indexKeyProjections: 0,
      heldRevisionReason: WireDataRevisionSkipReason.RevisionPending,
    }));

    await expect(
      upsertSessionsBatch(CONTEXT, buildRowLevelAckPayload(3))
    ).resolves.toEqual({ persistedSessionIds: [] });

    // Three held rows, one emission — per-row emission on this deliberately
    // retried path is the caller-drivable amplification whitlockk's #6120 review
    // rejected.
    const heldEmissions = mocks.emitTelemetryMetric.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter(
        (metric) => metric.metric === SessionSyncMetric.SentinelRevisionHeld
      );
    expect(heldEmissions).toEqual([
      expect.objectContaining({
        reason: WireDataRevisionSkipReason.RevisionPending,
        count: 3,
      }),
    ]);
  });

  // ISS-8131: the gate's hold rides the SAME aggregate emission as the wire
  // dispositions, so its reason needs its own pin. The integration suites prove
  // the BEHAVIOUR (empty echo, marker intact, clean commit); none of them
  // observes the metric, so without this a refactor could return the hold with
  // a null reason, behave identically, and silently drop the series that tells
  // us in prod whether this hold ever loops.
  it("carries the gate's sequence_assembling reason into that same emission", async () => {
    mocks.upsertSessionSlice.mockImplementation(() => ({
      persisted: false,
      observedRepositoryFullNames: [],
      indexKeyProjections: 0,
      heldRevisionReason: SessionGateHoldReason.SequenceAssembling,
    }));

    await expect(
      upsertSessionsBatch(CONTEXT, buildRowLevelAckPayload(2))
    ).resolves.toEqual({ persistedSessionIds: [] });

    const heldEmissions = mocks.emitTelemetryMetric.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter(
        (metric) => metric.metric === SessionSyncMetric.SentinelRevisionHeld
      );
    expect(heldEmissions).toEqual([
      expect.objectContaining({
        reason: SessionGateHoldReason.SequenceAssembling,
        count: 2,
      }),
    ]);
  });

  it("emits nothing when no slice was held", async () => {
    await upsertSessionsBatch(CONTEXT, buildRowLevelAckPayload(2));
    expect(mocks.emitTelemetryMetric).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.SentinelRevisionHeld,
      })
    );
  });

  it("rejects a batch that cannot express a hold before any slice commits", async () => {
    // No `wantsAcceptedSessionIds` + a session the apply would hold: a 200
    // would ack-clear an outbox row the server never wrote (silent loss on
    // pre-#4862 builds). The rejection restores their pre-ISS-8271 contract.
    const payload = buildBatch([
      buildSession({ externalSessionId: "ext-0" }),
      buildSession({ externalSessionId: "ext-1", dataRevision: -1 }),
    ]);

    await expect(upsertSessionsBatch(CONTEXT, payload)).rejects.toBeInstanceOf(
      HeldRevisionRequiresRowLevelAckError
    );
    expect(mocks.upsertSessionSlice).not.toHaveBeenCalled();
    // ISS-8622: the rejection throws OUTSIDE the batch `try`, so a counter in
    // the `finally` would miss exactly this request — a legacy build whose
    // payload the server refuses. Pins the emission ahead of the assertion.
    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.RowLevelAckNotRequested,
      })
    );
  });

  it("keeps the hold (no rejection) for an opted-in batch carrying a sentinel", async () => {
    const payload = buildBatch(
      [buildSession({ externalSessionId: "ext-0", dataRevision: -1 })],
      { wantsAcceptedSessionIds: true }
    );

    await expect(upsertSessionsBatch(CONTEXT, payload)).resolves.toBeTruthy();
    expect(mocks.upsertSessionSlice).toHaveBeenCalledTimes(1);
  });
});

/**
 * ISS-8622 (PRD-699 §8.3): the fleet-upgrade evidence that gates the next
 * narrowing step — the server REQUIRING `wantsAcceptedSessionIds`. Its whole
 * value is that it distinguishes the two wire shapes, so both are pinned here.
 */
describe("upsertSessionsBatch — legacy ack-contract counter", () => {
  it("counts a request that arrived without wantsAcceptedSessionIds", async () => {
    await upsertSessionsBatch(CONTEXT, buildPayload(3));

    const legacyShapeEmissions = mocks.emitTelemetryMetric.mock.calls
      .map((call) => call[0])
      .filter(
        (arg) => arg?.metric === SessionSyncMetric.RowLevelAckNotRequested
      );
    // Never once per session: the three-session fixture would read as three
    // under a per-row emission. What bounds REPEATS of this request is the
    // window, pinned in the sibling block below.
    expect(legacyShapeEmissions).toEqual([
      {
        metric: SessionSyncMetric.RowLevelAckNotRequested,
        organizationId: ORGANIZATION_ID,
        computeTargetId: CONTEXT.computeTargetId,
        count: 1,
        sessionCount: 3,
      },
    ]);
  });

  it("counts nothing when the request opted into the row-level ack", async () => {
    // The counterfactual for the case above: same batch, flag set. Deleting the
    // `rowLevelAck` guard in `reportRowLevelAckNotRequested` fails here.
    await upsertSessionsBatch(CONTEXT, buildRowLevelAckPayload(3));

    expect(mocks.emitTelemetryMetric).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.RowLevelAckNotRequested,
      })
    );
  });
});

/**
 * #7410 review (whitlockk, tamsinb): the BOUND on that counter. A legacy build is
 * legacy on every pass, so per-request is the amplification `apps/api/AGENTS.md`
 * ("Emission and Abuse Control") forbids — and the docstring's distinct-target
 * reading is a property of the (org, target) window rather than an instruction
 * a dashboard has to obey. Both halves are pinned here: that a repeat inside the
 * window does NOT emit, and that the rollup carries it.
 */
describe("upsertSessionsBatch — legacy ack-contract emission bound", () => {
  // Unconditional: a throw between the install and a per-case restore would
  // leak a frozen clock into every later case in this worker.
  afterEach(() => {
    vi.useRealTimers();
  });

  function legacyEmissions() {
    return mocks.emitTelemetryMetric.mock.calls
      .map((call) => call[0])
      .filter(
        (arg) => arg?.metric === SessionSyncMetric.RowLevelAckNotRequested
      );
  }

  async function syncLegacyBatch(
    context: typeof CONTEXT,
    sessionCount: number
  ) {
    await upsertSessionsBatch(context, buildPayload(sessionCount));
  }

  it("emits once for a target however fast it re-syncs inside one window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T00:00:00.000Z"));

    await syncLegacyBatch(CONTEXT, 3);
    // A busy legacy target ticks every ~5s; the route's limiter would permit
    // 120/min. Three passes well inside the 60s window.
    vi.setSystemTime(new Date("2026-09-16T00:00:05.000Z"));
    await syncLegacyBatch(CONTEXT, 3);
    vi.setSystemTime(new Date("2026-09-16T00:00:10.000Z"));
    await syncLegacyBatch(CONTEXT, 3);

    // THE SUPPRESSION, not merely that the first one fired: remove the throttle
    // and this reads three.
    expect(legacyEmissions()).toEqual([
      {
        metric: SessionSyncMetric.RowLevelAckNotRequested,
        organizationId: ORGANIZATION_ID,
        computeTargetId: CONTEXT.computeTargetId,
        count: 1,
        sessionCount: 3,
      },
    ]);
  });

  it("folds the suppressed re-syncs into an aggregated rollup at the next window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T00:00:00.000Z"));

    await syncLegacyBatch(CONTEXT, 3);
    vi.setSystemTime(new Date("2026-09-16T00:00:05.000Z"));
    await syncLegacyBatch(CONTEXT, 3);
    vi.setSystemTime(new Date("2026-09-16T00:00:10.000Z"));
    await syncLegacyBatch(CONTEXT, 3);

    // Past the 60s window: this pass rolls it over and materialises the two it
    // suppressed. Nothing else can — the count is materialised by an event,
    // never a clock.
    vi.setSystemTime(new Date("2026-09-16T00:01:30.000Z"));
    await syncLegacyBatch(CONTEXT, 7);

    expect(legacyEmissions()).toEqual([
      {
        metric: SessionSyncMetric.RowLevelAckNotRequested,
        organizationId: ORGANIZATION_ID,
        computeTargetId: CONTEXT.computeTargetId,
        count: 1,
        sessionCount: 3,
      },
      // The rollup carries the SUPPRESSED count, so nothing is lost — under
      // `occurrences`, never `count`, so summing `count` stays the
      // distinct-target reading. It omits `sessionCount`, which has no meaning
      // summed across re-sends of the same sessions.
      {
        metric: SessionSyncMetric.RowLevelAckNotRequested,
        organizationId: ORGANIZATION_ID,
        computeTargetId: CONTEXT.computeTargetId,
        occurrences: 2,
        aggregated: true,
        flushedBy: EmissionRollupCause.Window,
      },
      {
        metric: SessionSyncMetric.RowLevelAckNotRequested,
        organizationId: ORGANIZATION_ID,
        computeTargetId: CONTEXT.computeTargetId,
        count: 1,
        sessionCount: 7,
      },
    ]);
  });

  it("windows per compute target, so counting first occurrences is the distinct-target reading", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T00:00:00.000Z"));
    const secondTarget = { ...CONTEXT, computeTargetId: "target-batch-ack-2" };

    await syncLegacyBatch(CONTEXT, 1);
    await syncLegacyBatch(CONTEXT, 1);
    await syncLegacyBatch(secondTarget, 1);
    await syncLegacyBatch(secondTarget, 1);

    // Four legacy requests, two legacy targets. What the dashboard counts is the
    // non-rollup records, and it reads 2 — keying the window on the org alone
    // would report 1 and hide a target.
    const firstOccurrences = legacyEmissions().filter(
      (emission) => emission.aggregated !== true
    );
    expect(
      firstOccurrences.map((emission) => emission.computeTargetId)
    ).toEqual([CONTEXT.computeTargetId, secondTarget.computeTargetId]);
  });
});
