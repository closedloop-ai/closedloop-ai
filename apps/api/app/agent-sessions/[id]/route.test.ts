import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../../../__tests__/utils/auth-helpers";

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, context: { params: Promise<unknown> }) =>
      handler(mockAuthContext, request, context.params),
}));

vi.mock("../service", () => ({
  agentSessionsService: {
    findSessionDetail: vi.fn(),
  },
}));

import { agentSessionsService } from "../service";
import { GET } from "./route";

const SESSION_ID = "01997d8e-3b2e-7c6a-8f1a-1b2c3d4e5f60";
const NOT_A_UUID = "not-a-uuid";
/**
 * What `artifactTagPermissionsForAuth` resolves for a Clerk SESSION caller:
 * `hasApiKeyScopes` short-circuits true off the session auth method, so both
 * capabilities are granted. The api-key case below is the control that pins
 * these as DERIVED rather than a constant the route hands down.
 */
const SESSION_AUTH_TAG_PERMISSIONS = { canApply: true, canRemove: true };

function getAs(id: string) {
  return GET(
    createMockRequest({ url: `http://localhost:3002/agent-sessions/${id}` }),
    createMockRouteContext({ id })
  );
}

describe("GET /agent-sessions/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    vi.mocked(agentSessionsService.findSessionDetail).mockResolvedValue(
      buildDetail()
    );
  });

  it("returns manual state with unchanged status, origin, and trace fields", async () => {
    const response = await getAs(SESSION_ID);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: expect.objectContaining({
        id: SESSION_ID,
        status: "active",
        origin: "DESKTOP_SYNC",
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
      tagPermissions: SESSION_AUTH_TAG_PERMISSIONS,
    });
  });

  it("passes status and origin through the service boundary unchanged", async () => {
    vi.mocked(agentSessionsService.findSessionDetail).mockResolvedValue(
      buildDetail({})
    );

    const response = await getAs(SESSION_ID);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: expect.objectContaining({
        status: "active",
        origin: "DESKTOP_SYNC",
      }),
    });
  });

  // FEA-4155 (whitlockk review #3789): the session detail read is no longer gated on
  // the winding-down `DESKTOP_AGENT_SESSION_SYNC` monitoring flag — the surface
  // is always-on, so the detail must resolve for any in-org caller and never 403
  // as the flag winds down. Org-scoping (`organizationId` in the service read)
  // remains the boundary.
  it("returns the detail without a monitoring-flag gate (FEA-4155)", async () => {
    const response = await getAs(SESSION_ID);

    expect(response.status).toBe(200);
    expect(agentSessionsService.findSessionDetail).toHaveBeenCalledWith({
      id: SESSION_ID,
      organizationId: "test-org-id",
      tagPermissions: SESSION_AUTH_TAG_PERMISSIONS,
    });
  });

  // ISS-10436: `SessionDetail.artifactId` is `@db.Uuid`, so a non-UUID id used
  // to reach Prisma, raise P2023, and fall out of `withAuth` as a 500.
  it("answers 404 for an id that is not a UUID, before the service is asked", async () => {
    const response = await getAs(NOT_A_UUID);

    expect(response.status).toBe(404);
    expect(agentSessionsService.findSessionDetail).not.toHaveBeenCalled();
  });

  it("hands a v7 UUID to the service unchanged", async () => {
    const response = await getAs(SESSION_ID);

    expect(response.status).toBe(200);
    expect(agentSessionsService.findSessionDetail).toHaveBeenCalledTimes(1);
    expect(agentSessionsService.findSessionDetail).toHaveBeenCalledWith({
      id: SESSION_ID,
      organizationId: "test-org-id",
      tagPermissions: SESSION_AUTH_TAG_PERMISSIONS,
    });
  });

  // ISS-10995: without this the read serves neither `tags` nor
  // `tagAvailability`, and the Details tab's Tags row never draws — the row the
  // ticket exists to make editable. Two auth shapes, because one cannot tell a
  // derived capability from a constant.
  it("resolves the caller's tag capabilities from its own scopes", async () => {
    mockAuthContext = createTestAuthContext({
      apiKeyScopes: ["read", "write"],
      authMethod: "api_key",
    });

    await getAs(SESSION_ID);

    expect(agentSessionsService.findSessionDetail).toHaveBeenCalledWith({
      id: SESSION_ID,
      organizationId: "test-org-id",
      // `delete` is absent from the key's scopes, so removal is not granted.
      tagPermissions: { canApply: true, canRemove: false },
    });
  });

  it("maps missing sessions to not found", async () => {
    vi.mocked(agentSessionsService.findSessionDetail).mockResolvedValue(null);

    const response = await getAs(SESSION_ID);

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
    harness: "claude",
    cwd: "/tmp/worktree",
    repositoryFullName: "closedloop-ai/closedloop-ai",
    repo: "closedloop-ai/closedloop-ai",
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

// ISS-12197: the Details-tab fields are additive and optional on the wire. A
// detail that predates them (an older producer) must cross the route with the
// keys ABSENT — never defaulted to `null`, which would claim a read that found
// nothing where nothing was read.
describe("GET /agent-sessions/[id] with a pre-ISS-12197 detail shape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  it("serves the old shape without inventing the ownership keys", async () => {
    const detail = buildDetail();
    expect(detail).not.toHaveProperty("createdBy");
    vi.mocked(agentSessionsService.findSessionDetail).mockResolvedValue(detail);

    const response = await getAs(SESSION_ID);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).not.toHaveProperty("createdAt");
    expect(body.data).not.toHaveProperty("createdBy");
    expect(body.data).not.toHaveProperty("dueDate");
  });
});
