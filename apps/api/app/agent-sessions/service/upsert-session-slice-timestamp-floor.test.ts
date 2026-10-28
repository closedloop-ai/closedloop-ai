/**
 * ISS-8735: a session `startedAt`/`updatedAt` below the Postgres timestamp
 * floor fails its OWN slice, and only its own slice.
 *
 * Driven through the REAL `agentSessionsService.upsertSessions` harness rather
 * than the guard alone: what this ticket changes is WHERE the refusal happens —
 * after revision admission and the chunk gate, before the freshness telemetry —
 * and a unit test on the predicate would stay green with the call site deleted.
 */
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { PG_TIMESTAMP_MIN_MS } from "@repo/api/src/types/pg-timestamp-floor";
import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDefaultAgentSessionEventMocks,
  buildSlugCounterMock,
  buildSyncedSession,
  installDb,
  persistedSessionDetail,
  SESSION_STARTED_AT,
  SESSION_UPDATED_AT,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { SessionTimestampOutOfRangeError } from "@/lib/desktop-agent-sessions-errors";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  desktopAgentSessionsHandlerContext as HANDLER_CONTEXT,
  validDesktopAgentSessionsPayload,
} from "@/lib/__tests__/desktop-agent-sessions-handler-fixtures";
import { handleDesktopAgentSessionsEvent } from "@/lib/desktop-agent-sessions-handler";
import { agentSessionsService } from "../service";

const PERSISTED_ARTIFACT_ID = "persisted-session-1";
const CONTEXT = {
  organizationId: "org-1",
  userId: "user-1",
  computeTargetId: "target-1",
};

/** Roughly 100,000 BC — parses fine, no `timestamp` column can hold it. */
const BELOW_FLOOR_STARTED_AT = "-100000-01-01T00:00:00.000Z";
/** The lowest instant a JS `Date` can represent. */
const BELOW_FLOOR_UPDATED_AT = "-271821-04-20T00:00:00.000Z";
/** 4713 BC, the floor itself — astronomical year -4712. */
const FLOOR_INSTANT = "-004712-01-01T00:00:00.000Z";

function buildPayload(
  sessions: SyncedAgentSession[],
  overrides: Record<string, unknown> = {}
) {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "batch-8735",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: sessions.length,
    sessions,
    ...overrides,
  };
}

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    artifactId: PERSISTED_ARTIFACT_ID,
    agents: [],
    dataRevision: null,
    pendingChunkRevision: null,
    pendingChunkTotal: null,
    pendingChunkReceived: null,
    sessionStartedAt: SESSION_STARTED_AT,
    sessionUpdatedAt: SESSION_UPDATED_AT,
    sessionEndedAt: null,
    activitySegmentRowsStripped: null,
    awaitingInputSince: null,
    estimatedCost: null,
    inputTokens: 0n,
    outputTokens: 0n,
    cacheReadTokens: 0n,
    cacheWriteTokens: 0n,
    artifact: { status: null },
    ...overrides,
  };
}

function installHarness(existingRow: Record<string, unknown> | null) {
  const upsert = vi
    .fn()
    .mockResolvedValue(persistedSessionDetail(PERSISTED_ARTIFACT_ID));
  installDb({
    slugCounter: buildSlugCounterMock(),
    sessionDetail: {
      findUnique: vi.fn().mockResolvedValue(existingRow),
      upsert,
      update: vi.fn().mockResolvedValue({}),
    },
    agentSessionEvent: buildDefaultAgentSessionEventMocks(),
    agentSessionTokenUsage: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  });
  return upsert;
}

function sliceFailureLogMeta() {
  const call = vi
    .mocked(log.error)
    .mock.calls.find(
      ([message]) => message === "Desktop agent session slices failed"
    );
  if (!call) {
    throw new Error("expected the batch slice-failure log");
  }
  return call[1] as {
    failures: { error: unknown; field?: string; externalSessionId: string }[];
  };
}

