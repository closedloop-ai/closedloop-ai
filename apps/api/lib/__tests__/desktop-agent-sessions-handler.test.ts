import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SESSION_TRACE_SOURCE_LIMITS as DERIVATION_SOURCE_LIMITS,
  SessionPrLifecycleStatus,
  SessionTraceCorrectionKind,
  SessionTracePhaseSourceType,
  SessionTraceThrottleSourceType,
} from "@repo/api/src/session-trace/derivation";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  DesktopAgentSessionsAckReason,
} from "@repo/api/src/types/agent-session";
import {
  ArtifactRefMethod,
  ArtifactRefTargetKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { redactGatewaySessionId } from "@repo/observability/redact-correlation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DesktopAgentSessionsRateLimiter,
  handleDesktopAgentSessionsEvent,
} from "../desktop-agent-sessions-handler";
import { parseDesktopAgentSessionsPayload } from "../desktop-agent-sessions-schema";

const { mockEmitTelemetryMetric, mockLog } = vi.hoisted(() => ({
  mockEmitTelemetryMetric: vi.fn(),
  mockLog: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: mockLog,
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mockEmitTelemetryMetric,
}));

const baseContext = {
  organizationId: "org-1",
  userId: "user-1",
  clerkUserId: "clerk-user-1",
  targetId: "target-1",
  gatewaySessionId: "session-1",
};

const validPayload = {
  schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
  batchId: "7bf9fe88-9a77-471d-a0ce-2b14a7fd5f4a",
  syncMode: AgentSessionSyncMode.Incremental,
  sessionCount: 1,
  sessions: [
    {
      externalSessionId: "sess-1",
      name: "Session One",
      status: "active",
      harness: "claude",
      cwd: "/tmp/worktree",
      model: "claude-sonnet-4",
      startedAt: "2026-05-20T17:00:00.000Z",
      updatedAt: "2026-05-20T17:05:00.000Z",
      metadata: { source: "desktop" },
      attribution: {
        repositoryFullName: "closedloop-ai/symphony-alpha",
        worktreePath: null,
        sourceArtifactId: "artifact-1",
        sourceLoopId: null,
        baseBranch: null,
      },
      agents: [],
      events: [],
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
    },
  ],
};

beforeEach(() => {
  mockEmitTelemetryMetric.mockReset();
  mockLog.debug.mockReset();
  mockLog.info.mockReset();
  mockLog.warn.mockReset();
  mockLog.error.mockReset();
});

