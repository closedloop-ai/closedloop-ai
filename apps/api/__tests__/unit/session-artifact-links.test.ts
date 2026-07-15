/**
 * Unit tests for the FEA-1684 cloud ingestion helpers.
 *
 * Coverage targets:
 *   1. parseDesktopAgentSessionsPayload — backward compat: payloads with and
 *      without artifactRefs / prRefs both parse correctly (AC 56).
 *   2. agentSessionsService.getArtifactSessionUsage — attribution query DTO
 *      shape, zero-sessions early return, byModel sort order (AC 65).
 *
 * The private helpers (resolveArtifactSlugMap, mergeArtifactRefsBySlug,
 * roleFromMethod, persistArtifactLinks, persistSessionPrArtifactLinks) are not
 * exported; their logic is validated in-package via the public API and through
 * the type tests in packages/api/src/types/session-artifact-link.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- module-level mocks (must appear before service import) -----------------

vi.mock("@repo/database", () => ({
  Prisma: { DbNull: "DbNull" },
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import {
  type ArtifactSessionUsageSummary,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { withDb } from "@repo/database";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { parseDesktopAgentSessionsPayload } from "@/lib/desktop-agent-sessions-schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCHEMA_VER = AGENT_SESSION_SYNC_SCHEMA_VERSION;

/** Minimal valid session object (no FEA-1684 fields) */
function buildMinimalSession(id = "sess-1") {
  return {
    externalSessionId: id,
    status: "completed",
    harness: "claude",
    cwd: "/tmp",
    model: "claude-sonnet-4",
    startedAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-01T10:05:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
  };
}

/** Valid RFC 4122 v4 UUID for use in payloads. */
const TEST_BATCH_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

/** Minimal valid payload envelope */
function buildPayload(sessions: unknown[] = [buildMinimalSession()]) {
  return {
    schemaVersion: SCHEMA_VER,
    batchId: TEST_BATCH_ID,
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: sessions.length,
    sessions,
  };
}

function getMockWithDb() {
  return withDb as unknown as ReturnType<typeof vi.fn> & {
    tx: ReturnType<typeof vi.fn>;
  };
}

// ---------------------------------------------------------------------------
// parseDesktopAgentSessionsPayload — backward compat (AC 56)
// ---------------------------------------------------------------------------

