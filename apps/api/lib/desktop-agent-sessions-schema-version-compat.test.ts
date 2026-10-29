/**
 * @file ISS-6886 — the cloud ingest boundary accepts an already-installed
 * schema-v1 desktop instead of stranding its whole session-sync lane.
 *
 * FEA-2718 pinned `schemaVersion` to the literal 2 so a desktop/API deploy skew
 * would be loud. That assumed a lockstep fleet: an installed v1 client got
 * `schema_version_invalid` on every batch forever, which the desktop classifies
 * as a lane-wide upgrade-only defer, so nothing it had captured ever reached the
 * cloud. The repository's cross-repo compatibility contract forbids that.
 *
 * The v1 → v2 delta is exactly two per-event turn-text fields (`summary`,
 * `data`), removed by FEA-2718. Every assertion below is written so it would
 * fail if the boundary merely stopped throwing: the fixture carries fields v2
 * does not have, and the expectations name the mapped output field by field.
 */
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  DesktopAgentSessionsAckReason,
} from "@repo/api/src/types/agent-session";
import {
  ACCEPTED_AGENT_SESSION_SYNC_SCHEMA_VERSIONS,
  AGENT_SESSION_SYNC_SCHEMA_VERSION_V1,
} from "@repo/api/src/types/agent-session-sync-schema-version";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  desktopAgentSessionsHandlerContext as baseContext,
  upsertBatchMock,
} from "./__tests__/desktop-agent-sessions-handler-fixtures";
import { handleDesktopAgentSessionsEvent } from "./desktop-agent-sessions-handler";
import { parseDesktopAgentSessionsPayload } from "./desktop-agent-sessions-schema";

const { mockEmitTelemetryMetric, mockLog } = vi.hoisted(() => ({
  mockEmitTelemetryMetric: vi.fn(),
  mockLog: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@repo/observability/log", () => ({ log: mockLog }));
vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mockEmitTelemetryMetric,
}));

const EXTERNAL_SESSION_ID = "sess-v1-compat";
const EXTERNAL_EVENT_ID = "evt-v1-compat";

/**
 * The event as a PRE-FEA-2718 desktop still packs it: the four retained columnar
 * fields PLUS the two turn-text fields that version carried. Those two are the
 * whole wire difference between v1 and v2 — a fixture without them would be a v2
 * payload wearing a `1`, and would pass even if the boundary did no mapping at
 * all.
 */
function v1Event() {
  return {
    externalEventId: EXTERNAL_EVENT_ID,
    agentExternalId: "agent-1",
    eventType: "tool_use",
    toolName: "Bash",
    summary: "ran the build and it failed on a type error",
    data: { command: "pnpm build", stdout: "TS2345: ..." },
    createdAt: "2026-05-20T17:02:00.000Z",
  };
}

/**
 * A minimally valid session that omits every field added after v1, so the
 * "newer optional fields stay omitted" assertions below are about the boundary's
 * behaviour and not about echoing values the fixture supplied.
 */
function v1Session() {
  return {
    externalSessionId: EXTERNAL_SESSION_ID,
    name: "Installed v1 desktop session",
    status: SESSION_STATUS.ACTIVE,
    harness: "claude",
    cwd: "/tmp/worktree",
    model: "claude-sonnet-4",
    startedAt: "2026-05-20T17:00:00.000Z",
    updatedAt: "2026-05-20T17:05:00.000Z",
    metadata: { source: "desktop" },
    attribution: {
      repositoryFullName: "closedloop-ai/closedloop-ai",
      worktreePath: null,
      sourceArtifactId: "artifact-1",
      sourceLoopId: null,
      baseBranch: null,
    },
    agents: [],
    events: [v1Event()],
    tokenUsageByModel: [
      {
        model: "claude-sonnet-4",
        inputTokens: 100,
        outputTokens: 25,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        estimatedCostUsd: 0.01,
      },
    ],
  };
}

function batchAtVersion(schemaVersion: number) {
  return {
    schemaVersion,
    batchId: "7bf9fe88-9a77-471d-a0ce-2b14a7fd5f4a",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [v1Session()],
  };
}

beforeEach(() => {
  mockEmitTelemetryMetric.mockReset();
  mockLog.warn.mockReset();
});