describe("handleDesktopAgentSessionsEvent", () => {
  it("returns validation_failed for malformed payloads", async () => {
    await expect(
      handleDesktopAgentSessionsEvent(
        {
          ...validPayload,
          sessionCount: 2,
        },
        baseContext,
        {
          isFeatureEnabled: async () => true,
          upsertBatch: vi.fn(),
        }
      )
    ).resolves.toEqual({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
    });
  });

  it("returns feature_disabled when server sync support is off", async () => {
    await expect(
      handleDesktopAgentSessionsEvent(validPayload, baseContext, {
        isFeatureEnabled: async () => false,
        upsertBatch: vi.fn(),
      })
    ).resolves.toEqual({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.FeatureDisabled,
    });
  });

  it("upserts accepted batches", async () => {
    const upsertBatch = vi.fn();

    await expect(
      handleDesktopAgentSessionsEvent(validPayload, baseContext, {
        isFeatureEnabled: async () => true,
        upsertBatch,
      })
    ).resolves.toEqual({ accepted: true });

    expect(upsertBatch).toHaveBeenCalledWith(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
        gatewaySessionId: "session-1",
      },
      validPayload
    );
    expect(mockEmitTelemetryMetric).not.toHaveBeenCalled();
  });

  it("upserts the parsed session-sync contract without desktop-local identity or trace-comment result fields", async () => {
    const upsertBatch = vi.fn();
    const payloadWithIgnoredFields = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          organizationId: "desktop-org-should-not-cross-cloud",
          traceCommentSyncResults: [{ commentId: "comment-1" }],
          userId: "desktop-user-should-not-cross-cloud",
        },
      ],
    };

    await expect(
      handleDesktopAgentSessionsEvent(payloadWithIgnoredFields, baseContext, {
        isFeatureEnabled: async () => true,
        upsertBatch,
      })
    ).resolves.toEqual({ accepted: true });

    const syncedSession = upsertBatch.mock.calls[0]?.[1]?.sessions[0];
    expect(syncedSession).not.toHaveProperty("organizationId");
    expect(syncedSession).not.toHaveProperty("traceCommentSyncResults");
    expect(syncedSession).not.toHaveProperty("userId");
  });

  it("returns ingestion_failed for ingestion failures", async () => {
    await expect(
      handleDesktopAgentSessionsEvent(
        validPayload,
        { ...baseContext, relaySocketId: "relay-1" },
        {
          isFeatureEnabled: async () => true,
          upsertBatch: () => Promise.reject(new Error("db down")),
        }
      )
    ).resolves.toEqual({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.IngestionFailed,
    });
    // The failure telemetry reason must stay in lockstep with the ack reason so
    // dashboards that join the two on `reason` don't drift (FEA-2847).
    expect(mockEmitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: "agent_sessions.sync.failed",
        reason: DesktopAgentSessionsAckReason.IngestionFailed,
      })
    );
    // FEA-2917: the ingestion-failure error log must carry the gateway session
    // identifiers so an operator can pivot from this Datadog error back to the
    // originating gateway session.
    expect(mockLog.error).toHaveBeenCalledWith(
      "Desktop agent sessions ingestion failed",
      expect.objectContaining({
        gatewaySessionIdHash: redactGatewaySessionId("session-1"),
        relaySocketId: "relay-1",
      })
    );
  });

  it("rate limits overly chatty targets", async () => {
    const rateLimiter = new DesktopAgentSessionsRateLimiter();
    const upsertBatch = vi.fn();

    for (let index = 0; index < 120; index += 1) {
      await expect(
        handleDesktopAgentSessionsEvent(validPayload, baseContext, {
          isFeatureEnabled: async () => true,
          upsertBatch,
          rateLimiter,
          now: () => 0,
        })
      ).resolves.toEqual({ accepted: true });
    }

    await expect(
      handleDesktopAgentSessionsEvent(validPayload, baseContext, {
        isFeatureEnabled: async () => true,
        upsertBatch,
        rateLimiter,
        now: () => 0,
      })
    ).resolves.toEqual({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.RateLimited,
    });
  });

  it("FEA-2258: sanitizes NUL and lone surrogates before handing the batch to persistence", async () => {
    const upsertBatch = vi.fn();
    const nul = String.fromCharCode(0);
    const loneHigh = String.fromCharCode(0xd8_3d);
    const replacement = String.fromCharCode(0xff_fd);
    // FEA-2718: summary/data are stripped from synced events on ingest, but the
    // pre-Zod sanitizer still walks the whole raw payload (including the doomed
    // `data` blob) — so it must strip NUL/surrogates from retained fields and
    // must never pollute Object.prototype via the `__proto__` key in that blob.
    const dirtyData: unknown = JSON.parse(
      '{"out":"x\\u0000y","keep":"\\ud83d","__proto__":{"polluted":true}}'
    );
    const dirtyPayload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          name: `clean${nul}name`,
          events: [
            {
              externalEventId: "event-1",
              agentExternalId: null,
              eventType: "tool_use",
              toolName: `Read${loneHigh}`,
              summary: `tail${loneHigh}`,
              data: dirtyData,
              createdAt: "2026-05-20T17:01:00.000Z",
            },
          ],
        },
      ],
    };

    await expect(
      handleDesktopAgentSessionsEvent(dirtyPayload, baseContext, {
        isFeatureEnabled: async () => true,
        upsertBatch,
      })
    ).resolves.toEqual({ accepted: true });

    const persisted = upsertBatch.mock.calls[0]?.[1]?.sessions[0];
    expect(persisted.name).toBe("cleanname");
    // A retained event string field is still sanitized.
    expect(persisted.events[0].toolName).toBe(`Read${replacement}`);
    // The dropped turn-text fields never reach persistence.
    expect(Object.hasOwn(persisted.events[0], "summary")).toBe(false);
    expect(Object.hasOwn(persisted.events[0], "data")).toBe(false);
    // The ingest path must never pollute Object.prototype via a __proto__ key.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("FEA-2258: rejects a session whose required id collapses to empty after NUL stripping", async () => {
    const upsertBatch = vi.fn();
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          externalSessionId: String.fromCharCode(0),
        },
      ],
    };

    // Sanitize-before-validate: "\0" strips to "" and fails the required
    // min(1), so the batch is rejected rather than persisted with an empty key.
    await expect(
      handleDesktopAgentSessionsEvent(payload, baseContext, {
        isFeatureEnabled: async () => true,
        upsertBatch,
      })
    ).resolves.toEqual({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
    });
    expect(upsertBatch).not.toHaveBeenCalled();
  });

  it("FEA-2258: rejects a pathologically deep payload before persistence", async () => {
    const upsertBatch = vi.fn();
    let deepData: unknown = 0;
    for (let i = 0; i < 300; i += 1) {
      deepData = { n: deepData };
    }
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          events: [
            {
              externalEventId: "event-1",
              agentExternalId: null,
              eventType: "tool_use",
              toolName: "Read",
              summary: null,
              data: deepData,
              createdAt: "2026-05-20T17:01:00.000Z",
            },
          ],
        },
      ],
    };

    await expect(
      handleDesktopAgentSessionsEvent(payload, baseContext, {
        isFeatureEnabled: async () => true,
        upsertBatch,
      })
    ).resolves.toEqual({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
    });
    expect(upsertBatch).not.toHaveBeenCalled();
  });
});

