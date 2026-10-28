/**
 * ISS-8186 path 2: the ingest work bound must be TRANSPORT-NEUTRAL.
 *
 * The byte budgets are not. `readBoundedMaybeGzipJsonBody` /
 * `SYNC_DECOMPRESSED_BYTE_CEILING` bound the HTTP sync route only; the direct
 * Socket.IO event hands its raw payload straight to
 * `handleDesktopAgentSessionsEvent` with nothing but `maxHttpBufferSize` behind
 * it, so an older socket client could drive thousands of sequential
 * transactions from one event (whitlockk, #5990). Bytes were never the right
 * quantity anyway — a reviewer measured ~10,000 minimal sessions at about
 * 31 KiB gzipped, which every ceiling on either transport admits.
 *
 * The fix is that the bound lives in the SERVICE every transport funnels
 * through, so this suite drives `handleDesktopAgentSessionsEvent` against the
 * REAL `upsertSessionsBatch` with no byte ceiling in front of it, and asserts
 * the ack it produces. The direct Socket.IO entry point was retired in
 * ISS-12735; the HTTP sync route is the remaining caller.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(
    vi.fn((fn: (db: unknown) => unknown) => fn({})),
    { tx: vi.fn() }
  ),
  emitTelemetryMetric: vi.fn(),
  upsertSessionSlice: vi.fn(),
  stampIngestSyncWatermark: vi.fn(),
  stampIngestWatermarkAfterFailedBatch: vi.fn(),
  recordObservedRepositories: vi.fn(),
}));

vi.mock("@repo/database", () => ({ withDb: mocks.withDb }));
vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mocks.emitTelemetryMetric,
}));
vi.mock("@/app/agent-sessions/service", () => ({
  agentSessionsService: { upsertSessions: vi.fn() },
}));
vi.mock("@/app/agent-sessions/service/upsert-session-slice", () => ({
  upsertSessionSlice: mocks.upsertSessionSlice,
}));
vi.mock("@/app/agent-sessions/service/ingest-sync-stamp", () => ({
  stampIngestSyncWatermark: mocks.stampIngestSyncWatermark,
  stampIngestWatermarkAfterFailedBatch:
    mocks.stampIngestWatermarkAfterFailedBatch,
}));
vi.mock("@/app/agent-sessions/service/project-resolution", () => ({
  resolveProjectResolution: vi.fn().mockResolvedValue({
    artifactProjectById: new Map(),
  }),
}));
vi.mock("@/app/agent-sessions/service/artifact-links/slug-links", () => ({
  resolveArtifactSlugMap: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("@/lib/github/observed-repository-store", () => ({
  recordObservedRepositories: mocks.recordObservedRepositories,
}));
vi.mock("@/app/settings/frustration-setting-service", () => ({
  frustrationSettingService: { isFrustrationEnabled: async () => false },
}));

import type { DesktopAgentSessionsPayload } from "@repo/api/src/types/agent-session";
import { SessionSyncMetric } from "@/app/agent-sessions/service/session-sync-metrics";
import { upsertSessionsBatch } from "@/app/agent-sessions/service/upsert-sessions-batch";
import {
  DesktopAgentSessionsRateLimiter,
  handleDesktopAgentSessionsEvent,
} from "../desktop-agent-sessions-handler";
import {
  desktopAgentSessionsHandlerContext as baseContext,
  validDesktopAgentSessionsPayload as validPayload,
} from "./desktop-agent-sessions-handler-fixtures";

const SESSION_COUNT = 10;
/** A reading past any plausible budget, so the check after it always trips. */
const FAR_PAST_BUDGET_MS = 999_999;

const [TEMPLATE_SESSION] = validPayload.sessions;

/** The socket lane's payload: unbounded on the wire, opted into the row-level echo. */
const SOCKET_PAYLOAD = {
  ...validPayload,
  sessionCount: SESSION_COUNT,
  wantsAcceptedSessionIds: true,
  sessions: Array.from({ length: SESSION_COUNT }, (_, index) => ({
    ...TEMPLATE_SESSION,
    externalSessionId: `sess-${index}`,
  })),
};

function scriptedClock(readings: readonly number[]): () => number {
  let index = 0;
  return () => {
    const reading = readings[index];
    if (reading === undefined) {
      throw new Error(`scriptedClock exhausted after ${index} readings`);
    }
    index += 1;
    return reading;
  };
}

/** The handler's `upsertBatch` seam, wired to the REAL batch under a scripted clock. */
function boundedUpsertBatch(readings: readonly number[]) {
  const readNowMs = scriptedClock(readings);
  return (
    context: {
      organizationId: string;
      userId: string;
      computeTargetId: string;
    },
    payload: DesktopAgentSessionsPayload
  ) => upsertSessionsBatch(context, payload, { readNowMs });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withDb.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({
      computeTarget: {
        findFirst: async () => ({ id: baseContext.targetId }),
      },
    })
  );
  mocks.withDb.tx.mockImplementation((fn: (tx: unknown) => unknown) => fn({}));
  mocks.upsertSessionSlice.mockImplementation(() => ({
    persisted: true,
    observedRepositoryFullNames: [],
  }));
  mocks.recordObservedRepositories.mockResolvedValue(undefined);
});

describe("desktop agent-sessions ingest — transport-neutral work bound", () => {
  it("bounds a socket-lane batch that no byte ceiling would have stopped", async () => {
    const ack = await handleDesktopAgentSessionsEvent(
      SOCKET_PAYLOAD,
      baseContext,
      {
        rateLimiter: new DesktopAgentSessionsRateLimiter(),
        upsertBatch: boundedUpsertBatch([0, 1, 2, FAR_PAST_BUDGET_MS]),
      }
    );

    // The socket lane has no `readBoundedMaybeGzipJsonBody` in front of it, so
    // before ISS-8186 all ten sessions ran here. The bound lives in the service
    // both transports call, so the same truncation applies on this path.
    expect(mocks.upsertSessionSlice).toHaveBeenCalledTimes(3);
    expect(ack).toEqual({
      accepted: true,
      acceptedSessionIds: ["sess-0", "sess-1", "sess-2"],
    });
  });

  it("reports the socket-lane deferral to the operator", async () => {
    await handleDesktopAgentSessionsEvent(SOCKET_PAYLOAD, baseContext, {
      rateLimiter: new DesktopAgentSessionsRateLimiter(),
      upsertBatch: boundedUpsertBatch([0, 1, 2, FAR_PAST_BUDGET_MS]),
    });

    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.IngestRuntimeBudgetDeferred,
        count: SESSION_COUNT - 3,
        attemptedSessionCount: 3,
      })
    );
  });

  it("accepts the whole socket-lane batch when the budget holds", async () => {
    const ack = await handleDesktopAgentSessionsEvent(
      SOCKET_PAYLOAD,
      baseContext,
      {
        rateLimiter: new DesktopAgentSessionsRateLimiter(),
        upsertBatch: boundedUpsertBatch(
          Array.from({ length: SESSION_COUNT }, () => 0)
        ),
      }
    );

    // No cap was restored: an unbounded payload is still accepted whole when the
    // request can apply it.
    expect(mocks.upsertSessionSlice).toHaveBeenCalledTimes(SESSION_COUNT);
    expect(ack).toEqual({
      accepted: true,
      acceptedSessionIds: SOCKET_PAYLOAD.sessions.map(
        (session) => session.externalSessionId
      ),
    });
  });
});
