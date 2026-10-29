/**
 * ISS-8330: `upsertSessionsBatch` must report the usage buckets it DROPPED for
 * overflowing `int4` ONCE PER REQUEST, never once per session.
 *
 * The drop itself is proved in `component-usage-merge-overflow.test.ts`. What this file owns is the
 * amplification bound `apps/api/AGENTS.md` ("Emission and Abuse Control")
 * requires: the overflow is deterministic, so the desktop re-sends it on every
 * retry, and `sessions` carries no `.max()`
 * (`lib/desktop-agent-sessions-schema.ts:892`) — so a per-slice emission scales
 * one warn and one metric with an authenticated caller's payload size.
 *
 * A sibling file rather than another block in `upsert-sessions-batch.test.ts`,
 * which is at the 1,000-line ceiling, for the same reason
 * `upsert-sessions-batch-index-keys.test.ts` is.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { SessionSyncMetric } from "./session-sync-metrics";
import { upsertSessionsBatch } from "./upsert-sessions-batch";
import { MAX_DROPPED_USAGE_KEYS_PER_SYNC_REQUEST } from "./upsert-sessions-batch-drop-tallies";

const ORGANIZATION_ID = "org-batch-usage-drops";
const CONTEXT = {
  organizationId: ORGANIZATION_ID,
  userId: "user-batch-usage-drops",
  computeTargetId: "target-batch-usage-drops",
};

function buildPayload(sessionCount: number) {
  return {
    sessions: Array.from({ length: sessionCount }, (_, index) => ({
      externalSessionId: `ext-${index}`,
    })),
    wantsAcceptedSessionIds: true,
  };
}

/** Every slice reports the same dropped component keys. */
function dropPerSlice(componentKeys: readonly string[]) {
  mocks.upsertSessionSlice.mockImplementation(() => ({
    persisted: true,
    observedRepositoryFullNames: [],
    indexKeyProjections: 0,
    droppedOverflowUsageBuckets: [...componentKeys],
  }));
}

function dropEmissions() {
  return mocks.emitTelemetryMetric.mock.calls
    .map(([arg]) => arg)
    .filter(
      (arg) => arg?.metric === SessionSyncMetric.UsageCountOverflowDropped
    );
}

function dropWarnings() {
  return mocks.logWarn.mock.calls.filter(
    ([message]) =>
      message === "Dropped component usage buckets that overflowed int4"
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withDb.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({
      computeTarget: {
        findFirst: async () => ({ id: CONTEXT.computeTargetId }),
      },
    })
  );
  mocks.withDb.tx.mockImplementation((fn: (tx: unknown) => unknown) => fn({}));
  mocks.recordObservedRepositories.mockResolvedValue(undefined);
});

describe("upsertSessionsBatch — dropped usage buckets are reported once (ISS-8330)", () => {
  it("emits ONE metric and ONE warn for the whole batch, carrying its total", async () => {
    dropPerSlice(["deploy", "review"]);

    await upsertSessionsBatch(CONTEXT, buildPayload(4) as never);

    // Four sessions × two dropped buckets. The bound this test exists for is
    // the ARITY, not the count: eight per-slice emissions would satisfy any
    // assertion on the total alone.
    expect(dropEmissions()).toEqual([
      {
        metric: SessionSyncMetric.UsageCountOverflowDropped,
        organizationId: ORGANIZATION_ID,
        computeTargetId: CONTEXT.computeTargetId,
        count: 8,
      },
    ]);
    expect(dropWarnings()).toHaveLength(1);
  });

  it("names the distinct component buckets that were dropped", async () => {
    // The key is the actionable detail — which component went missing —
    // and it is deduped, so four sessions naming the same bucket are one name.
    dropPerSlice(["deploy", "deploy"]);

    await upsertSessionsBatch(CONTEXT, buildPayload(4) as never);

    expect(dropWarnings()[0][1]).toEqual(
      expect.objectContaining({
        componentKeys: ["deploy"],
        computeTargetId: CONTEXT.computeTargetId,
        organizationId: ORGANIZATION_ID,
        droppedCount: 8,
      })
    );
  });

  it("caps the NAMES it logs without understating the count", async () => {
    // `componentKey` arrives from the wire, so the distinct-key list is itself
    // caller-driven. The cap must turn the excess into a number rather than
    // more log — a cap that also truncated `droppedCount` would report fewer
    // missing buckets than actually went missing.
    const overCap = MAX_DROPPED_USAGE_KEYS_PER_SYNC_REQUEST + 5;
    dropPerSlice(
      Array.from({ length: overCap }, (_, index) => `component-${index}`)
    );

    await upsertSessionsBatch(CONTEXT, buildPayload(1) as never);

    expect(dropWarnings()[0][1].componentKeys).toHaveLength(
      MAX_DROPPED_USAGE_KEYS_PER_SYNC_REQUEST
    );
    expect(dropEmissions()[0].count).toBe(overCap);
  });

  it("stays silent when nothing was dropped, so the count cannot measure traffic", async () => {
    dropPerSlice([]);

    await upsertSessionsBatch(CONTEXT, buildPayload(3) as never);

    expect(dropEmissions()).toEqual([]);
    expect(dropWarnings()).toEqual([]);
  });

  it("still reports what a partially-failed batch already dropped", async () => {
    // The report sits in the `finally` for the same reason its neighbours do:
    // the slices that committed dropped those buckets, and a report
    // keyed on a clean batch would go quiet on exactly the payloads worth
    // seeing.
    mocks.upsertSessionSlice.mockImplementation(
      (_tx: unknown, input: { session: { externalSessionId: string } }) => {
        if (input.session.externalSessionId === "ext-2") {
          throw new Error("slice exploded");
        }
        return {
          persisted: true,
          observedRepositoryFullNames: [],
          indexKeyProjections: 0,
          droppedOverflowUsageBuckets: ["deploy"],
        };
      }
    );

    await upsertSessionsBatch(CONTEXT, buildPayload(3) as never);

    expect(dropEmissions()).toEqual([
      expect.objectContaining({
        metric: SessionSyncMetric.UsageCountOverflowDropped,
        count: 2,
      }),
    ]);
  });

  it("treats an outcome that omits the field as nothing dropped", async () => {
    // `droppedOverflowUsageBuckets` is optional so partial fixtures and older
    // outcome shapes read as "nothing dropped" rather than throwing in the fold.
    mocks.upsertSessionSlice.mockImplementation(() => ({
      persisted: true,
      observedRepositoryFullNames: [],
      indexKeyProjections: 0,
    }));

    await upsertSessionsBatch(CONTEXT, buildPayload(2) as never);

    expect(dropEmissions()).toEqual([]);
  });
});