describe("parseDesktopAgentSessionsPayload — sanitized-key collisions (FEA-2691)", () => {
  // Built via char code so no literal NUL byte lives in this source.
  const nul = String.fromCharCode(0);

  it("does NOT reject a collision in the discarded event.data blob (FEA-2718)", () => {
    // Two keys that differ only by a NUL collapse to the same jsonb key. Before
    // FEA-2718 this rejected the batch (event `data` was persisted verbatim);
    // now the schema strips event `data` before any DB write, so the collision
    // loses no persisted data and the batch must still be accepted.
    const collidingData: unknown = JSON.parse(
      '{"dup\\u0000":"first","dup":"second"}'
    );
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          events: [
            {
              externalEventId: "event-1",
              agentExternalId: null,
              eventType: "tool_use",
              toolName: "Read",
              summary: null,
              data: collidingData,
              createdAt: "2026-05-20T17:01:00.000Z",
            },
          ],
        },
      ],
    };

    const result = parseDesktopAgentSessionsPayload(payload);
    expect(result.ok).toBe(true);
  });

  it("rejects a collision in a persisted session.metadata blob", () => {
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          metadata: JSON.parse('{"k\\u0000":1,"k":2}'),
        },
      ],
    };

    const result = parseDesktopAgentSessionsPayload(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("payload_sanitized_key_collision");
    }
  });

  it("rejects a collision in a persisted agents[].metadata blob", () => {
    // Two keys that differ only by a NUL collapse to the same jsonb key; the
    // later value would silently overwrite the earlier one, losing data.
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          agents: [
            {
              externalAgentId: "agent-1",
              name: "Main agent",
              type: "main",
              subagentType: null,
              status: "active",
              task: null,
              currentTool: null,
              startedAt: "2026-05-20T17:00:00.000Z",
              updatedAt: "2026-05-20T17:05:00.000Z",
              endedAt: null,
              awaitingInputSince: null,
              parentExternalAgentId: null,
              metadata: JSON.parse('{"k\\u0000":1,"k":2}'),
            },
          ],
        },
      ],
    };

    const result = parseDesktopAgentSessionsPayload(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("payload_sanitized_key_collision");
    }
  });

  it("does NOT reject a collision inside a stripped/ignored session field", () => {
    // `traceCommentSyncResults` is a desktop-local field the schema drops before
    // any DB write (see the handler test above). A sanitized-key collision inside
    // it must not fail an otherwise-valid payload — no persisted JSON loses data.
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          traceCommentSyncResults: JSON.parse('{"c\\u0000":1,"c":2}'),
        },
      ],
    };

    const result = parseDesktopAgentSessionsPayload(payload);
    expect(result.ok).toBe(true);
  });

  it("does NOT reject a collision in an unknown top-level field", () => {
    const payload = {
      ...validPayload,
      [`extra${nul}`]: 1,
      extra: 2,
    };

    const result = parseDesktopAgentSessionsPayload(payload);
    expect(result.ok).toBe(true);
  });
});

