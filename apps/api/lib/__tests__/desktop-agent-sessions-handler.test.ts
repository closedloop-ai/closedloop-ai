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
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import {
  DesktopAgentSessionsRateLimiter,
  handleDesktopAgentSessionsEvent,
} from "../desktop-agent-sessions-handler";
import { parseDesktopAgentSessionsPayload } from "../desktop-agent-sessions-schema";

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
        issueId: null,
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
  });

  it("returns ingestion_failed for ingestion failures", async () => {
    await expect(
      handleDesktopAgentSessionsEvent(validPayload, baseContext, {
        isFeatureEnabled: async () => true,
        upsertBatch: () => Promise.reject(new Error("db down")),
      })
    ).resolves.toEqual({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.IngestionFailed,
    });
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

  it("parses payload with artifactRefs and prRefs (AC 42)", () => {
    const payload = {
      ...validPayload,
      sessions: [
        {
          ...validPayload.sessions[0],
          artifactRefs: [validArtifactRef],
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
      expect(result.payload.sessions[0].prRefs).toEqual([validPrRef]);
    }
  });

  it("parses payload without artifactRefs and prRefs (AC 42 backward compat)", () => {
    const result = parseDesktopAgentSessionsPayload(validPayload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sessions[0].artifactRefs).toBeUndefined();
      expect(result.payload.sessions[0].prRefs).toBeUndefined();
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
