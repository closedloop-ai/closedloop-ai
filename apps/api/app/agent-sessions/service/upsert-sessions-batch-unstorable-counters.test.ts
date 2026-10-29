/**
 * ISS-8881: `upsertSessionsBatch` must report the session counters it could not
 * store ONCE PER REQUEST, never once per session.
 *
 * The drops themselves are proved in
 * `persist-session-children-int4-bounds.test.ts`. What this file owns is the
 * amplification bound `apps/api/AGENTS.md` ("Emission and Abuse Control")
 * requires, and the fact that BOTH sources — the `SessionDetail` trace counters
 * and the usage-rollup counters, collected at two different points of the same
 * transaction — fold into that one emission.
 *
 * A sibling file rather than another block in `upsert-sessions-batch.test.ts`,
 * which is at the 1,000-line ceiling, for the same reason
 * `upsert-sessions-batch-usage-drops.test.ts` is.
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

import { MAX_SAMPLED_IDENTIFIER_BYTES } from "./sampled-identifier";
import {
  SessionSyncMetric,
  UNSTORABLE_ROLLUP_FIELD_PREFIX,
  UNSTORABLE_SESSION_DETAIL_FIELD_PREFIX,
} from "./session-sync-metrics";
import { upsertSessionsBatch } from "./upsert-sessions-batch";
import { MAX_DROPPED_USAGE_KEYS_PER_SYNC_REQUEST } from "./upsert-sessions-batch-drop-tallies";

const ORGANIZATION_ID = "org-batch-unstorable-counters";
const CONTEXT = {
  organizationId: ORGANIZATION_ID,
  userId: "user-batch-unstorable-counters",
  computeTargetId: "target-batch-unstorable-counters",
};

const WARN_MESSAGE = "Dropped session counters that int4 columns cannot hold";

function buildPayload(sessionCount: number) {
  return {
    sessions: Array.from({ length: sessionCount }, (_, index) => ({
      externalSessionId: `ext-${index}`,
    })),
    wantsAcceptedSessionIds: true,
  };
}

/** Every slice reports the same unstorable counter fields. */
function unstorablePerSlice(fields: readonly string[]) {
  mocks.upsertSessionSlice.mockImplementation(() => ({
    persisted: true,
    observedRepositoryFullNames: [],
    indexKeyProjections: 0,
    unstorableCounterFields: [...fields],
  }));
}

function counterEmissions() {
  return mocks.emitTelemetryMetric.mock.calls
    .map(([arg]) => arg)
    .filter(
      (arg) => arg?.metric === SessionSyncMetric.UnstorableCounterDropped
    );
}

