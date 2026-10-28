/**
 * ISS-8641 / ISS-8714: `upsertSessionsBatch` must raise the monitored
 * degraded-metadata event for the sessions that actually LANDED a degraded
 * `metadata` blob, once per request.
 *
 * The merge itself and the emission helper are proved in
 * `degraded-metadata-merge.test.ts`, and the blob the slice writes in
 * `service.degraded-metadata-persist.test.ts`. What this file owns is the
 * WIRING — a unit test of `reportDegradedMetadata` proves the function, never
 * that anything calls it — plus the amplification bound `apps/api/AGENTS.md`
 * ("Emission and Abuse Control") requires: a blob that stays oversized
 * re-declares on every pass forever, so the report must be per REQUEST and keyed
 * on what committed.
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

import type { DesktopAgentSessionsPayload } from "@repo/api/src/types/agent-session";
import {
  buildBatch,
  buildSession,
} from "@/__tests__/support/agent-sessions/upsert-sessions-batch.test-fixtures";
import {
  degradedMetadataThrottle,
  METADATA_DEGRADED_EVENT,
} from "./degraded-metadata-merge";
import { upsertSessionsBatch } from "./upsert-sessions-batch";

const ORGANIZATION_ID = "org-batch-degraded-metadata";
const CONTEXT = {
  organizationId: ORGANIZATION_ID,
  userId: "user-batch-degraded-metadata",
  computeTargetId: "target-batch-degraded-metadata",
};
const DEGRADED_ID = "ext-degraded";
const CLEAN_ID = "ext-clean";

/**
 * One session DECLARING withheld keys beside one that declares nothing, so a
 * report keyed on the payload rather than on the declaration over-counts and
 * fails.
 */
function buildPayload(): DesktopAgentSessionsPayload {
  return buildBatch(
    [
      buildSession({
        externalSessionId: DEGRADED_ID,
        metadataWithheldKeys: ["usageExtras"],
      }),
      buildSession({ externalSessionId: CLEAN_ID }),
    ],
    { wantsAcceptedSessionIds: true }
  );
}

function failSliceFor(externalSessionId: string, error: Error) {
  mocks.upsertSessionSlice.mockImplementation(
    (_tx: unknown, input: { session: { externalSessionId: string } }) => {
      if (input.session.externalSessionId === externalSessionId) {
        throw error;
      }
      return {
        persisted: true,
        observedRepositoryFullNames: [],
        indexKeyProjections: 0,
      };
    }
  );
}

function degradedEvents() {
  return mocks.logWarn.mock.calls.filter(
    ([message]) => message === METADATA_DEGRADED_EVENT
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // The report rides a process-local emission throttle keyed on
  // (org, compute target), and every case here uses the same CONTEXT — without
  // this reset the second degraded batch in the file would be suppressed and the
  // suite would be testing the throttle instead of the report.
  degradedMetadataThrottle.clear();
  mocks.withDb.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({
      computeTarget: {
        findFirst: async () => ({ id: CONTEXT.computeTargetId }),
      },
    })
  );
  mocks.withDb.tx.mockImplementation((fn: (tx: unknown) => unknown) => fn({}));
  mocks.recordObservedRepositories.mockResolvedValue(undefined);
  mocks.upsertSessionSlice.mockImplementation(() => ({
    persisted: true,
    observedRepositoryFullNames: [],
    indexKeyProjections: 0,
  }));
});

describe("upsertSessionsBatch — degraded-metadata monitored event", () => {
  it("raises the event once for the session that declared a degrade", async () => {
    await upsertSessionsBatch(CONTEXT, buildPayload());

    expect(degradedEvents()).toHaveLength(1);
    // A whole-object match, so a NEW facet has to be declared here rather than
    // slipping into a monitored payload unreviewed. `degradedSessionCount: 1`,
    // not 2, is what pins the count to the DECLARATION.
    expect(degradedEvents()[0][1]).toEqual({
      organizationId: ORGANIZATION_ID,
      computeTargetId: CONTEXT.computeTargetId,
      degradedSessionCount: 1,
      occurrences: 1,
    });
  });

  it("stays silent when the degraded session's slice never committed", async () => {
    // The sibling that pins the committed gate: a slice that threw re-sends in
    // full, so reporting it would name a landing that has not happened. Counting
    // `payload.sessions` instead passes the case above and fails here.
    failSliceFor(DEGRADED_ID, new Error("slice blew up"));

    await upsertSessionsBatch(CONTEXT, buildPayload());

    expect(degradedEvents()).toHaveLength(0);
  });

  it("stays silent for a batch where no session declared a degrade", async () => {
    await upsertSessionsBatch(
      CONTEXT,
      buildBatch([buildSession({ externalSessionId: CLEAN_ID })])
    );

    expect(degradedEvents()).toHaveLength(0);
  });
});
