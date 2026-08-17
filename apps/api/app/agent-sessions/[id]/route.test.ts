import {
  type AgentSessionDetail,
  AgentSessionState,
} from "@repo/api/src/types/agent-session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../../../__tests__/utils/auth-helpers";

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context.params),
}));

vi.mock("../service", () => ({
  agentSessionsService: {
    findSessionDetail: vi.fn(),
  },
}));

import { agentSessionsService } from "../service";
import { GET } from "./route";

const SESSION_ID = "session-1";

describe("GET /agent-sessions/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    vi.mocked(agentSessionsService.findSessionDetail).mockResolvedValue(
      buildDetail()
    );
  });

  it("returns manual state with unchanged status, origin, and trace fields", async () => {
    const response = await GET(
      createMockRequest({
        url: `http://localhost:3002/agent-sessions/${SESSION_ID}`,
      }),
      createMockRouteContext({ id: SESSION_ID })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: expect.objectContaining({
        id: SESSION_ID,
        state: AgentSessionState.Blocked,
        status: "active",
        origin: "DESKTOP_SYNC",
        timeline: [
          expect.objectContaining({
            kind: "tool",
            title: "Read",
            tl: 0,
          }),
        ],
        turnItems: [
          expect.objectContaining({
            type: "tools",
            _row: 0,
          }),
        ],
      }),
    });
    expect(agentSessionsService.findSessionDetail).toHaveBeenCalledWith({
      id: SESSION_ID,
      organizationId: "test-org-id",
    });
  });

  it("returns fallback state values from the service boundary", async () => {
    vi.mocked(agentSessionsService.findSessionDetail).mockResolvedValue(
      buildDetail({ state: AgentSessionState.Completed })
    );

    const response = await GET(
      createMockRequest({
        url: `http://localhost:3002/agent-sessions/${SESSION_ID}`,
      }),
      createMockRouteContext({ id: SESSION_ID })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: expect.objectContaining({
        state: AgentSessionState.Completed,
        status: "active",
        origin: "DESKTOP_SYNC",
      }),
    });
  });

  // FEA-4155 (wongk review #3789): the session detail read is no longer gated on
  // the winding-down `DESKTOP_AGENT_SESSION_SYNC` monitoring flag — the surface
  // is always-on, so the detail must resolve for any in-org caller and never 403
  // as the flag winds down. Org-scoping (`organizationId` in the service read)
  // remains the boundary.
  it("returns the detail without a monitoring-flag gate (FEA-4155)", async () => {
    const response = await GET(
      createMockRequest({
        url: `http://localhost:3002/agent-sessions/${SESSION_ID}`,
      }),
      createMockRouteContext({ id: SESSION_ID })
    );

    expect(response.status).toBe(200);
    expect(agentSessionsService.findSessionDetail).toHaveBeenCalledWith({
      id: SESSION_ID,
      organizationId: "test-org-id",
    });
  });

  it("maps missing sessions to not found", async () => {
    vi.mocked(agentSessionsService.findSessionDetail).mockResolvedValue(null);

    const response = await GET(
      createMockRequest({
        url: `http://localhost:3002/agent-sessions/${SESSION_ID}`,
      }),
      createMockRouteContext({ id: SESSION_ID })
    );

    expect(response.status).toBe(404);
  });
});

function buildDetail(
  overrides: Partial<AgentSessionDetail> = {}
): AgentSessionDetail {
  return {
    id: SESSION_ID,
    slug: "SES-1",
    externalSessionId: "external-session-1",
    name: "Session One",
    status: "active",
    origin: "DESKTOP_SYNC",
    state: AgentSessionState.Blocked,
    harness: "claude",
    cwd: "/tmp/worktree",
    repositoryFullName: "closedloop-ai/symphony-alpha",
    repo: "closedloop-ai/symphony-alpha",
    worktreePath: "/tmp/worktree",
    model: "claude-sonnet-4",
    primaryModel: "claude-sonnet-4",
    models: ["claude-sonnet-4"],
    branch: "fea-1771",
    prs: [],
    prsMerged: 0,
    cost: "$1.25",
    wallClock: "10m",
    activeAgent: "8m",
    waitingUser: null,
    linesAdded: 10,
    linesRemoved: 2,
    filesChanged: 1,
    turns: 2,
    toolCallsTotal: 1,
    steeringEpisodes: 0,
    autonomy: 80,
    tokensIn: 10,
    tokensOut: 5,
    cache: 0,
    cacheWrite: 0,
    userColor: null,
    activityBuckets: [],
    span: null,
    markers: [],
    throttles: [],
    phases: [],
    phaseIterations: {},
    phaseLoopbacks: [],
    startedAt: new Date("2026-05-20T17:00:00.000Z"),
    updatedAt: new Date("2026-05-20T17:05:00.000Z"),
    lastActivityAt: new Date("2026-05-20T17:05:00.000Z"),
    lastSyncedAt: new Date("2026-05-20T17:05:00.000Z"),
    endedAt: null,
    awaitingInputSince: null,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 1.25,
    agentCount: 1,
    toolUseCount: 1,
    errorCount: 0,
    baseBranch: "main",
    sourceArtifactId: null,
    sourceArtifact: null,
    sourceLoopId: null,
    user: null,
    computeTarget: {
      id: "target-1",
      machineName: "Test Target",
      isOnline: true,
      lastSeenAt: new Date("2026-05-20T17:05:00.000Z"),
      lastAgentSessionSyncAt: new Date("2026-05-20T17:05:00.000Z"),
    },
    project: null,
    metadata: null,
    tokenUsageByModel: [],
    attribution: null,
    agents: [],
    events: [],
    timeline: [
      {
        t: "2026-05-20T17:01:00.000Z",
        tMs: Date.parse("2026-05-20T17:01:00.000Z"),
        kind: "tool",
        title: "Read",
        tl: 0,
      },
    ],
    turnItems: [
      {
        type: "tools",
        _row: 0,
        t: "2026-05-20T17:01:00.000Z",
        tMs: Date.parse("2026-05-20T17:01:00.000Z"),
        endMs: Date.parse("2026-05-20T17:01:00.000Z"),
        cum: 0,
        actor: {
          name: "claude-sonnet-4",
          sessionId: SESSION_ID,
          human: null,
          color: "var(--primary)",
          harness: "claude",
        },
        summary: "Ran 1 tool",
        items: [{ label: "Read", detail: "", err: false }],
        hasFail: false,
        failN: 0,
        cats: { tool: 1 },
      },
    ],
    ...overrides,
  };
}