describe("ISS-6886: installed schema-v1 desktops keep syncing", () => {
  it("accepts a v1 batch and preserves the declared version", () => {
    const result = parseDesktopAgentSessionsPayload(
      batchAtVersion(AGENT_SESSION_SYNC_SCHEMA_VERSION_V1)
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Preserved, not normalized to 2: the parsed batch must not claim a
    // provenance it does not have.
    expect(result.payload.schemaVersion).toBe(
      AGENT_SESSION_SYNC_SCHEMA_VERSION_V1
    );
    expect(result.payload.batchId).toBe("7bf9fe88-9a77-471d-a0ce-2b14a7fd5f4a");
    expect(result.payload.syncMode).toBe(AgentSessionSyncMode.Incremental);
    expect(result.payload.sessionCount).toBe(1);
  });

  it("maps a v1 event onto the v2 columnar shape, dropping turn text entirely", () => {
    const result = parseDesktopAgentSessionsPayload(
      batchAtVersion(AGENT_SESSION_SYNC_SCHEMA_VERSION_V1)
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const [event] = result.payload.sessions[0].events;

    // Every retained column survives the mapping with its value.
    expect(event).toMatchObject({
      externalEventId: EXTERNAL_EVENT_ID,
      agentExternalId: "agent-1",
      eventType: "tool_use",
      toolName: "Bash",
      createdAt: "2026-05-20T17:02:00.000Z",
    });
    // The two v1-only fields are ABSENT, not null: FEA-2718 removed the columns,
    // so persisting a null would be as wrong as persisting the text. `toBeNull`
    // would pass on a stripped key too, hence the property assertions.
    expect(event).not.toHaveProperty("summary");
    expect(event).not.toHaveProperty("data");
    expect(Object.keys(event).sort()).toEqual([
      "agentExternalId",
      "createdAt",
      "eventType",
      "externalEventId",
      "toolName",
    ]);
  });

  it("leaves post-v1 optional fields omitted rather than null", () => {
    const result = parseDesktopAgentSessionsPayload(
      batchAtVersion(AGENT_SESSION_SYNC_SCHEMA_VERSION_V1)
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Batch-level additions a v1 client cannot know about.
    expect(result.payload).not.toHaveProperty("encoding");
    expect(result.payload).not.toHaveProperty("wantsAcceptedSessionIds");
    // Session-level additions. Omission is meaning-bearing downstream — an
    // absent `tokenEvents`/`components` leaves previously persisted rows
    // untouched, which a synthesized `null` or `[]` would silently clear.
    const [session] = result.payload.sessions;
    expect(session).not.toHaveProperty("tokenEvents");
    expect(session).not.toHaveProperty("components");
    expect(session).not.toHaveProperty("endsWithError");
    expect(session).not.toHaveProperty("deviceTimeZone");
  });

  it("still accepts the current version unchanged", () => {
    const result = parseDesktopAgentSessionsPayload(
      batchAtVersion(AGENT_SESSION_SYNC_SCHEMA_VERSION)
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.payload.schemaVersion).toBe(
      AGENT_SESSION_SYNC_SCHEMA_VERSION
    );
    expect(result.payload.sessions[0].externalSessionId).toBe(
      EXTERNAL_SESSION_ID
    );
    expect(result.payload.sessions[0].events[0]).not.toHaveProperty("summary");
  });

  it("keeps accepting every version an installed client can still be stamping", () => {
    // The ONLY assertion in the suite written against bare literals instead of
    // the constants, and deliberately so. Every other case reads the version
    // from `@repo/api`, so a future bump moves the fixture with the code and
    // stays green even if the bump quietly drops a previously-accepted version
    // — which is exactly how ISS-6886 shipped. Naming the numbers is what makes
    // that bump turn a test red that says WHICH version was dropped. Extend this
    // list when a version is added; shortening it means retiring a client, which
    // needs a human decision, not a fixture edit.
    expect([...ACCEPTED_AGENT_SESSION_SYNC_SCHEMA_VERSIONS]).toEqual([1, 2]);
    expect(parseDesktopAgentSessionsPayload(batchAtVersion(1)).ok).toBe(true);
    expect(parseDesktopAgentSessionsPayload(batchAtVersion(2)).ok).toBe(true);
  });

  it("fails closed on a version this build has never seen", () => {
    // Widening acceptance must not become accepting anything. 99 stands for a
    // future contract whose shape this build cannot map; 0 for a nonsense value.
    // 3 is the next unallocated version — if adding it turns this red, that is
    // the correct red: say so and move it into the accepted list above.
    for (const unknownVersion of [0, 3, 99]) {
      const result = parseDesktopAgentSessionsPayload(
        batchAtVersion(unknownVersion)
      );
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      // The desktop reads this exact string to classify the rejection as
      // lane-wide and budget-neutral (`ValidationFailureDetail`), so widening
      // the union must not have moved the issue off the `schemaVersion` path.
      expect(result.reason).toBe("schema_version_invalid");
    }
  });
});

describe("ISS-6886: the v1 batch reaches the persistence call", () => {
  it("persists a v1 batch through the production handler", async () => {
    const upsertBatch = upsertBatchMock([EXTERNAL_SESSION_ID]);

    const ack = await handleDesktopAgentSessionsEvent(
      batchAtVersion(AGENT_SESSION_SYNC_SCHEMA_VERSION_V1),
      baseContext,
      {
        upsertBatch,
      }
    );

    expect(ack.accepted).toBe(true);
    // The parse gate is the only thing that stood between a v1 batch and the
    // sink, so asserting the sink was called with the mapped batch is what
    // proves the lane is unblocked end to end rather than merely parsing.
    expect(upsertBatch).toHaveBeenCalledTimes(1);
    const [, forwardedPayload] = upsertBatch.mock.calls[0];
    expect(forwardedPayload.schemaVersion).toBe(
      AGENT_SESSION_SYNC_SCHEMA_VERSION_V1
    );
    expect(forwardedPayload.sessions[0].externalSessionId).toBe(
      EXTERNAL_SESSION_ID
    );
    expect(forwardedPayload.sessions[0].events[0]).not.toHaveProperty(
      "summary"
    );
  });

  it("rejects an unknown version at the handler with a validation ack", async () => {
    const upsertBatch = upsertBatchMock([EXTERNAL_SESSION_ID]);

    const ack = await handleDesktopAgentSessionsEvent(
      batchAtVersion(99),
      baseContext,
      {
        upsertBatch,
      }
    );

    expect(ack).toEqual({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
      detail: "schema_version_invalid",
    });
    expect(upsertBatch).not.toHaveBeenCalled();
  });
});
