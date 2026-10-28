/**
 * ISS-8069: `upsertSessionsBatch` must REPORT the index keys it had to project
 * before writing, once per batch.
 *
 * A sibling file rather than another block in `upsert-sessions-batch.test.ts`,
 * which is at the 1,000-line ceiling — the report is its own concern and adding
 * to that file would have pushed it over.
 *
 * The projection itself is proved against a real Postgres in
 * `__tests__/integration/index-key-poison-batch.integration.test.ts`; a mocked
 * `upsert` accepts any string, so nothing here could establish it. What this
 * file owns is the accepted-loss REPORT: a bound key is a lossy coercion, and
 * the repo rule is that such a coercion goes to a monitor instead of being
 * absorbed.
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

import {
  buildPayload,
  buildRowLevelAckPayload,
} from "@/__tests__/support/agent-sessions/upsert-sessions-batch.test-fixtures";
import { INDEX_KEY_PROJECTED_METRIC } from "@/lib/index-key-projection";
import { sessionBatchIndexKeyProjectionGate } from "./session-batch-index-key-telemetry";
import { upsertSessionsBatch } from "./upsert-sessions-batch";

const ORGANIZATION_ID = "org-batch-index-keys";
const CONTEXT = {
  organizationId: ORGANIZATION_ID,
  userId: "user-batch-index-keys",
  computeTargetId: "target-batch-index-keys",
};

beforeEach(() => {
  vi.clearAllMocks();
  // ISS-8255: the report is now bounded per (org, reason), and that gate is a
  // module-level latch. Without this reset the first case would spend the
  // window and every later one would assert against a suppressed emission.
  sessionBatchIndexKeyProjectionGate.clear();
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

describe("upsertSessionsBatch — projected index keys are reported (ISS-8069)", () => {
  /** Every slice reports `count` index keys it had to project before writing. */
  function projectIndexKeysPerSlice(count: number) {
    mocks.upsertSessionSlice.mockImplementation(
      (_tx: unknown, _input: { session: { externalSessionId: string } }) => ({
        persisted: true,
        observedRepositoryFullNames: [],
        indexKeyProjections: count,
      })
    );
  }

  function indexKeyEmissions() {
    return mocks.emitTelemetryMetric.mock.calls
      .map(([arg]) => arg)
      .filter((arg) => arg?.metric === INDEX_KEY_PROJECTED_METRIC);
  }

  it("emits ONE batch-level event carrying the batch's total, not one per session", async () => {
    projectIndexKeysPerSlice(2);

    await upsertSessionsBatch(CONTEXT, buildPayload(3));

    // A bound index key is an accepted, LOSSY coercion, so it goes to a monitor
    // rather than being absorbed. One emission for three sessions: a 200-session
    // payload must not become 200 events.
    expect(indexKeyEmissions()).toEqual([
      {
        metric: INDEX_KEY_PROJECTED_METRIC,
        organizationId: ORGANIZATION_ID,
        computeTargetId: CONTEXT.computeTargetId,
        count: 6,
      },
    ]);
  });

  it("stays silent when nothing was projected, so the count cannot measure traffic", async () => {
    projectIndexKeysPerSlice(0);

    await upsertSessionsBatch(CONTEXT, buildPayload(3));

    expect(indexKeyEmissions()).toEqual([]);
  });

  it("still reports the keys a partially-failed batch already projected", async () => {
    // The positive sibling of the silence case, on the path that matters most:
    // the slices that committed WROTE those projected keys, and a report keyed
    // only on a clean batch would go quiet on exactly the payloads worth seeing.
    mocks.upsertSessionSlice.mockImplementation(
      (_tx: unknown, input: { session: { externalSessionId: string } }) => {
        if (input.session.externalSessionId === "ext-2") {
          throw new Error("slice exploded");
        }
        return {
          persisted: true,
          observedRepositoryFullNames: [],
          indexKeyProjections: 1,
        };
      }
    );

    await upsertSessionsBatch(CONTEXT, buildRowLevelAckPayload(3));

    expect(indexKeyEmissions()).toEqual([
      expect.objectContaining({
        metric: INDEX_KEY_PROJECTED_METRIC,
        count: 2,
      }),
    ]);
  });

  it("suppresses the replay of the same (org, compute target) inside the window", async () => {
    projectIndexKeysPerSlice(2);

    await upsertSessionsBatch(CONTEXT, buildPayload(3));
    await upsertSessionsBatch(CONTEXT, buildPayload(3));
    await upsertSessionsBatch(CONTEXT, buildPayload(3));

    // ISS-8255 (#7213 review, whitlockk): one emission per BATCH bounds this by
    // payload size, not by request rate — the desktop drives the rate and an
    // over-budget key is permanent, so the same batch re-declares the same
    // projection on every re-sync. Deleting the gate call makes this three.
    expect(indexKeyEmissions()).toHaveLength(1);
  });

  it("never suppresses a first occurrence from another tenant", async () => {
    projectIndexKeysPerSlice(2);

    await upsertSessionsBatch(CONTEXT, buildPayload(3));
    await upsertSessionsBatch(
      { ...CONTEXT, organizationId: `${ORGANIZATION_ID}-other` },
      buildPayload(3)
    );

    // The positive control for the suppression case above: it is REPETITION the
    // bound collapses, never a genuinely new tenant's first report. Without
    // this, a gate that suppressed everything would pass that case too.
    expect(indexKeyEmissions()).toHaveLength(2);
  });
});