describe("parseDesktopAgentSessionsPayload — backward compatibility", () => {
  it("accepts a session with no artifactRefs and no prRefs", () => {
    const result = parseDesktopAgentSessionsPayload(buildPayload());
    expect(result.ok).toBe(true);
  });

  it("accepts a session with artifactRefs present", () => {
    const session = {
      ...buildMinimalSession(),
      artifactRefs: [
        { slug: "FEA-1684", isPrimary: true, method: "mcp_tool_call" },
      ],
    };
    const result = parseDesktopAgentSessionsPayload(buildPayload([session]));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.payload.sessions[0]?.artifactRefs).toHaveLength(1);
  });

  it("accepts a session with prRefs present", () => {
    const session = {
      ...buildMinimalSession(),
      prRefs: [
        {
          repositoryFullName: "closedloop-ai/symphony-alpha",
          prNumber: 42,
          prUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/42",
          relationType: SessionPrRelationType.Created,
        },
      ],
    };
    const result = parseDesktopAgentSessionsPayload(buildPayload([session]));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.payload.sessions[0]?.prRefs).toHaveLength(1);
  });

  it("accepts a session with both artifactRefs and prRefs", () => {
    const session = {
      ...buildMinimalSession(),
      artifactRefs: [
        { slug: "PLN-5", isPrimary: false, method: "slug_in_branch" },
      ],
      prRefs: [
        {
          repositoryFullName: "org/repo",
          prNumber: 1,
          prUrl: "https://github.com/org/repo/pull/1",
          relationType: SessionPrRelationType.Referenced,
        },
      ],
    };
    const result = parseDesktopAgentSessionsPayload(buildPayload([session]));
    expect(result.ok).toBe(true);
  });

  it("returns ok=false when an artifactRef has an invalid slug", () => {
    const session = {
      ...buildMinimalSession(),
      artifactRefs: [
        { slug: "TASK-999", isPrimary: false, method: "slug_in_message" },
      ],
    };
    const result = parseDesktopAgentSessionsPayload(buildPayload([session]));
    expect(result.ok).toBe(false);
    // The first parse issue under sessions[*] maps to "session_invalid"
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("session_invalid");
  });

  it("returns ok=false when a prRef has a non-positive prNumber (0)", () => {
    const session = {
      ...buildMinimalSession(),
      prRefs: [
        {
          repositoryFullName: "org/repo",
          prNumber: 0,
          prUrl: "https://github.com/org/repo/pull/0",
          relationType: SessionPrRelationType.Created,
        },
      ],
    };
    const result = parseDesktopAgentSessionsPayload(buildPayload([session]));
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Const-object enum values (AC 59)
// ---------------------------------------------------------------------------

describe("SessionPrRelationType enum values", () => {
  it("SessionPrRelationType.Created is 'CREATED'", () => {
    expect(SessionPrRelationType.Created).toBe("CREATED");
  });

  it("SessionPrRelationType.Referenced is 'REFERENCED'", () => {
    expect(SessionPrRelationType.Referenced).toBe("REFERENCED");
  });
});

// ---------------------------------------------------------------------------
// agentSessionsService.getArtifactSessionUsage (AC 65)
// ---------------------------------------------------------------------------

describe("agentSessionsService.getArtifactSessionUsage", () => {
  const ORG_ID = "org-1";
  const ARTIFACT_ID = "artifact-1";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the artifact does not exist", async () => {
    getMockWithDb().mockResolvedValueOnce(null);

    const result = await agentSessionsService.getArtifactSessionUsage(
      ORG_ID,
      ARTIFACT_ID
    );

    expect(result).toBeNull();
  });

  it("returns zero-count summary when no session links exist", async () => {
    getMockWithDb()
      // artifact lookup
      .mockResolvedValueOnce({ id: ARTIFACT_ID, slug: "FEA-1684" })
      // artifactLink.findMany — no links
      .mockResolvedValueOnce([]);

    const result = await agentSessionsService.getArtifactSessionUsage(
      ORG_ID,
      ARTIFACT_ID
    );

    expect(result).not.toBeNull();
    const summary = result as ArtifactSessionUsageSummary;
    expect(summary.artifactId).toBe(ARTIFACT_ID);
    expect(summary.artifactSlug).toBe("FEA-1684");
    expect(summary.sessionCount).toBe(0);
    expect(summary.inputTokens).toBe(0);
    expect(summary.outputTokens).toBe(0);
    expect(summary.cacheReadTokens).toBe(0);
    expect(summary.cacheWriteTokens).toBe(0);
    expect(summary.estimatedCostUsd).toBe(0);
    expect(summary.byModel).toEqual([]);
  });

  it("aggregates totals and byModel rows when sessions exist", async () => {
    getMockWithDb()
      // artifact lookup
      .mockResolvedValueOnce({ id: ARTIFACT_ID, slug: "FEA-1684" })
      // artifactLink.findMany — two linked sessions
      .mockResolvedValueOnce([
        { sourceId: "session-a" },
        { sourceId: "session-b" },
      ])
      // Promise.all([aggregate, groupBy])
      .mockResolvedValueOnce([
        {
          _count: { _all: 2 },
          _sum: {
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadTokens: 200,
            cacheWriteTokens: 100,
            estimatedCost: 0.05,
          },
        },
        [
          {
            model: "claude-sonnet-4",
            _sum: {
              inputTokens: 1000,
              outputTokens: 500,
              cacheReadTokens: 200,
              cacheWriteTokens: 100,
              estimatedCost: 0.05,
            },
          },
        ],
      ]);

    const result = await agentSessionsService.getArtifactSessionUsage(
      ORG_ID,
      ARTIFACT_ID
    );

    expect(result).not.toBeNull();
    const summary = result as ArtifactSessionUsageSummary;
    expect(summary.sessionCount).toBe(2);
    expect(summary.inputTokens).toBe(1000);
    expect(summary.outputTokens).toBe(500);
    expect(summary.cacheReadTokens).toBe(200);
    expect(summary.cacheWriteTokens).toBe(100);
    expect(summary.estimatedCostUsd).toBeCloseTo(0.05);
    expect(summary.byModel).toHaveLength(1);
    expect(summary.byModel[0]?.model).toBe("claude-sonnet-4");
  });

  it("sorts byModel rows by estimatedCostUsd descending", async () => {
    getMockWithDb()
      .mockResolvedValueOnce({ id: ARTIFACT_ID, slug: null })
      .mockResolvedValueOnce([{ sourceId: "session-a" }])
      .mockResolvedValueOnce([
        {
          _count: { _all: 1 },
          _sum: {
            inputTokens: 500,
            outputTokens: 200,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            estimatedCost: 0.03,
          },
        },
        [
          {
            model: "claude-haiku-3",
            _sum: {
              inputTokens: 100,
              outputTokens: 50,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              estimatedCost: 0.001,
            },
          },
          {
            model: "claude-sonnet-4",
            _sum: {
              inputTokens: 400,
              outputTokens: 150,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              estimatedCost: 0.029,
            },
          },
        ],
      ]);

    const result = await agentSessionsService.getArtifactSessionUsage(
      ORG_ID,
      ARTIFACT_ID
    );

    const summary = result as ArtifactSessionUsageSummary;
    expect(summary.byModel[0]?.model).toBe("claude-sonnet-4");
    expect(summary.byModel[1]?.model).toBe("claude-haiku-3");
  });

  it("uses artifactId and null slug from the resolved artifact row", async () => {
    getMockWithDb()
      // artifact with no slug
      .mockResolvedValueOnce({ id: ARTIFACT_ID, slug: null })
      // no links
      .mockResolvedValueOnce([]);

    const result = await agentSessionsService.getArtifactSessionUsage(
      ORG_ID,
      ARTIFACT_ID
    );

    const summary = result as ArtifactSessionUsageSummary;
    expect(summary.artifactId).toBe(ARTIFACT_ID);
    expect(summary.artifactSlug).toBeNull();
  });

  it("scopes the link lookup to the organization", async () => {
    const findManySpy = vi.fn().mockResolvedValue([]);
    const findFirstSpy = vi
      .fn()
      .mockResolvedValue({ id: ARTIFACT_ID, slug: "FEA-1684" });
    const db = {
      artifact: { findFirst: findFirstSpy },
      artifactLink: { findMany: findManySpy },
    };
    getMockWithDb().mockImplementation((cb: (client: typeof db) => unknown) =>
      cb(db)
    );

    await agentSessionsService.getArtifactSessionUsage(ORG_ID, ARTIFACT_ID);

    expect(findManySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG_ID,
          targetId: ARTIFACT_ID,
          source: expect.objectContaining({ organizationId: ORG_ID }),
        }),
      })
    );
  });
});
