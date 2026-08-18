/**
 * FEA-1718, thread 4 (wongk): a back-link failure must NOT abort the ingest of
 * the sessions queued behind it in a version-skewed multi-session payload.
 *
 * This is the throwing case specifically. The sibling integration suite covers a
 * claim that merely matches no rows, which is benign and cannot prove anything
 * about propagation; a genuine transient failure cannot be forced against a real
 * Postgres on demand, so it is injected here and driven through the REAL
 * `upsertSessionsBatch` — the production caller — rather than through the helper
 * in isolation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(
    vi.fn((fn: (db: unknown) => unknown) => fn({})),
    { tx: vi.fn() }
  ),
  emitTelemetryMetric: vi.fn(),
  linkLoopSessionArtifact: vi.fn(),
  upsertSessionSlice: vi.fn(),
  stampIngestSyncWatermark: vi.fn(),
  stampIngestWatermarkAfterFailedBatch: vi.fn(),
}));

vi.mock("@repo/database", () => ({ withDb: mocks.withDb }));
vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mocks.emitTelemetryMetric,
}));
vi.mock("./loop-session-backlink", () => ({
  linkLoopSessionArtifact: mocks.linkLoopSessionArtifact,
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
    loopProjectById: new Map(),
    sameOrgLoopIds: new Set(),
  }),
}));
vi.mock("./artifact-links/slug-links", () => ({
  resolveArtifactSlugMap: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("@/app/settings/frustration-setting-service", () => ({
  frustrationSettingService: { isFrustrationEnabled: async () => false },
}));

import { SessionSyncMetric } from "./session-sync-metrics";
import { upsertSessionsBatch } from "./upsert-sessions-batch";

const ORGANIZATION_ID = "org-batch-1";
const CONTEXT = {
  organizationId: ORGANIZATION_ID,
  userId: "user-batch-1",
  computeTargetId: "target-batch-1",
};

function buildBacklink(loopId: string) {
  return {
    loopId,
    organizationId: ORGANIZATION_ID,
    sessionArtifactId: `artifact-${loopId}`,
  };
}

function buildPayload(sessionCount: number) {
  return {
    sessions: Array.from({ length: sessionCount }, (_, index) => ({
      externalSessionId: `ext-${index}`,
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withDb.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({ computeTarget: { findFirst: async () => ({ id: "target-batch-1" }) } })
  );
  mocks.withDb.tx.mockImplementation((fn: (tx: unknown) => unknown) => fn({}));
  mocks.upsertSessionSlice.mockImplementation(
    (_tx: unknown, input: { session: { externalSessionId: string } }) => ({
      loopBacklink: buildBacklink(input.session.externalSessionId),
      persisted: true,
    })
  );
  mocks.linkLoopSessionArtifact.mockResolvedValue(true);
});

describe("upsertSessionsBatch — back-link failure isolation", () => {
  it("ingests every session when the first back-link throws", async () => {
    mocks.linkLoopSessionArtifact
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValue(true);

    // Goal stage 2: a dropped back-link is a DERIVED edge, so it must not
    // remove its session from the ack echo — the row is already durable, and
    // withholding its id would strand the desktop's outbox entry forever.
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: partial payload fixture
      upsertSessionsBatch(CONTEXT, buildPayload(3) as any)
    ).resolves.toEqual({ persistedSessionIds: ["ext-0", "ext-1", "ext-2"] });

    // The decisive assertion: sessions 2 and 3 still reached the slice. Before
    // the fix the throw escaped the loop and they were never ingested.
    expect(mocks.upsertSessionSlice).toHaveBeenCalledTimes(3);
    expect(mocks.stampIngestSyncWatermark).toHaveBeenCalledTimes(1);
  });

  it("counts the dropped back-link rather than absorbing it silently", async () => {
    mocks.linkLoopSessionArtifact.mockRejectedValue(
      new Error("db unavailable")
    );

    // biome-ignore lint/suspicious/noExplicitAny: partial payload fixture
    await upsertSessionsBatch(CONTEXT, buildPayload(2) as any);

    expect(mocks.emitTelemetryMetric).toHaveBeenCalledTimes(2);
    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith({
      metric: SessionSyncMetric.LoopSessionBacklinkFailed,
      organizationId: ORGANIZATION_ID,
      count: 1,
    });
  });

  it("emits nothing when every back-link applies", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: partial payload fixture
    await upsertSessionsBatch(CONTEXT, buildPayload(2) as any);

    expect(mocks.emitTelemetryMetric).not.toHaveBeenCalled();
    expect(mocks.linkLoopSessionArtifact).toHaveBeenCalledTimes(2);
  });

  it("skips the claim entirely for a session that names no loop", async () => {
    mocks.upsertSessionSlice.mockReturnValue({
      loopBacklink: null,
      persisted: true,
    });

    // biome-ignore lint/suspicious/noExplicitAny: partial payload fixture
    await upsertSessionsBatch(CONTEXT, buildPayload(2) as any);

    expect(mocks.linkLoopSessionArtifact).not.toHaveBeenCalled();
  });
});