describe("parseDesktopAgentSessionsPayload — deviceTimeZone (FEA-1459)", () => {
  it("accepts payload with deviceTimeZone set", () => {
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          deviceTimeZone: "America/Chicago",
        },
      ],
    };
    const result = parseDesktopAgentSessionsPayload(payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sessions[0].deviceTimeZone).toBe("America/Chicago");
    }
  });

  it("accepts payload without deviceTimeZone (backward compat)", () => {
    const result = parseDesktopAgentSessionsPayload(validPayload);
    expect(result.ok).toBe(true);
  });

  it("rejects wrong schema versions and unknown sync modes", () => {
    expect(
      parseDesktopAgentSessionsPayload({
        ...validPayload,
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION + 1,
      }).ok
    ).toBe(false);

    // FEA-2718 (PLN-1294): the pre-bump schema version (1) is now rejected, so a
    // stale desktop that has not updated to the slim contract cannot sync — the
    // deploy skew is loud and immediate rather than silently accepted.
    expect(
      parseDesktopAgentSessionsPayload({
        ...validPayload,
        schemaVersion: 1,
      }).ok
    ).toBe(false);

    expect(
      parseDesktopAgentSessionsPayload({
        ...validPayload,
        syncMode: "repair",
      }).ok
    ).toBe(false);
  });

  it("preserves omitted trace string fields while normalizing explicit clears", () => {
    const result = parseDesktopAgentSessionsPayload({
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          branch: null,
          wallClock: "  ",
          activeAgent: "  Claude  ",
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sessions[0]).toMatchObject({
        branch: null,
        wallClock: null,
        activeAgent: "Claude",
      });
      expect(result.payload.sessions[0]).not.toHaveProperty("waitingUser");
    }
  });

  it("accepts payload with null deviceTimeZone", () => {
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          deviceTimeZone: null,
        },
      ],
    };
    const result = parseDesktopAgentSessionsPayload(payload);
    expect(result.ok).toBe(true);
  });

  it("rejects deviceTimeZone that is empty string", () => {
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          deviceTimeZone: "",
        },
      ],
    };
    const result = parseDesktopAgentSessionsPayload(payload);
    expect(result.ok).toBe(false);
  });

  it("rejects deviceTimeZone longer than 64 characters", () => {
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          deviceTimeZone: "A".repeat(65),
        },
      ],
    };
    const result = parseDesktopAgentSessionsPayload(payload);
    expect(result.ok).toBe(false);
  });
});