function counterWarnings() {
  return mocks.logWarn.mock.calls.filter(
    ([message]) => message === WARN_MESSAGE
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

describe("upsertSessionsBatch — unstorable counters are reported once (ISS-8881)", () => {
  it("emits ONE metric and ONE warn for the whole batch, carrying its total", async () => {
    unstorablePerSlice(["turns", "eventCount"]);

    await upsertSessionsBatch(CONTEXT, buildPayload(4) as never);

    // Four sessions x two fields. The bound this test exists for is the ARITY,
    // not the count: eight per-slice emissions would satisfy any assertion on
    // the total alone, and the drop is deterministic so the desktop re-sends it
    // on every retry.
    expect(counterEmissions()).toEqual([
      {
        metric: SessionSyncMetric.UnstorableCounterDropped,
        organizationId: ORGANIZATION_ID,
        computeTargetId: CONTEXT.computeTargetId,
        count: 8,
      },
    ]);
    expect(counterWarnings()).toHaveLength(1);
  });

  it("folds BOTH sources into that single emission", async () => {
    // `turns` is collected by `toTraceDetailPatch` before the sessionDetail
    // upsert; `eventCount` is collected by `persistSessionAnalytics` after it,
    // through a different return path. The whole point of the shared tally is
    // that they still produce ONE emission naming both.
    unstorablePerSlice(["turns", "steeringEpisodes", "eventCount"]);

    await upsertSessionsBatch(CONTEXT, buildPayload(1) as never);

    expect(counterWarnings()).toHaveLength(1);
    expect(counterWarnings()[0][1]).toEqual(
      expect.objectContaining({
        computeTargetId: CONTEXT.computeTargetId,
        droppedCount: 3,
        fields: expect.arrayContaining([
          "turns",
          "steeringEpisodes",
          "eventCount",
        ]),
        organizationId: ORGANIZATION_ID,
      })
    );
  });

  it("names the sessions so the drop is actionable", async () => {
    unstorablePerSlice(["turns"]);

    await upsertSessionsBatch(CONTEXT, buildPayload(2) as never);

    expect(counterWarnings()[0][1].sessionIds).toEqual(["ext-0", "ext-1"]);
  });

  it("dedupes the field names without understating the count", async () => {
    // The field key space is CLOSED, so the names need no cap — but they are a
    // SET, and the count must not follow it down.
    unstorablePerSlice(["turns"]);

    await upsertSessionsBatch(CONTEXT, buildPayload(5) as never);

    expect(counterWarnings()[0][1].fields).toEqual(["turns"]);
    expect(counterEmissions()[0].count).toBe(5);
  });

  it("caps the session ids it logs without understating the count", async () => {
    // `externalSessionId` is caller-driven, unlike the field names, so the
    // sampled list is what stops an authenticated caller from driving log size.
    const overCap = MAX_DROPPED_USAGE_KEYS_PER_SYNC_REQUEST + 5;
    unstorablePerSlice(["turns"]);

    await upsertSessionsBatch(CONTEXT, buildPayload(overCap) as never);

    expect(counterWarnings()[0][1].sessionIds).toHaveLength(
      MAX_DROPPED_USAGE_KEYS_PER_SYNC_REQUEST
    );
    expect(counterEmissions()[0].count).toBe(overCap);
  });

  it("stays silent when nothing was dropped, so the count cannot measure traffic", async () => {
    unstorablePerSlice([]);

    await upsertSessionsBatch(CONTEXT, buildPayload(3) as never);

    expect(counterEmissions()).toEqual([]);
    expect(counterWarnings()).toEqual([]);
  });

  it("still reports what a partially-failed batch already dropped", async () => {
    // The report sits in the `finally` for the same reason its neighbours do:
    // the slices that committed dropped those fields, and a report keyed on a
    // clean batch would go quiet on exactly the payloads worth seeing.
    mocks.upsertSessionSlice.mockImplementation(
      (_tx: unknown, input: { session: { externalSessionId: string } }) => {
        if (input.session.externalSessionId === "ext-2") {
          throw new Error("slice exploded");
        }
        return {
          persisted: true,
          observedRepositoryFullNames: [],
          indexKeyProjections: 0,
          unstorableCounterFields: ["turns"],
        };
      }
    );

    await upsertSessionsBatch(CONTEXT, buildPayload(3) as never);

    expect(counterEmissions()).toEqual([
      expect.objectContaining({
        metric: SessionSyncMetric.UnstorableCounterDropped,
        count: 2,
      }),
    ]);
  });

  it("treats an outcome that omits the field as nothing dropped", async () => {
    // Optional like its neighbours, so partial fixtures and older outcome shapes
    // read as "nothing dropped" rather than throwing in the fold.
    mocks.upsertSessionSlice.mockImplementation(() => ({
      persisted: true,
      observedRepositoryFullNames: [],
      indexKeyProjections: 0,
    }));

    await upsertSessionsBatch(CONTEXT, buildPayload(2) as never);

    expect(counterEmissions()).toEqual([]);
  });
});

/**
 * ISS-8881 review follow-ups on the SHAPE of this one warn.
 *
 * Two separate defects, both about what a reader gets out of the record rather
 * than whether it fires: the field names have to say which of the two very
 * different losses happened (marisolashgrove), and the caller-controlled
 * identifiers sampled beside them have to be bounded in BYTES and not only in
 * count (davetho).
 */
describe("the unstorable-counter warn is legible and bounded (ISS-8881)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the whole-row withhold distinguishable from a single-field omission", async () => {
    // ONE metric, two outcomes. `sessionDetail.turns` was omitted from a row
    // that still wrote, leaving that nullable column at its previous value;
    // `usageRollup.eventCount` withheld the ENTIRE rollup row — tokens, cost,
    // runtimeMs and all five counters. A bare `eventCount` cannot tell an
    // operator which of those they are looking at.
    unstorablePerSlice([
      `${UNSTORABLE_SESSION_DETAIL_FIELD_PREFIX}turns`,
      `${UNSTORABLE_ROLLUP_FIELD_PREFIX}eventCount`,
    ]);

    await upsertSessionsBatch(CONTEXT, buildPayload(1) as never);

    expect(counterWarnings()[0][1].fields).toEqual([
      `${UNSTORABLE_SESSION_DETAIL_FIELD_PREFIX}turns`,
      `${UNSTORABLE_ROLLUP_FIELD_PREFIX}eventCount`,
    ]);
  });

  it("bounds the BYTES of a sampled session id, not just how many it keeps", async () => {
    // The cardinality cap counts entries and bounds no bytes.
    // `externalSessionId` is `z.string().trim().min(1)` on the wire with no
    // maximum, so twenty multi-MiB ids are twenty times a cap that never looked
    // at size — written again on every retry, because the payload is
    // deterministic and re-sent every sync.
    const huge = "s".repeat(MAX_SAMPLED_IDENTIFIER_BYTES * 4);
    unstorablePerSlice([`${UNSTORABLE_SESSION_DETAIL_FIELD_PREFIX}turns`]);

    await upsertSessionsBatch(CONTEXT, {
      sessions: [{ externalSessionId: huge }],
    } as never);

    const [logged] = counterWarnings()[0][1].sessionIds as string[];
    expect(Buffer.byteLength(logged, "utf-8")).toBeLessThanOrEqual(
      MAX_SAMPLED_IDENTIFIER_BYTES + "…[truncated]".length * 3
    );
    // Marked, so a prefix is never handed to a reader as if it were the whole
    // identifier.
    expect(logged.endsWith("…[truncated]")).toBe(true);
  });

  it("leaves an ordinary session id whole", async () => {
    // The anti-over-truncation anchor: a bound that mangled every id would make
    // the case above pass and the warn useless.
    unstorablePerSlice([`${UNSTORABLE_SESSION_DETAIL_FIELD_PREFIX}turns`]);

    await upsertSessionsBatch(CONTEXT, buildPayload(1) as never);

    expect(counterWarnings()[0][1].sessionIds).toEqual(["ext-0"]);
  });

  it("bounds a sampled component key on the sibling report too", async () => {
    // `boundSampledIdentifier` is shared, and `componentKey` is the same
    // unbounded wire string. Bounding one sink and not the other would fork two
    // reports this file's own PR argues are deliberately identical.
    const huge = `c${"k".repeat(MAX_SAMPLED_IDENTIFIER_BYTES * 4)}`;
    mocks.upsertSessionSlice.mockImplementation(() => ({
      persisted: true,
      observedRepositoryFullNames: [],
      indexKeyProjections: 0,
      droppedOverflowUsageBuckets: [huge],
    }));

    await upsertSessionsBatch(CONTEXT, buildPayload(1) as never);

    const [warning] = mocks.logWarn.mock.calls.filter(
      ([message]) =>
        message === "Dropped component usage buckets that overflowed int4"
    );
    const [logged] = warning[1].componentKeys as string[];
    expect(Buffer.byteLength(logged, "utf-8")).toBeLessThanOrEqual(
      MAX_SAMPLED_IDENTIFIER_BYTES + "…[truncated]".length * 3
    );
  });
});