describe("ISS-8735: an unstorable session timestamp fails only its own slice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists the healthy sibling and names the refused startedAt in the failure log", async () => {
    const upsert = installHarness(null);

    const result = await agentSessionsService.upsertSessions(
      CONTEXT,
      buildPayload(
        [
          buildSyncedSession({ externalSessionId: "sess-1" }),
          buildSyncedSession({
            externalSessionId: "sess-2",
            startedAt: BELOW_FLOOR_STARTED_AT,
          }),
        ],
        { wantsAcceptedSessionIds: true }
      )
    );

    expect(result.persistedSessionIds).toEqual(["sess-1"]);
    expect(upsert).toHaveBeenCalledTimes(1);

    const meta = sliceFailureLogMeta();
    expect(meta.failures[0].externalSessionId).toBe("sess-2");
    expect(meta.failures[0].field).toBe("startedAt");
    expect(meta.failures[0].error).toBeInstanceOf(
      SessionTimestampOutOfRangeError
    );
  });

  it("names the refused updatedAt in the failure log", async () => {
    const upsert = installHarness(null);

    const result = await agentSessionsService.upsertSessions(
      CONTEXT,
      buildPayload(
        [
          buildSyncedSession({ externalSessionId: "sess-1" }),
          buildSyncedSession({
            externalSessionId: "sess-2",
            updatedAt: BELOW_FLOOR_UPDATED_AT,
          }),
        ],
        { wantsAcceptedSessionIds: true }
      )
    );

    expect(result.persistedSessionIds).toEqual(["sess-1"]);
    expect(upsert).toHaveBeenCalledTimes(1);

    const meta = sliceFailureLogMeta();
    expect(meta.failures[0].externalSessionId).toBe("sess-2");
    expect(meta.failures[0].field).toBe("updatedAt");
  });

  it("persists the floor instant itself — the guard is strictly below", async () => {
    const upsert = installHarness(null);

    await agentSessionsService.upsertSessions(
      CONTEXT,
      buildPayload([buildSyncedSession({ startedAt: FLOOR_INSTANT })])
    );

    expect(upsert).toHaveBeenCalledTimes(1);
    const create = upsert.mock.calls[0][0].create as {
      sessionStartedAt: Date;
    };
    expect(create.sessionStartedAt.getTime()).toBe(PG_TIMESTAMP_MIN_MS);
  });

  it("leaves a FOREIGN CHUNK refused by the gate, not thrown", async () => {
    const upsert = installHarness(null);

    await expect(
      agentSessionsService.upsertSessions(
        CONTEXT,
        buildPayload(
          [
            buildSyncedSession({
              startedAt: BELOW_FLOOR_STARTED_AT,
              dataRevision: 2,
              chunk: { index: 1, total: 2 },
            }),
          ],
          { wantsAcceptedSessionIds: true }
        )
      )
    ).resolves.toBeDefined();

    expect(upsert).not.toHaveBeenCalled();
  });

  it("leaves a REVISIONLESS MID-SEQUENCE session held by the gate, not thrown", async () => {
    const upsert = installHarness(
      storedRow({
        pendingChunkRevision: 3,
        pendingChunkTotal: 2,
        pendingChunkReceived: 1,
      })
    );

    await expect(
      agentSessionsService.upsertSessions(
        CONTEXT,
        buildPayload(
          [buildSyncedSession({ startedAt: BELOW_FLOOR_STARTED_AT })],
          { wantsAcceptedSessionIds: true }
        )
      )
    ).resolves.toBeDefined();

    expect(upsert).not.toHaveBeenCalled();
  });

  it("leaves a session HELD by revision admission untouched, not thrown", async () => {
    const upsert = installHarness(null);

    await expect(
      agentSessionsService.upsertSessions(
        CONTEXT,
        buildPayload(
          [
            buildSyncedSession({
              startedAt: BELOW_FLOOR_STARTED_AT,
              // The ISS-8271 desktop sentinel: below the supported window, so
              // admission holds the row before the guard can be reached.
              dataRevision: -1,
            }),
          ],
          { wantsAcceptedSessionIds: true }
        )
      )
    ).resolves.toBeDefined();

    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects the WHOLE request for a legacy batch with no row-level ack", async () => {
    installHarness(null);

    await expect(
      agentSessionsService.upsertSessions(
        CONTEXT,
        buildPayload([
          buildSyncedSession({ externalSessionId: "sess-1" }),
          buildSyncedSession({
            externalSessionId: "sess-2",
            startedAt: BELOW_FLOOR_STARTED_AT,
          }),
        ])
      )
    ).rejects.toBeInstanceOf(SessionTimestampOutOfRangeError);
  });
});

/**
 * ISS-8735 (review: davetho): the EXTERNAL contract the desktop outbox reads.
 *
 * The suite above proves `upsertSessions` persists the healthy sibling, but the
 * acknowledgement the desktop actually clears rows against is the handler's ack,
 * and nothing held the two together. This drives the REAL
 * `agentSessionsService.upsertSessions` through `handleDesktopAgentSessionsEvent`
 * — `deps.upsertBatch` is deliberately left unset — so a regression that made the
 * poisoned slice reject the whole batch, or made the ack echo the SENT ids
 * instead of the PERSISTED ones, fails here rather than shipping silent outbox
 * loss.
 */
describe("ISS-8735: the sync ack echoes only the sessions that survived the floor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts the batch and echoes only the healthy externalSessionId", async () => {
    const upsert = installHarness(null);

    const ack = await handleDesktopAgentSessionsEvent(
      {
        ...validDesktopAgentSessionsPayload,
        sessionCount: 2,
        wantsAcceptedSessionIds: true,
        sessions: [
          validDesktopAgentSessionsPayload.sessions[0],
          {
            ...validDesktopAgentSessionsPayload.sessions[0],
            externalSessionId: "sess-2",
            startedAt: BELOW_FLOOR_STARTED_AT,
          },
        ],
      },
      HANDLER_CONTEXT,
      {}
    );

    expect(ack).toEqual({
      accepted: true,
      acceptedSessionIds: ["sess-1"],
    });
    // The sibling was really written, not merely reported: a handler that
    // accepted the batch while persisting nothing would satisfy the ack alone.
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