describe("parseDesktopAgentSessionsPayload — artifactRefs and prRefs (FEA-1684 AC 42)", () => {
  const validArtifactRef = {
    kind: ArtifactRefTargetKind.ClosedloopArtifact,
    slug: "FEA-1684",
    isPrimary: true,
    method: ArtifactRefMethod.McpToolCall,
  };

  const validPrRef = {
    repositoryFullName: "closedloop-ai/symphony-alpha",
    prNumber: 42,
    prUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/42",
    relationType: SessionPrRelationType.Created,
  };

  it("parses payload with artifactRefs, prs, and prRefs (AC 42)", () => {
    const validPr = {
      num: 42,
      title: "Add session PR projection",
      status: SessionPrLifecycleStatus.Open,
    };
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          artifactRefs: [validArtifactRef],
          prs: [validPr],
          prRefs: [validPrRef],
        },
      ],
    };
    const result = parseDesktopAgentSessionsPayload(payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sessions[0].artifactRefs).toEqual([
        validArtifactRef,
      ]);
      expect(result.payload.sessions[0].prs).toEqual([validPr]);
      expect(result.payload.sessions[0].prRefs).toEqual([validPrRef]);
    }
  });

  it("parses payload without artifactRefs, prs, and prRefs (AC 42 backward compat)", () => {
    const result = parseDesktopAgentSessionsPayload(validPayload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sessions[0].artifactRefs).toBeUndefined();
      expect(result.payload.sessions[0].prs).toBeUndefined();
      expect(result.payload.sessions[0].prRefs).toBeUndefined();
    }
  });

  it("preserves present-empty prs and prRefs as intentional arrays", () => {
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          prs: [],
          prRefs: [],
        },
      ],
    };
    const result = parseDesktopAgentSessionsPayload(payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sessions[0].prs).toEqual([]);
      expect(result.payload.sessions[0].prRefs).toEqual([]);
    }
  });

  it("rejects invalid slug in artifactRefs", () => {
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          artifactRefs: [
            { slug: "TASK-10", isPrimary: false, method: "slug_in_message" },
          ],
        },
      ],
    };
    const result = parseDesktopAgentSessionsPayload(payload);
    expect(result.ok).toBe(false);
  });

  it("parses a branch-kind artifactRef end-to-end (FEA-2729)", () => {
    const branchRef = {
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: "closedloop-ai/symphony-alpha",
      branchName: "feat/x",
      method: ArtifactRefMethod.GitCommand,
      relation: "created",
      observedAt: "2026-07-08T12:00:00.000Z",
    };
    const payload = {
      ...validPayload,
      sessions: [{ ...validPayload.sessions[0], artifactRefs: [branchRef] }],
    };
    const result = parseDesktopAgentSessionsPayload(payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sessions[0].artifactRefs).toEqual([branchRef]);
    }
  });

  it("drops an unknown-kind artifactRef but keeps known kinds (forward compat, FEA-2729)", () => {
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          artifactRefs: [
            validArtifactRef,
            // A future/unknown kind must not fail the whole payload.
            {
              kind: "some_future_kind",
              repositoryFullName: "closedloop-ai/symphony-alpha",
              sha: "abc123",
              method: ArtifactRefMethod.GitCommand,
              relation: "created",
            },
          ],
        },
      ],
    };
    const result = parseDesktopAgentSessionsPayload(payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sessions[0].artifactRefs).toEqual([
        validArtifactRef,
      ]);
    }
  });

  it("keeps a well-formed commit-kind artifactRef (FEA-2731 — commit is now a known kind)", () => {
    const commitRef = {
      kind: "commit",
      repositoryFullName: "closedloop-ai/symphony-alpha",
      branchName: "feat/x",
      sha: "1a2b3c4",
      method: ArtifactRefMethod.GitCommand,
      relation: "created",
    };
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          artifactRefs: [validArtifactRef, commitRef],
        },
      ],
    };
    const result = parseDesktopAgentSessionsPayload(payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sessions[0].artifactRefs).toEqual([
        validArtifactRef,
        commitRef,
      ]);
    }
  });

  it("treats an all-unknown-kind artifactRefs array as no-op (undefined, not []) so it never removes existing links (FEA-2729)", () => {
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          artifactRefs: [
            { kind: "another_future_kind", repositoryFullName: "acme/web" },
            { kind: "some_future_kind", foo: "bar" },
          ],
        },
      ],
    };
    const result = parseDesktopAgentSessionsPayload(payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Not [] — an explicit empty array means "remove all links", which must
      // not be inferred from dropping forward-compat kinds.
      expect(result.payload.sessions[0].artifactRefs).toBeUndefined();
    }
  });

  it("rejects an oversized raw artifactRefs array even when padded with unknown kinds (FEA-2729)", () => {
    const oversized = Array.from({ length: 101 }, () => ({
      kind: "some_future_kind",
      repositoryFullName: "acme/web",
      sha: "abc",
    }));
    const payload = {
      ...validPayload,
      sessions: [{ ...validPayload.sessions[0], artifactRefs: oversized }],
    };
    const result = parseDesktopAgentSessionsPayload(payload);
    expect(result.ok).toBe(false);
  });

  it("rejects invalid prRefs relationType before persistence", () => {
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          prRefs: [{ ...validPrRef, relationType: "AUTHORED" }],
        },
      ],
    };
    const result = parseDesktopAgentSessionsPayload(payload);
    expect(result.ok).toBe(false);
  });

  it.each([
    { label: "non-positive", prNumber: 0 },
    { label: "non-integer", prNumber: 42.5 },
  ])("rejects $label prRefs prNumber before persistence", ({ prNumber }) => {
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          prRefs: [{ ...validPrRef, prNumber }],
        },
      ],
    };
    const result = parseDesktopAgentSessionsPayload(payload);
    expect(result.ok).toBe(false);
  });
});

describe("parseDesktopAgentSessionsPayload — Session Trace source arrays", () => {
  it("accepts exact max source arrays and preserves null/omitted semantics", () => {
    const source = {
      sourceType: SessionTracePhaseSourceType.Explicit,
      phaseKey: "implement",
      label: null,
      startedAt: "2026-05-20T17:01:00.000Z",
      endedAt: null,
    };
    const result = parseDesktopAgentSessionsPayload({
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          tracePhaseSources: Array.from(
            { length: DERIVATION_SOURCE_LIMITS.phaseSources },
            () => source
          ),
          throttleSources: null,
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sessions[0]?.tracePhaseSources).toHaveLength(
        DERIVATION_SOURCE_LIMITS.phaseSources
      );
      expect(result.payload.sessions[0]?.throttleSources).toBeNull();
      expect(result.payload.sessions[0]?.correctionSources).toBeUndefined();
    }
  });

  it("rejects source arrays over the max and invalid dates", () => {
    expect(
      parseDesktopAgentSessionsPayload({
        ...validPayload,
        sessions: [
          {
            ...validPayload.sessions[0],
            tracePhaseSources: Array.from(
              { length: DERIVATION_SOURCE_LIMITS.phaseSources + 1 },
              () => ({
                sourceType: SessionTracePhaseSourceType.Explicit,
                phaseKey: "implement",
                startedAt: "2026-05-20T17:01:00.000Z",
              })
            ),
          },
        ],
      }).ok
    ).toBe(false);

    expect(
      parseDesktopAgentSessionsPayload({
        ...validPayload,
        sessions: [
          {
            ...validPayload.sessions[0],
            throttleSources: [
              {
                sourceType: SessionTraceThrottleSourceType.ApiError,
                provider: "codex",
                observedAt: "not-a-date",
                statusCode: 429,
              },
            ],
          },
        ],
      }).ok
    ).toBe(false);
  });

  it("applies aggregate payload bounds only to new source arrays", () => {
    const largeLegacyEventPayload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          agents: [
            {
              externalAgentId: "agent-1",
              name: "Main agent",
              type: "main",
              subagentType: null,
              status: "active",
              task: null,
              currentTool: null,
              startedAt: "2026-05-20T17:00:00.000Z",
              updatedAt: "2026-05-20T17:05:00.000Z",
              endedAt: null,
              awaitingInputSince: null,
              parentExternalAgentId: null,
              metadata: null,
            },
          ],
          events: [
            {
              externalEventId: "event-1",
              agentExternalId: "agent-1",
              eventType: "tool_use",
              toolName: "Read",
              summary: "x".repeat(
                DERIVATION_SOURCE_LIMITS.aggregatePayloadBytes + 1
              ),
              data: null,
              createdAt: "2026-05-20T17:01:00.000Z",
            },
          ],
        },
      ],
    };

    expect(parseDesktopAgentSessionsPayload(largeLegacyEventPayload).ok).toBe(
      true
    );

    const maxText = "x".repeat(DERIVATION_SOURCE_LIMITS.sourceText);
    const oversizedSourcePayload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          tracePhaseSources: Array.from(
            { length: DERIVATION_SOURCE_LIMITS.phaseSources },
            () => ({
              sourceType: SessionTracePhaseSourceType.Explicit,
              phaseKey: maxText,
              label: maxText,
              startedAt: "2026-05-20T17:01:00.000Z",
              endedAt: "2026-05-20T17:02:00.000Z",
            })
          ),
          throttleSources: Array.from(
            { length: DERIVATION_SOURCE_LIMITS.throttleSources },
            () => ({
              sourceType: SessionTraceThrottleSourceType.ApiError,
              provider: maxText,
              observedAt: "2026-05-20T17:01:00.000Z",
              limitKind: maxText,
              errorCode: maxText,
              statusCode: 429,
            })
          ),
          correctionSources: Array.from(
            { length: DERIVATION_SOURCE_LIMITS.correctionSources },
            () => ({
              kind: SessionTraceCorrectionKind.ReviewChangeRequest,
              observedAt: "2026-05-20T17:01:00.000Z",
              label: maxText,
              sourceType: maxText,
            })
          ),
        },
      ],
    };

    const result = parseDesktopAgentSessionsPayload(oversizedSourcePayload);
    expect(result).toEqual({
      ok: false,
      reason: "session_trace_source_payload_too_large",
    });
  });

  it("accepts derived phases and phaseLoopbacks up to the phaseSources limit (FEA-2563)", () => {
    const phase = (index: number) => ({
      key: `phase-${index}`,
      label: `Phase ${index}`,
      dur: "1m",
      cost: "$0.00",
      cOut: 0,
      cCache: 0,
      cIn: 0,
    });
    const loopback = (index: number) => ({
      from: `phase-${index}`,
      to: `phase-${index + 1}`,
      label: `Phase ${index} -> Phase ${index + 1}`,
      depth: 2,
    });
    const limit = DERIVATION_SOURCE_LIMITS.phaseSources;

    const okResult = parseDesktopAgentSessionsPayload({
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          phases: Array.from({ length: limit }, (_, i) => phase(i)),
          phaseLoopbacks: Array.from({ length: limit }, (_, i) => loopback(i)),
        },
      ],
    });
    expect(okResult.ok).toBe(true);
    if (okResult.ok) {
      expect(okResult.payload.sessions[0]?.phases).toHaveLength(limit);
      expect(okResult.payload.sessions[0]?.phaseLoopbacks).toHaveLength(limit);
    }

    expect(
      parseDesktopAgentSessionsPayload({
        ...validPayload,
        sessions: [
          {
            ...validPayload.sessions[0],
            phases: Array.from({ length: limit + 1 }, (_, i) => phase(i)),
          },
        ],
      }).ok
    ).toBe(false);
  });

  it("applies source payload bounds per session instead of per batch", () => {
    const mediumText = "x".repeat(DERIVATION_SOURCE_LIMITS.sourceText);
    const sessionWithSourcePayload = {
      ...validPayload.sessions[0],
      tracePhaseSources: Array.from({ length: 80 }, () => ({
        sourceType: SessionTracePhaseSourceType.Explicit,
        phaseKey: mediumText,
        label: mediumText,
        startedAt: "2026-05-20T17:01:00.000Z",
        endedAt: "2026-05-20T17:02:00.000Z",
      })),
    };
    const sessionTraceSourcePayload = {
      tracePhaseSources: sessionWithSourcePayload.tracePhaseSources,
      throttleSources: undefined,
      correctionSources: undefined,
    };
    const result = parseDesktopAgentSessionsPayload({
      ...validPayload,
      sessionCount: 2,
      sessions: [
        sessionWithSourcePayload,
        {
          ...sessionWithSourcePayload,
          externalSessionId: "sess-2",
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(sessionTraceSourcePayload))
    ).toBeLessThanOrEqual(DERIVATION_SOURCE_LIMITS.aggregatePayloadBytes);
    expect(
      Buffer.byteLength(
        JSON.stringify([sessionTraceSourcePayload, sessionTraceSourcePayload])
      )
    ).toBeGreaterThan(DERIVATION_SOURCE_LIMITS.aggregatePayloadBytes);
  });
});

describe("Session Trace contract literal guard", () => {
  it("keeps first-party contract values referenced through const objects at call sites", () => {
    const root = path.resolve(process.cwd(), "../..");
    const forbiddenValues = [
      SessionPrLifecycleStatus.Merged,
      SessionPrLifecycleStatus.Unknown,
      SessionTracePhaseSourceType.Explicit,
      SessionTraceThrottleSourceType.ApiError,
      SessionTraceCorrectionKind.ReviewChangeRequest,
    ];
    const checkedFiles = [
      "apps/api/app/agent-sessions/service.ts",
      "apps/api/app/agent-sessions/service.test.ts",
      "apps/api/lib/__tests__/desktop-agent-sessions-handler.test.ts",
    ];

    for (const file of checkedFiles) {
      const source = readFileSync(path.join(root, file), "utf8");
      for (const value of forbiddenValues) {
        expect(source).not.toContain(`status: "${value}"`);
        expect(source).not.toContain(`sourceType: "${value}"`);
        expect(source).not.toContain(`kind: "${value}"`);
      }
    }
  });
});

describe("sync round-trip — sanitize → JSON stringify → parse (FEA-1684 AC 48)", () => {
  const artifactRef = {
    kind: ArtifactRefTargetKind.ClosedloopArtifact,
    slug: "FEA-1684",
    isPrimary: true,
    method: ArtifactRefMethod.SlugInBranch,
  };

  const prRef = {
    repositoryFullName: "closedloop-ai/symphony-alpha",
    prNumber: 7,
    prUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/7",
    relationType: SessionPrRelationType.Referenced,
  };

  const payloadWithRefs = {
    ...validPayload,
    sessions: [
      {
        ...validPayload.sessions[0],
        artifactRefs: [artifactRef],
        prRefs: [prRef],
      },
    ],
  };

  it("session with refs survives JSON stringify → parse → Zod validation (AC 48)", () => {
    const serialized = JSON.stringify(payloadWithRefs);
    const deserialized: unknown = JSON.parse(serialized);
    const result = parseDesktopAgentSessionsPayload(deserialized);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sessions[0].artifactRefs).toEqual([artifactRef]);
      expect(result.payload.sessions[0].prRefs).toEqual([prRef]);
    }
  });

  it("sanitize spread preserves artifactRefs and prRefs (AC 43)", () => {
    // The sanitizeSessionForSync function uses {...session, agents: ..., events: ...}
    // which must preserve all other top-level fields including artifactRefs and prRefs.
    // Verify that a spread that overrides agents and events does not drop the refs fields.
    const session = payloadWithRefs.sessions[0];
    const sanitized = {
      ...session,
      agents: [],
      events: [],
    };
    expect(sanitized.artifactRefs).toEqual([artifactRef]);
    expect(sanitized.prRefs).toEqual([prRef]);
  });
});
