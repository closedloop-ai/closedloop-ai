import { SESSION_STATUS } from "@closedloop-ai/loops-api/session-status";
import { SessionPrLifecycleStatus } from "@repo/api/src/session-trace/derivation";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionState,
  AgentSessionSyncMode,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { ArtifactType } from "@repo/api/src/types/artifact";
import { DocumentType, PullRequestState } from "@repo/api/src/types/document";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dbNull: Symbol("db-null"),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  emitTelemetryMetric: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  Prisma: {
    DbNull: mocks.dbNull,
  },
  withDb: mocks.withDb,
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mocks.emitTelemetryMetric,
}));

import { agentSessionsService, toLocalDateOnly } from "./service";

const SESSION_STARTED_AT = new Date("2026-05-20T17:00:00.000Z");
const SESSION_UPDATED_AT = new Date("2026-05-20T17:05:00.000Z");

function installDb(db: Record<string, unknown>) {
  const dbWithDefaults = { $executeRaw: vi.fn(), ...db };
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
  mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
}

function buildSyncedSession(overrides: Partial<SyncedAgentSession> = {}) {
  return {
    externalSessionId: "sess-1",
    name: "Session One",
    status: "active",
    harness: "claude",
    cwd: "/tmp/worktree",
    model: "claude-sonnet-4",
    startedAt: SESSION_STARTED_AT.toISOString(),
    updatedAt: SESSION_UPDATED_AT.toISOString(),
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...overrides,
  };
}

function buildDefaultAgentSessionMocks(
  overrides: Record<string, unknown> = {}
) {
  return {
    findUnique: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue({ artifactId: "persisted-session-1" }),
    update: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

// generateSlug() allocates a SES-* slug via slugCounter.upsert inside the sync
// transaction when a session artifact is first created.
function buildSlugCounterMock(overrides: Record<string, unknown> = {}) {
  return {
    upsert: vi.fn().mockResolvedValue({ currentValue: 1 }),
    ...overrides,
  };
}

function buildAgentSessionDbMock(overrides: Record<string, unknown> = {}) {
  return {
    findUnique: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function buildDefaultAgentSessionEventMocks(
  overrides: Record<string, unknown> = {}
) {
  return {
    count: vi.fn().mockResolvedValue(0),
    // PLN-1034: persistSessionChildren derives last_activity_at from the latest
    // event time; default to none so it floors at the session start.
    aggregate: vi.fn().mockResolvedValue({ _max: { eventCreatedAt: null } }),
    ...overrides,
  };
}

function buildPersistedAgent(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    externalAgentId: "agent-1",
    name: "Existing agent",
    type: "main",
    status: "active",
    subagentType: null,
    task: null,
    currentTool: null,
    startedAt: SESSION_STARTED_AT.toISOString(),
    updatedAt: SESSION_UPDATED_AT.toISOString(),
    endedAt: null,
    awaitingInputSince: null,
    parentExternalAgentId: null,
    metadata: null,
    ...overrides,
  };
}

function buildPersistedEvent(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    externalEventId: "event-1",
    agentExternalId: "agent-1",
    eventType: "tool_use",
    toolName: "Read",
    summary: null,
    data: undefined,
    createdAt: SESSION_STARTED_AT.toISOString(),
    ...overrides,
  };
}

function buildSessionListRecord(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    artifactId: "session-1",
    externalSessionId: "external-session-1",
    harness: "claude",
    cwd: "/tmp/worktree",
    repositoryFullName: "closedloop-ai/symphony-alpha",
    worktreePath: "/tmp/worktree",
    model: "claude-sonnet-4",
    sessionStartedAt: SESSION_STARTED_AT,
    sessionUpdatedAt: SESSION_UPDATED_AT,
    sessionEndedAt: new Date("2026-05-20T17:10:00.000Z"),
    awaitingInputSince: null,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 1.25,
    agentCount: 2,
    toolUseCount: 3,
    errorCount: 0,
    issueId: null,
    baseBranch: "main",
    sourceArtifactId: null,
    sourceLoopId: null,
    user: {
      id: "user-1",
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      avatarUrl: null,
    },
    computeTarget: {
      id: "target-1",
      machineName: "Ada's MacBook Pro",
      isOnline: true,
      lastSeenAt: SESSION_UPDATED_AT,
    },
    // Hoisted fields now live on the parent artifact (FEA-1699).
    artifact: {
      name: "Session One",
      status: "completed",
      slug: "SES-1",
      project: {
        id: "project-1",
        name: "Agent Platform",
        slug: "agent-platform",
      },
      sessionPrLinks: [],
    },
    ...overrides,
  };
}

function buildSessionDetailRecord(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ...buildSessionListRecord(),
    origin: "DESKTOP_SYNC",
    state: null,
    branch: null,
    issues: null,
    pullRequests: null,
    wallClock: null,
    activeAgent: null,
    waitingUser: null,
    linesAdded: null,
    linesRemoved: null,
    filesChanged: null,
    turns: null,
    steeringEpisodes: null,
    autonomy: null,
    activityBuckets: null,
    sessionSpan: null,
    markers: null,
    throttles: null,
    phases: null,
    phaseIterations: null,
    phaseLoopbacks: null,
    metadata: null,
    tokenUsageByModel: [],
    agents: [],
    events: [],
    ...overrides,
  };
}

function buildSourceArtifactRecord(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: "0196f2df-5b7d-7e72-9e4c-8d8af9fba001",
    name: "Agent Platform PRD",
    slug: "agent-platform-prd",
    type: ArtifactType.Document,
    subtype: DocumentType.Prd,
    ...overrides,
  };
}

function buildAnalyticsScalarRecord(
  index: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    artifactId: `session-${index}`,
    repositoryFullName: "closedloop-ai/symphony-alpha",
    inputTokens: 10,
    outputTokens: 5,
    estimatedCost: 0.25,
    errorCount: 0,
    artifact: {
      projectId: "project-1",
      project: {
        id: "project-1",
        name: "Agent Platform",
        slug: "agent-platform",
      },
    },
    ...overrides,
  };
}

function buildAnalyticsJsonRecord(
  index: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    artifactId: `session-${index}`,
    agents: [],
    events: [],
    ...overrides,
  };
}

describe("agentSessionsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("projects manual state separately from legacy status and origin", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            state: AgentSessionState.InReview,
            origin: "LOOP",
            artifact: {
              name: "Session One",
              status: "completed",
              slug: "SES-1",
              project: null,
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]).toMatchObject({
      status: "completed",
      origin: "LOOP",
      state: AgentSessionState.InReview,
    });
  });

  it("falls back to a conservative state for old rows without mutating storage", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            state: null,
            awaitingInputSince: new Date("2026-05-20T17:03:00.000Z"),
            sessionEndedAt: null,
            artifact: {
              name: "Waiting Session",
              status: "waiting",
              slug: "SES-2",
              project: null,
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]?.state).toBe(AgentSessionState.PendingApproval);
  });

  it("treats ended old rows with stale active status as completed", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            state: null,
            awaitingInputSince: null,
            sessionEndedAt: new Date("2026-05-20T17:10:00.000Z"),
            artifact: {
              name: "Ended Session",
              status: "active",
              slug: "SES-3",
              project: null,
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]?.state).toBe(AgentSessionState.Completed);
  });

  it("deduplicates legacy pull request JSON when a trusted session PR link exists", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            pullRequests: [
              {
                num: 17,
                title: "Legacy title",
                status: SessionPrLifecycleStatus.Merged,
              },
            ],
            artifact: {
              name: "Session One",
              status: "completed",
              slug: "SES-1",
              project: null,
              sessionPrLinks: [
                {
                  repositoryFullName: "closedloop-ai/symphony-alpha",
                  prNumber: 17,
                  prUrl:
                    "https://github.com/closedloop-ai/symphony-alpha/pull/17",
                  relationType: "referenced",
                  pullRequestDetail: {
                    number: 17,
                    title: "Trusted title",
                    prState: PullRequestState.Merged,
                    closedAt: null,
                    mergedAt: new Date("2026-05-20T17:10:00.000Z"),
                    lastVerifiedAt: new Date("2026-05-20T17:09:00.000Z"),
                    isCurrent: true,
                    repository: {
                      fullName: "closedloop-ai/symphony-alpha",
                    },
                  },
                },
              ],
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]?.prs).toEqual([
      {
        num: 17,
        title: "Trusted title",
        status: SessionPrLifecycleStatus.Merged,
      },
    ]);
    expect(result.items[0]?.prsMerged).toBe(1);
  });

  it("deduplicates repository-less legacy pull request JSON when a trusted session PR link exists", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            repositoryFullName: null,
            pullRequests: [
              {
                num: 17,
                title: "Repository-less legacy title",
                status: SessionPrLifecycleStatus.Merged,
              },
            ],
            artifact: {
              name: "Session One",
              status: "completed",
              slug: "SES-1",
              project: null,
              sessionPrLinks: [
                {
                  repositoryFullName: "closedloop-ai/symphony-alpha",
                  prNumber: 17,
                  prUrl:
                    "https://github.com/closedloop-ai/symphony-alpha/pull/17",
                  relationType: "referenced",
                  pullRequestDetail: {
                    number: 17,
                    title: "Trusted title",
                    prState: PullRequestState.Merged,
                    closedAt: null,
                    mergedAt: new Date("2026-05-20T17:10:00.000Z"),
                    lastVerifiedAt: new Date("2026-05-20T17:09:00.000Z"),
                    isCurrent: true,
                    repository: {
                      fullName: "closedloop-ai/symphony-alpha",
                    },
                  },
                },
              ],
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]?.prs).toEqual([
      {
        num: 17,
        title: "Trusted title",
        status: SessionPrLifecycleStatus.Merged,
      },
    ]);
    expect(result.items[0]?.prsMerged).toBe(1);
  });

  it("keeps current pull request details unknown until they have verification freshness", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            artifact: {
              name: "Session One",
              status: "completed",
              slug: "SES-1",
              project: null,
              sessionPrLinks: [
                {
                  repositoryFullName: "closedloop-ai/symphony-alpha",
                  prNumber: 17,
                  prUrl:
                    "https://github.com/closedloop-ai/symphony-alpha/pull/17",
                  relationType: "referenced",
                  pullRequestDetail: {
                    number: 17,
                    title: "Unverified title",
                    prState: PullRequestState.Merged,
                    closedAt: null,
                    mergedAt: new Date("2026-05-20T17:10:00.000Z"),
                    lastVerifiedAt: null,
                    isCurrent: true,
                    repository: {
                      fullName: "closedloop-ai/symphony-alpha",
                    },
                  },
                },
              ],
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]?.prs).toEqual([
      {
        num: 17,
        title: "PR #17",
        status: SessionPrLifecycleStatus.Unknown,
      },
    ]);
    expect(result.items[0]?.prsMerged).toBe(0);
  });

  it("preserves legacy pull request status when linked details are unverified", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            pullRequests: [
              {
                num: 17,
                title: "Legacy title",
                status: SessionPrLifecycleStatus.Merged,
              },
            ],
            artifact: {
              name: "Session One",
              status: "completed",
              slug: "SES-1",
              project: null,
              sessionPrLinks: [
                {
                  repositoryFullName: "closedloop-ai/symphony-alpha",
                  prNumber: 17,
                  prUrl:
                    "https://github.com/closedloop-ai/symphony-alpha/pull/17",
                  relationType: "referenced",
                  pullRequestDetail: {
                    number: 17,
                    title: "Unverified title",
                    prState: PullRequestState.Open,
                    closedAt: null,
                    mergedAt: null,
                    lastVerifiedAt: null,
                    isCurrent: true,
                    repository: {
                      fullName: "closedloop-ai/symphony-alpha",
                    },
                  },
                },
              ],
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]?.prs).toEqual([
      {
        num: 17,
        title: "Legacy title",
        status: SessionPrLifecycleStatus.Merged,
      },
    ]);
    expect(result.items[0]?.prsMerged).toBe(1);
  });

  it("persists sync trace fields without overwriting manual state", async () => {
    const sessionUpsert = vi
      .fn()
      .mockResolvedValue({ artifactId: "persisted-session-1" });

    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks({ upsert: sessionUpsert }),
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });

    await agentSessionsService.upsertSessions(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
      },
      {
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        batchId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba001",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 1,
        sessions: [
          buildSyncedSession({
            branch: "fea-1771",
            issues: ["FEA-1771"],
            prs: [
              {
                num: 123,
                title: "Trace backend",
                status: SessionPrLifecycleStatus.Merged,
              },
            ],
            linesAdded: 10,
            linesRemoved: 2,
            tracePhaseSources: [],
            throttleSources: [],
            correctionSources: [],
            phases: [],
            phaseIterations: {},
            phaseLoopbacks: [],
            throttles: [],
            markers: [],
          }),
        ],
      }
    );

    const createData = sessionUpsert.mock.calls[0]?.[0].create;
    const updateData = sessionUpsert.mock.calls[0]?.[0].update;
    expect(createData).toMatchObject({
      branch: "fea-1771",
      linesAdded: 10,
      linesRemoved: 2,
      tracePhaseSources: [],
      throttleSources: [],
      correctionSources: [],
      phases: [],
      phaseIterations: {},
      phaseLoopbacks: [],
      throttles: [],
      markers: [],
    });
    expect(updateData).toMatchObject({
      branch: "fea-1771",
      linesAdded: 10,
      linesRemoved: 2,
      tracePhaseSources: [],
      throttleSources: [],
      correctionSources: [],
      phases: [],
      phaseIterations: {},
      phaseLoopbacks: [],
      throttles: [],
      markers: [],
    });
    expect(createData).not.toHaveProperty("state");
    expect(updateData).not.toHaveProperty("state");
  });

  it("deletes deterministic PR links on present-empty prRefs replay", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks(),
      sessionPullRequestLink: { deleteMany },
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });

    await agentSessionsService.upsertSessions(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
      },
      {
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        batchId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba002",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 1,
        sessions: [buildSyncedSession({ prRefs: [] })],
      }
    );

    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        sessionArtifactId: "persisted-session-1",
        source: "DETERMINISTIC",
      },
    });
  });

  it("keeps stored state visible after sync conflict through persisted detail projection", async () => {
    let persistedRecord: Record<string, unknown> | null = null;
    const syncWritableColumns = [
      "harness",
      "cwd",
      "model",
      "branch",
      "issues",
      "pullRequests",
      "linesAdded",
      "linesRemoved",
      "sessionStartedAt",
      "sessionUpdatedAt",
      "sessionEndedAt",
      "awaitingInputSince",
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "estimatedCost",
      "agentCount",
      "metadata",
      "agents",
      "lastSyncedAt",
    ];

    const applySyncWrite = (data: Record<string, unknown>) => {
      const artifactWrite = data.artifact as
        | {
            create?: { name?: string; status?: string; slug?: string };
            update?: { name?: string; status?: string };
          }
        | undefined;
      const artifactData: { name?: string; status?: string; slug?: string } =
        artifactWrite?.create ?? artifactWrite?.update ?? {};

      persistedRecord = {
        ...buildSessionDetailRecord(persistedRecord ?? {}),
        artifactId: "persisted-session-1",
        externalSessionId: "sess-1",
        origin: "DESKTOP_SYNC",
        userId: "user-1",
        computeTarget: {
          id: "target-1",
          machineName: "Ada's MacBook Pro",
          isOnline: true,
          lastSeenAt: SESSION_UPDATED_AT,
        },
        artifact: {
          name: artifactData.name ?? "Session One",
          status: artifactData.status ?? "active",
          slug:
            artifactData.slug ??
            (
              persistedRecord?.artifact as
                | { slug?: string; project?: unknown }
                | undefined
            )?.slug ??
            "SES-1",
          project:
            (
              persistedRecord?.artifact as
                | { slug?: string; project?: unknown }
                | undefined
            )?.project ?? null,
        },
      };

      for (const column of syncWritableColumns) {
        if (Object.hasOwn(data, column)) {
          persistedRecord[column] = data[column];
        }
      }
    };

    const sessionUpsert = vi.fn().mockImplementation((args) => {
      const data = persistedRecord ? args.update : args.create;
      applySyncWrite(data);
      return { artifactId: "persisted-session-1" };
    });
    const sessionUpdate = vi.fn().mockImplementation(({ data }) => {
      if (persistedRecord) {
        persistedRecord = { ...persistedRecord, ...data };
      }
      return persistedRecord;
    });

    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: {
        findUnique: vi.fn().mockImplementation(() =>
          persistedRecord
            ? {
                artifactId: "persisted-session-1",
                agents: persistedRecord.agents,
              }
            : null
        ),
        upsert: sessionUpsert,
        update: sessionUpdate,
        findFirst: vi.fn().mockImplementation(() => persistedRecord),
      },
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });

    const payloadBase = {
      schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
      batchId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba001",
      syncMode: AgentSessionSyncMode.Incremental,
      sessionCount: 1,
    };

    await agentSessionsService.upsertSessions(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
      },
      {
        ...payloadBase,
        sessions: [
          buildSyncedSession({
            status: SESSION_STATUS.ACTIVE,
            branch: "fea-1771",
            linesAdded: 10,
            linesRemoved: 2,
          }),
        ],
      }
    );
    persistedRecord = {
      ...buildSessionDetailRecord(persistedRecord ?? {}),
      state: AgentSessionState.Blocked,
    };
    await agentSessionsService.upsertSessions(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
      },
      {
        ...payloadBase,
        batchId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba002",
        sessions: [
          buildSyncedSession({
            status: SESSION_STATUS.COMPLETED,
            branch: "fea-1771-resynced",
            linesAdded: 20,
            linesRemoved: 4,
          }),
        ],
      }
    );

    const detail = await agentSessionsService.findSessionDetail({
      id: "persisted-session-1",
      organizationId: "org-1",
    });

    expect(sessionUpsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        update: expect.not.objectContaining({
          state: expect.anything(),
        }),
      })
    );
    expect(detail).toMatchObject({
      id: "persisted-session-1",
      status: SESSION_STATUS.COMPLETED,
      state: AgentSessionState.Blocked,
      branch: "fea-1771-resynced",
      linesAdded: 20,
      linesRemoved: 4,
    });
  });

  it("coalesces duplicate per-model token usage before persisting session usage rows", async () => {
    const sessionUpsert = vi
      .fn()
      .mockResolvedValue({ artifactId: "persisted-session-1" });
    const createMany = vi.fn().mockResolvedValue({ count: 2 });

    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks({ upsert: sessionUpsert }),
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany,
      },
    });

    await agentSessionsService.upsertSessions(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
        gatewaySessionId: "gateway-session-1",
      },
      {
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        batchId: "7bf9fe88-9a77-471d-a0ce-2b14a7fd5f4a",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 1,
        sessions: [
          buildSyncedSession({
            tokenUsageByModel: [
              {
                model: "claude-sonnet-4",
                inputTokens: 10,
                outputTokens: 2,
                cacheReadTokens: 1,
                cacheWriteTokens: 0,
                estimatedCostUsd: 0.01,
              },
              {
                model: "claude-sonnet-4",
                inputTokens: 5,
                outputTokens: 3,
                cacheReadTokens: 0,
                cacheWriteTokens: 2,
                estimatedCostUsd: 0.02,
              },
              {
                model: "gpt-4.1",
                inputTokens: 1,
                outputTokens: 4,
                cacheReadTokens: 3,
                cacheWriteTokens: 0,
                estimatedCostUsd: 0.03,
              },
            ],
          }),
        ],
      }
    );

    expect(sessionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          inputTokens: 16,
          outputTokens: 9,
          cacheReadTokens: 4,
          cacheWriteTokens: 2,
          estimatedCost: 0.06,
        }),
        update: expect.objectContaining({
          inputTokens: 16,
          outputTokens: 9,
          cacheReadTokens: 4,
          cacheWriteTokens: 2,
          estimatedCost: 0.06,
        }),
      })
    );
    expect(createMany).toHaveBeenCalledWith({
      data: [
        {
          agentSessionId: "persisted-session-1",
          model: "claude-sonnet-4",
          inputTokens: 15,
          outputTokens: 5,
          cacheReadTokens: 1,
          cacheWriteTokens: 2,
          estimatedCost: 0.03,
        },
        {
          agentSessionId: "persisted-session-1",
          model: "gpt-4.1",
          inputTokens: 1,
          outputTokens: 4,
          cacheReadTokens: 3,
          cacheWriteTokens: 0,
          estimatedCost: 0.03,
        },
      ],
    });
  });

  it("persists deviceTimeZone from sync payload into create and update branches", async () => {
    const sessionUpsert = vi
      .fn()
      .mockResolvedValue({ artifactId: "persisted-session-1" });

    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks({ upsert: sessionUpsert }),
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });

    await agentSessionsService.upsertSessions(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
        gatewaySessionId: "gateway-session-1",
      },
      {
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        batchId: "7bf9fe88-9a77-471d-a0ce-2b14a7fd5f4a",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 1,
        sessions: [buildSyncedSession({ deviceTimeZone: "America/Chicago" })],
      }
    );

    expect(sessionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          deviceTimeZone: "America/Chicago",
        }),
        update: expect.objectContaining({
          deviceTimeZone: "America/Chicago",
        }),
      })
    );
  });

  it("does not write deviceTimeZone when field is omitted from payload", async () => {
    // Older Desktop builds omit deviceTimeZone. The column must be left
    // untouched on update (never nulled over a previously synced zone) and
    // simply absent on create (DB default null).
    const sessionUpsert = vi
      .fn()
      .mockResolvedValue({ artifactId: "persisted-session-1" });

    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks({ upsert: sessionUpsert }),
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });

    await agentSessionsService.upsertSessions(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
        gatewaySessionId: "gateway-session-1",
      },
      {
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        batchId: "7bf9fe88-9a77-471d-a0ce-2b14a7fd5f4a",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 1,
        sessions: [buildSyncedSession()],
      }
    );

    const upsertArgs = sessionUpsert.mock.calls[0][0];
    expect(upsertArgs.create).not.toHaveProperty("deviceTimeZone");
    expect(upsertArgs.update).not.toHaveProperty("deviceTimeZone");
  });

  it("delays session cost rounding until after cross-model aggregation", async () => {
    const sessionUpsert = vi
      .fn()
      .mockResolvedValue({ artifactId: "persisted-session-1" });

    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks({ upsert: sessionUpsert }),
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    });

    await agentSessionsService.upsertSessions(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
      },
      {
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        batchId: "7bf9fe88-9a77-471d-a0ce-2b14a7fd5f4a",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 1,
        sessions: [
          buildSyncedSession({
            tokenUsageByModel: [
              {
                model: "claude-sonnet-4",
                inputTokens: 1,
                outputTokens: 1,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                estimatedCostUsd: 0.000_000_6,
              },
              {
                model: "gpt-4.1",
                inputTokens: 1,
                outputTokens: 1,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                estimatedCostUsd: 0.000_000_6,
              },
            ],
          }),
        ],
      }
    );

    expect(sessionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          estimatedCost: 0.000_001,
        }),
        update: expect.objectContaining({
          estimatedCost: 0.000_001,
        }),
      })
    );
  });

  it("upserts events into child table and recomputes counts from full event set", async () => {
    const executeRawUnsafe = vi.fn().mockResolvedValue(2);
    const eventCount = vi
      .fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);
    const sessionUpdate = vi.fn().mockResolvedValue({});

    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks({ update: sessionUpdate }),
      agentSessionEvent: buildDefaultAgentSessionEventMocks({
        count: eventCount,
      }),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      $executeRawUnsafe: executeRawUnsafe,
    });

    await agentSessionsService.upsertSessions(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
      },
      {
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        batchId: "chunk-batch-1",
        syncMode: AgentSessionSyncMode.Backfill,
        sessionCount: 1,
        sessions: [
          buildSyncedSession({
            events: [
              {
                externalEventId: "event-1",
                agentExternalId: "agent-1",
                eventType: "tool_use",
                toolName: "Read",
                summary: null,
                data: {
                  filePath: "src/safe.ts",
                  output: "secret output",
                  tool_input: {
                    command: "pnpm",
                    args: ["test", "service"],
                    prompt: "secret prompt",
                  },
                  tool_response: {
                    status: "success",
                    stdout: "secret stdout",
                    durationMs: 42,
                  },
                },
                createdAt: SESSION_STARTED_AT.toISOString(),
              },
              {
                externalEventId: "event-2",
                agentExternalId: "agent-1",
                eventType: "runtime_error",
                toolName: null,
                summary: "something broke",
                createdAt: SESSION_UPDATED_AT.toISOString(),
              },
            ],
          }),
        ],
      }
    );

    expect(executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining(`INSERT INTO "agent_session_events"`),
      "persisted-session-1",
      "event-1",
      "agent-1",
      "tool_use",
      "Read",
      null,
      JSON.stringify({
        filePath: "src/safe.ts",
        output: "[redacted]",
        tool_input: {
          command: "pnpm",
          args: ["test", "service"],
          prompt: "[redacted]",
        },
        tool_response: {
          status: "success",
          stdout: "[redacted]",
          durationMs: 42,
        },
      }),
      SESSION_STARTED_AT,
      "persisted-session-1",
      "event-2",
      "agent-1",
      "runtime_error",
      null,
      null,
      null,
      SESSION_UPDATED_AT
    );
    // Regression: `id` PK must be supplied inline — Prisma's client-side
    // @default(uuid(7)) does not apply to raw SQL, and the column has no
    // DB default, so omitting it produces 23502 on every new event.
    const insertSql = String(executeRawUnsafe.mock.calls[0]?.[0] ?? "");
    expect(insertSql).toContain('"id"');
    expect(insertSql).toContain("gen_random_uuid()");

    expect(eventCount).toHaveBeenNthCalledWith(1, {
      where: {
        agentSessionId: "persisted-session-1",
        OR: [
          { eventType: "tool_use" },
          { AND: [{ toolName: { not: null } }, { toolName: { not: "" } }] },
        ],
      },
    });
    expect(eventCount).toHaveBeenNthCalledWith(2, {
      where: {
        agentSessionId: "persisted-session-1",
        // ERROR_EVENT_PATTERN (/error|fail/i) expressed as case-insensitive
        // substring predicates so persisted errorCount matches the in-memory
        // aggregateByTool classifier and the desktop countErrorEvents.
        OR: [
          { eventType: { contains: "error", mode: "insensitive" } },
          { eventType: { contains: "fail", mode: "insensitive" } },
        ],
      },
    });
    expect(sessionUpdate).toHaveBeenCalledWith({
      where: { artifactId: "persisted-session-1" },
      // PLN-1034: the same update also writes the derived lastActivityAt.
      data: expect.objectContaining({ toolUseCount: 1, errorCount: 1 }),
    });
  });

  it("projects detail events with deterministic ordering and useful tool details", async () => {
    const findFirst = vi.fn().mockResolvedValue(
      buildSessionDetailRecord({
        state: AgentSessionState.Running,
        artifact: {
          name: "Session One",
          status: SESSION_STATUS.ACTIVE,
          slug: "SES-1",
          project: null,
        },
        events: [
          {
            id: "00000000-0000-0000-0000-000000000001",
            externalEventId: "event-b",
            agentExternalId: "agent-1",
            eventType: "human_prompt",
            toolName: null,
            summary: null,
            data: { prompt: "secret prompt", filePath: "prompts/task.md" },
            eventCreatedAt: SESSION_STARTED_AT,
          },
          {
            id: "00000000-0000-0000-0000-000000000002",
            externalEventId: "event-c",
            agentExternalId: "agent-1",
            eventType: "tool_use",
            toolName: "Read",
            summary: "secret summary",
            data: {
              filePath: "src/safe.ts",
              output: "secret output",
              tool_response: {
                stdout: "secret stdout",
                status: "success",
              },
            },
            eventCreatedAt: SESSION_STARTED_AT,
          },
        ],
      })
    );

    installDb({
      sessionDetail: { findFirst },
    });

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          events: {
            orderBy: [
              { eventCreatedAt: "asc" },
              { externalEventId: "asc" },
              { id: "asc" },
            ],
          },
        }),
      })
    );
    expect(result?.events).toEqual([
      expect.objectContaining({
        externalEventId: "event-b",
        summary: null,
        data: { prompt: "[redacted]", filePath: "prompts/task.md" },
      }),
      expect.objectContaining({
        externalEventId: "event-c",
        summary: null,
        data: {
          filePath: "src/safe.ts",
          output: "[redacted]",
          tool_response: {
            stdout: "[redacted]",
            status: "success",
          },
        },
      }),
    ]);
    expect(JSON.stringify(result?.timeline)).not.toContain("secret prompt");
    expect(JSON.stringify(result?.timeline)).not.toContain("secret summary");
    expect(JSON.stringify(result?.turnItems)).not.toContain("secret output");
    expect(
      result?.timeline?.find((event) => event.title === "Read")?.detail
    ).toBe("src/safe.ts · success");
  });

  it("persists synced branchDiffStats into dedicated columns and rehydrates it on detail", async () => {
    let persistedRecord: Record<string, unknown> | null = null;
    const branchColumns = [
      "branchLinesAdded",
      "branchLinesRemoved",
      "branchFilesChanged",
      "branchLocSource",
    ];

    const sessionUpsert = vi.fn().mockImplementation((args) => {
      const data = (persistedRecord ? args.update : args.create) as Record<
        string,
        unknown
      >;
      persistedRecord = {
        ...buildSessionDetailRecord(persistedRecord ?? {}),
        artifactId: "persisted-session-1",
      };
      for (const column of branchColumns) {
        if (Object.hasOwn(data, column)) {
          persistedRecord[column] = data[column];
        }
      }
      return { artifactId: "persisted-session-1" };
    });

    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: sessionUpsert,
        update: vi.fn().mockResolvedValue({}),
        findFirst: vi.fn().mockImplementation(() => persistedRecord),
      },
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });

    await agentSessionsService.upsertSessions(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
      },
      {
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        batchId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba003",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 1,
        sessions: [
          buildSyncedSession({
            branchDiffStats: {
              linesAdded: 42,
              linesRemoved: 7,
              filesChanged: 3,
              source: "git",
            },
          }),
        ],
      }
    );

    // Branch LOC lands in its own columns, never colliding with the gitDiffStats
    // scalars (which stay null here because the payload carried no git stats).
    expect(sessionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          branchLinesAdded: 42,
          branchLinesRemoved: 7,
          branchFilesChanged: 3,
          branchLocSource: "git",
        }),
      })
    );

    const detail = await agentSessionsService.findSessionDetail({
      id: "persisted-session-1",
      organizationId: "org-1",
    });

    expect(detail?.branchDiffStats).toEqual({
      linesAdded: 42,
      linesRemoved: 7,
      filesChanged: 3,
      source: "git",
    });
    expect(detail?.gitDiffStats).toBeNull();
  });

  it("projects detail metadata messages into timeline and turn rows", async () => {
    installDb({
      sessionDetail: {
        findFirst: vi.fn().mockResolvedValue(
          buildSessionDetailRecord({
            metadata: {
              kind: "fixture",
              messages: [
                {
                  role: "human",
                  timestamp: "2026-05-20T17:00:00.000Z",
                  text: "Please inspect the failing test.",
                },
                {
                  role: "assistant",
                  timestamp: "2026-05-20T17:01:00.000Z",
                  text: "I found the failing assertion.",
                  model: "gpt-5.5",
                },
                {
                  role: "human",
                  timestamp: "2026-05-20T17:02:00.000Z",
                },
              ],
            },
          })
        ),
      },
    });

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    expect(
      result?.timeline
        ?.slice(0, 3)
        .map((event) => [event.kind, event.title, event.detail])
    ).toEqual([
      ["human", "human", "Please inspect the failing test."],
      ["say", "gpt-5.5", "I found the failing assertion."],
      ["human", "human", undefined],
    ]);
    expect(
      result?.turnItems
        ?.slice(0, 3)
        .map((item) => [item.type, "text" in item ? item.text : null])
    ).toEqual([
      ["prompt", "Please inspect the failing test."],
      ["say", "I found the failing assertion."],
      ["prompt", ""],
    ]);
  });

  it("projects subagent agents into redaction-safe turn items", async () => {
    installDb({
      sessionDetail: {
        findFirst: vi.fn().mockResolvedValue(
          buildSessionDetailRecord({
            model: "gpt-5.5",
            agents: [
              buildPersistedAgent({
                externalAgentId: "agent-main",
                name: "Main worker",
                type: "main",
              }),
              buildPersistedAgent({
                externalAgentId: "agent-review",
                name: "Review lane",
                type: "subagent",
                subagentType: "review",
                status: "failed",
                task: "Check contract coverage.",
                startedAt: "2026-05-20T17:01:00.000Z",
                updatedAt: "2026-05-20T17:03:00.000Z",
                endedAt: "2026-05-20T17:03:00.000Z",
                parentExternalAgentId: "agent-main",
              }),
            ],
            events: [
              {
                id: "00000000-0000-0000-0000-000000000010",
                externalEventId: "event-subagent",
                agentExternalId: "agent-review",
                eventType: "tool_error",
                toolName: "vitest",
                summary: "raw subagent summary must not leak",
                data: { output: "secret subagent output" },
                eventCreatedAt: new Date("2026-05-20T17:02:00.000Z"),
              },
            ],
          })
        ),
      },
    });

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    const subagentTurn = result?.turnItems?.find(
      (item) => item.type === "subagent"
    );
    expect(subagentTurn).toMatchObject({
      type: "subagent",
      sub: "Review lane",
      subagentType: "review",
      status: "failed",
      model: "gpt-5.5",
      duration: "2m",
      body: expect.arrayContaining([
        { kind: "task", text: "Check contract coverage." },
        {
          kind: "tool",
          text: "vitest",
          t: "2026-05-20T17:02:00.000Z",
          err: true,
        },
        {
          kind: "status",
          text: "failed",
          t: "2026-05-20T17:03:00.000Z",
          err: true,
        },
      ]),
    });
    expect(JSON.stringify(subagentTurn)).not.toContain(
      "secret subagent output"
    );
    expect(JSON.stringify(subagentTurn)).not.toContain("raw subagent summary");
  });

  it("falls back safely for malformed persisted trace JSON", async () => {
    installDb({
      sessionDetail: {
        findFirst: vi.fn().mockResolvedValue(
          buildSessionDetailRecord({
            pullRequests: [{ num: 1 }],
            activityBuckets: [{ label: "bad bucket" }],
            sessionSpan: { first: "00:00:00" },
            markers: [{ kind: "commit", x: 200 }],
            throttles: "not-json",
            phases: [{ key: "build" }],
            phaseIterations: { build: -1 },
            phaseLoopbacks: [{ from: "ship" }],
          })
        ),
      },
    });

    const result = await agentSessionsService.findSessionDetail({
      id: "session-1",
      organizationId: "org-1",
    });

    expect(result).toMatchObject({
      prs: [],
      activityBuckets: [],
      span: null,
      markers: [],
      throttles: [],
      phases: [],
      phaseIterations: {},
      phaseLoopbacks: [],
    });
  });

  it("merges agents with existing session data by external ID", async () => {
    const findUnique = vi.fn().mockResolvedValue({
      agents: [
        {
          externalAgentId: "agent-1",
          name: "main",
          type: "main",
          status: "active",
        },
      ],
    });
    const sessionUpsert = vi
      .fn()
      .mockResolvedValue({ artifactId: "persisted-session-1" });

    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks({
        findUnique,
        upsert: sessionUpsert,
      }),
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });

    await agentSessionsService.upsertSessions(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
      },
      {
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        batchId: "chunk-batch-2",
        syncMode: AgentSessionSyncMode.Backfill,
        sessionCount: 1,
        sessions: [
          buildSyncedSession({
            agents: [
              {
                externalAgentId: "agent-2",
                name: "subagent",
                type: "subagent",
                status: "completed",
              },
            ],
          }),
        ],
      }
    );

    const updateArg = sessionUpsert.mock.calls[0][0].update;
    expect(updateArg.agents).toHaveLength(2);
    expect(
      updateArg.agents.map(
        (a: { externalAgentId: string }) => a.externalAgentId
      )
    ).toEqual(["agent-1", "agent-2"]);
  });

  it("exports zero-usage sessions with a fallback model row", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          {
            sessionStartedAt: SESSION_STARTED_AT,
            harness: "claude",
            model: "claude-sonnet-4",
            user: {
              id: "user-1",
              email: "ada@example.com",
              firstName: "Ada",
              lastName: "Lovelace",
              avatarUrl: null,
              teamMemberships: [
                {
                  team: {
                    name: "Platform",
                  },
                },
              ],
            },
            artifact: {
              project: {
                name: "Agent Platform",
              },
            },
            tokenUsageByModel: [],
          },
        ]),
      },
      organization: {
        findUnique: vi.fn().mockResolvedValue({ slug: "closedloop" }),
      },
    });

    await expect(
      agentSessionsService.findExportRows({
        organizationId: "org-1",
        filters: {},
      })
    ).resolves.toEqual({
      orgSlug: "closedloop",
      rows: [
        {
          date: "2026-05-20",
          user: "Ada Lovelace",
          team: "Platform",
          project: "Agent Platform",
          harnessType: "claude",
          model: "claude-sonnet-4",
          sessionCount: 1,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          estimatedCost: 0,
        },
      ],
    });
  });

  it("keyset-paginates the export and aggregates across batches", async () => {
    const makeExportSession = (artifactId: string) => ({
      artifactId,
      sessionStartedAt: SESSION_STARTED_AT,
      harness: "claude",
      model: "claude-sonnet-4",
      user: {
        id: "user-1",
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        avatarUrl: null,
        teamMemberships: [{ team: { name: "Platform" } }],
      },
      artifact: { project: { name: "Agent Platform" } },
      tokenUsageByModel: [],
    });

    // First page is exactly full (EXPORT_BATCH_SIZE = 1000) so the loop fetches a
    // second page; both pages share one aggregation key.
    const firstPage = Array.from({ length: 1000 }, (_unused, index) =>
      makeExportSession(`s-${index}`)
    );
    const secondPage = [makeExportSession("s-1000")];
    const findMany = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage);

    installDb({
      sessionDetail: { findMany },
      organization: {
        findUnique: vi.fn().mockResolvedValue({ slug: "closedloop" }),
      },
    });

    const result = await agentSessionsService.findExportRows({
      organizationId: "org-1",
      filters: {},
    });

    // 1000 + 1 sessions collapse into a single aggregated row.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.sessionCount).toBe(1001);

    // Two queries: the second is cursored on the last artifactId of page one.
    expect(findMany).toHaveBeenCalledTimes(2);
    const secondCallArg = findMany.mock.calls[1]?.[0] as {
      take: number;
      skip: number;
      cursor: { artifactId: string };
    };
    expect(secondCallArg.take).toBe(1000);
    expect(secondCallArg.skip).toBe(1);
    expect(secondCallArg.cursor).toEqual({ artifactId: "s-999" });
  });

  it("splits usage summary costs by linked loop apiKeySource", async () => {
    installDb({
      sessionDetail: buildAgentSessionDbMock({
        aggregate: vi.fn().mockResolvedValue({
          _count: { _all: 4 },
          _sum: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 10,
            cacheWriteTokens: 5,
            estimatedCost: 1.5,
          },
          _min: { sessionStartedAt: new Date("2026-03-01T10:00:00.000Z") },
          _max: { sessionStartedAt: new Date("2026-03-14T10:00:00.000Z") },
        }),
        groupBy: vi
          .fn()
          .mockResolvedValueOnce([
            {
              userId: "user-1",
              _count: { _all: 4 },
              _sum: {
                inputTokens: 100,
                outputTokens: 50,
                cacheReadTokens: 10,
                cacheWriteTokens: 5,
                estimatedCost: 1.5,
              },
            },
          ])
          .mockResolvedValueOnce([
            {
              harness: "claude",
              _count: { _all: 4 },
              _sum: {
                inputTokens: 100,
                outputTokens: 50,
                cacheReadTokens: 10,
                cacheWriteTokens: 5,
                estimatedCost: 1.5,
              },
            },
          ])
          .mockResolvedValueOnce([
            {
              repositoryFullName: "acme/web",
              _count: { _all: 4 },
              _sum: {
                inputTokens: 100,
                outputTokens: 50,
                estimatedCost: 1.5,
                errorCount: 1,
              },
            },
            {
              repositoryFullName: null,
              _count: { _all: 1 },
              _sum: {
                inputTokens: 0,
                outputTokens: 0,
                estimatedCost: 0,
                errorCount: 0,
              },
            },
          ])
          // Fourth sessionDetail.groupBy call: cost split grouped by
          // sourceLoopId and billingMode. Loop-originated rows are classified by
          // the loop's apiKeySource; DESKTOP_SYNC rows (null sourceLoopId) are
          // classified by their synced billingMode — a subscription/seat mode
          // counts toward subscription cost, anything else toward API cost.
          // Binary-exact values so the subscription/API sums compare equal under
          // toEqual without floating-point drift.
          .mockResolvedValueOnce([
            {
              sourceLoopId: "loop-subscription",
              billingMode: null,
              _sum: { estimatedCost: 0.5 },
            },
            {
              sourceLoopId: "loop-api",
              billingMode: null,
              _sum: { estimatedCost: 0.25 },
            },
            // DESKTOP_SYNC, subscription/seat billingMode → subscription cost.
            {
              sourceLoopId: null,
              billingMode: "pro",
              _sum: { estimatedCost: 0.125 },
            },
            // DESKTOP_SYNC, API billingMode → API cost.
            {
              sourceLoopId: null,
              billingMode: "api",
              _sum: { estimatedCost: 0.125 },
            },
            // DESKTOP_SYNC, legacy null billingMode → API cost.
            {
              sourceLoopId: null,
              billingMode: null,
              _sum: { estimatedCost: 0.125 },
            },
            {
              sourceLoopId: "loop-missing",
              billingMode: null,
              _sum: { estimatedCost: 0.25 },
            },
          ]),
      }),
      agentSessionTokenUsage: {
        groupBy: vi.fn().mockResolvedValue([
          {
            model: "claude-sonnet-4",
            _count: { _all: 4 },
            _sum: {
              inputTokens: 100,
              outputTokens: 50,
              cacheReadTokens: 10,
              cacheWriteTokens: 5,
              estimatedCost: 1.5,
            },
          },
        ]),
      },
      computeTarget: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      user: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "user-1",
            email: "ada@example.com",
            firstName: "Ada",
            lastName: "Lovelace",
            avatarUrl: null,
          },
        ]),
      },
      loop: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "loop-subscription",
            metadata: { apiKeySource: "none" },
          },
          {
            id: "loop-api",
            metadata: { apiKeySource: "organization" },
          },
        ]),
      },
    });

    await expect(
      agentSessionsService.getUsageSummary({
        organizationId: "org-1",
        filters: {},
      })
    ).resolves.toEqual(
      expect.objectContaining({
        totalEstimatedCost: 1.5,
        subscriptionEstimatedCost: 0.625,
        apiEstimatedCost: 0.75,
        earliestSessionAt: "2026-03-01T10:00:00.000Z",
        latestSessionAt: "2026-03-14T10:00:00.000Z",
        // Repository facet feed: the null-repo group is dropped, leaving only
        // the attributed repository.
        byRepository: [
          expect.objectContaining({
            repositoryFullName: "acme/web",
            sessionCount: 4,
            errorCount: 1,
          }),
        ],
      })
    );
  });

  it("summarizes usage across multiple organization members", async () => {
    const aggregate = vi.fn().mockResolvedValue({
      _count: { _all: 3 },
      _sum: {
        inputTokens: 75,
        outputTokens: 30,
        cacheReadTokens: 5,
        cacheWriteTokens: 2,
        estimatedCost: 1.25,
      },
      _min: { sessionStartedAt: new Date("2026-03-01T10:00:00.000Z") },
      _max: { sessionStartedAt: new Date("2026-03-14T10:00:00.000Z") },
    });
    const sessionGroupBy = vi
      .fn()
      .mockResolvedValueOnce([
        {
          userId: "user-1",
          _count: { _all: 1 },
          _sum: {
            inputTokens: 25,
            outputTokens: 10,
            cacheReadTokens: 2,
            cacheWriteTokens: 1,
            estimatedCost: 0.5,
          },
        },
        {
          userId: "user-2",
          _count: { _all: 2 },
          _sum: {
            inputTokens: 50,
            outputTokens: 20,
            cacheReadTokens: 3,
            cacheWriteTokens: 1,
            estimatedCost: 0.75,
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          harness: "claude",
          _count: { _all: 3 },
          _sum: {
            inputTokens: 75,
            outputTokens: 30,
            cacheReadTokens: 5,
            cacheWriteTokens: 2,
            estimatedCost: 1.25,
          },
        },
      ])
      // Third call: repository facet groupBy (empty here).
      .mockResolvedValueOnce([])
      // Fourth call: cost split by sourceLoopId (empty here).
      .mockResolvedValueOnce([]);
    const computeTargetFindMany = vi.fn().mockResolvedValue([]);

    installDb({
      sessionDetail: buildAgentSessionDbMock({
        aggregate,
        groupBy: sessionGroupBy,
      }),
      agentSessionTokenUsage: {
        groupBy: vi.fn().mockResolvedValue([
          {
            model: "claude-sonnet-4",
            _count: { _all: 3 },
            _sum: {
              inputTokens: 75,
              outputTokens: 30,
              cacheReadTokens: 5,
              cacheWriteTokens: 2,
              estimatedCost: 1.25,
            },
          },
        ]),
      },
      computeTarget: {
        findMany: computeTargetFindMany,
      },
      user: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "user-1",
            email: "ada@example.com",
            firstName: "Ada",
            lastName: "Lovelace",
            avatarUrl: null,
          },
          {
            id: "user-2",
            email: "grace@example.com",
            firstName: "Grace",
            lastName: "Hopper",
            avatarUrl: null,
          },
        ]),
      },
    });

    await expect(
      agentSessionsService.getUsageSummary({
        organizationId: "org-1",
        filters: {},
      })
    ).resolves.toEqual(
      expect.objectContaining({
        viewerScope: "organization",
        byUser: [
          expect.objectContaining({
            userId: "user-2",
            userName: "Grace Hopper",
            sessionCount: 2,
          }),
          expect.objectContaining({
            userId: "user-1",
            userName: "Ada Lovelace",
            sessionCount: 1,
          }),
        ],
      })
    );

    const expectedWhere = {
      artifact: {
        is: {
          organizationId: "org-1",
        },
      },
    };
    expect(aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedWhere })
    );
    expect(sessionGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedWhere })
    );
    // Cost split aggregates estimatedCost grouped by sourceLoopId and
    // billingMode in the DB rather than materializing one row per session.
    expect(sessionGroupBy).toHaveBeenCalledWith({
      by: ["sourceLoopId", "billingMode"],
      where: expectedWhere,
      _sum: {
        estimatedCost: true,
      },
    });
    expect(computeTargetFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-1",
        },
      })
    );
  });

  it("includes source artifact metadata in session list responses", async () => {
    const findMany = vi.fn().mockResolvedValue([
      buildSessionListRecord({
        sourceArtifactId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba001",
      }),
    ]);
    const count = vi.fn().mockResolvedValue(1);
    const findArtifacts = vi
      .fn()
      .mockResolvedValue([buildSourceArtifactRecord()]);

    installDb({
      sessionDetail: buildAgentSessionDbMock({
        findMany,
        count,
      }),
      artifact: {
        findMany: findArtifacts,
      },
    });

    await expect(
      agentSessionsService.findSessions({
        organizationId: "org-1",
        filters: {},
      })
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: "session-1",
          sourceArtifactId: "0196f2df-5b7d-7e72-9e4c-8d8af9fba001",
          sourceArtifact: {
            id: "0196f2df-5b7d-7e72-9e4c-8d8af9fba001",
            name: "Agent Platform PRD",
            slug: "agent-platform-prd",
            documentType: DocumentType.Prd,
          },
        }),
      ],
      total: 1,
      viewerScope: "organization",
    });

    expect(findArtifacts).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        id: { in: ["0196f2df-5b7d-7e72-9e4c-8d8af9fba001"] },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        type: true,
        subtype: true,
      },
    });
  });

  it("lists organization sessions without a self-only user predicate", async () => {
    const findMany = vi.fn().mockResolvedValue([
      buildSessionListRecord({
        artifactId: "session-2",
        user: {
          id: "user-2",
          email: "grace@example.com",
          firstName: "Grace",
          lastName: "Hopper",
          avatarUrl: null,
        },
      }),
    ]);
    const count = vi.fn().mockResolvedValue(1);

    installDb({
      sessionDetail: buildAgentSessionDbMock({
        findMany,
        count,
      }),
    });

    await expect(
      agentSessionsService.findSessions({
        organizationId: "org-1",
        filters: {},
      })
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: "session-2",
          user: expect.objectContaining({
            id: "user-2",
          }),
        }),
      ],
      total: 1,
      viewerScope: "organization",
    });

    const expectedWhere = {
      artifact: {
        is: {
          organizationId: "org-1",
        },
      },
    };

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expectedWhere,
      })
    );
    expect(count).toHaveBeenCalledWith({ where: expectedWhere });
  });

  it("honors user and team filters within organization-scoped session lists", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);

    installDb({
      sessionDetail: buildAgentSessionDbMock({
        findMany,
        count,
      }),
    });

    await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {
        userId: "user-2",
        teamId: "team-1",
      },
    });

    const expectedWhere = {
      artifact: {
        is: {
          organizationId: "org-1",
        },
      },
      userId: "user-2",
      user: {
        is: {
          teamMemberships: {
            some: {
              teamId: "team-1",
            },
          },
        },
      },
    };

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expectedWhere,
      })
    );
    expect(count).toHaveBeenCalledWith({ where: expectedWhere });
  });

  it("loads full same-organization session details without requiring ownership", async () => {
    const findFirst = vi.fn().mockResolvedValue(
      buildSessionDetailRecord({
        artifactId: "session-2",
        user: {
          id: "user-2",
          email: "grace@example.com",
          firstName: "Grace",
          lastName: "Hopper",
          avatarUrl: null,
        },
        events: [
          {
            id: "00000000-0000-0000-0000-000000000001",
            externalEventId: "event-1",
            agentExternalId: "agent-1",
            eventType: "message",
            toolName: null,
            summary: "Assistant replied",
            data: { text: "Full text history" },
            eventCreatedAt: SESSION_STARTED_AT,
          },
        ],
      })
    );

    installDb({
      sessionDetail: buildAgentSessionDbMock({
        findFirst,
      }),
    });

    await expect(
      agentSessionsService.findSessionDetail({
        id: "session-2",
        organizationId: "org-1",
      })
    ).resolves.toEqual(
      expect.objectContaining({
        id: "session-2",
        user: expect.objectContaining({
          id: "user-2",
        }),
        events: [
          expect.objectContaining({
            externalEventId: "event-1",
            data: { text: "Full text history" },
          }),
        ],
      })
    );

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          artifactId: "session-2",
          artifact: { is: { organizationId: "org-1" } },
        },
      })
    );
  });

  it("paginates analytics queries and counts tool coverage by session id", async () => {
    const scalarPageOne = Array.from({ length: 200 }, (_, index) =>
      buildAnalyticsScalarRecord(index + 1)
    );
    const scalarPageTwo = [
      buildAnalyticsScalarRecord(201, {
        repositoryFullName: "closedloop-ai/closedloop-electron",
        inputTokens: 30,
        outputTokens: 15,
        estimatedCost: 0.75,
        errorCount: 2,
        artifact: {
          projectId: "project-2",
          project: {
            id: "project-2",
            name: "Desktop",
            slug: "desktop",
          },
        },
      }),
    ];
    const jsonPageOne = Array.from({ length: 200 }, (_, index) =>
      buildAnalyticsJsonRecord(index + 1)
    );
    jsonPageOne[0] = buildAnalyticsJsonRecord(1, {
      agents: [
        buildPersistedAgent({
          type: "main",
          status: "completed",
          endedAt: "2026-05-20T17:01:00.000Z",
        }),
      ],
      events: [buildPersistedEvent()],
    });
    jsonPageOne[1] = buildAnalyticsJsonRecord(2, {
      agents: [
        buildPersistedAgent({
          externalAgentId: "agent-2",
          type: "worker",
          status: "failed",
          endedAt: "2026-05-20T17:02:00.000Z",
        }),
      ],
      events: [
        // "tool_failure" has no "error" substring: it counts as an error only
        // because aggregateByTool classifies via the shared ERROR_EVENT_PATTERN
        // (/error|fail/i), matching the desktop countErrorEvents. Under the old
        // `includes("error")` classifier this would have been errorCount: 0,
        // so this row guards the web/desktop drift fix.
        buildPersistedEvent({
          externalEventId: "event-2",
          eventType: "tool_failure",
        }),
      ],
    });
    const jsonPageTwo = [
      buildAnalyticsJsonRecord(201, {
        events: [
          buildPersistedEvent({
            externalEventId: "event-201",
            toolName: "Bash",
          }),
        ],
      }),
    ];

    const findMany = vi
      .fn()
      .mockResolvedValueOnce(scalarPageOne)
      .mockResolvedValueOnce(scalarPageTwo)
      .mockResolvedValueOnce(jsonPageOne)
      .mockResolvedValueOnce(jsonPageTwo);

    installDb({
      sessionDetail: buildAgentSessionDbMock({
        findMany,
      }),
    });

    await expect(
      agentSessionsService.getAnalytics({
        organizationId: "org-1",
        filters: {},
      })
    ).resolves.toEqual({
      viewerScope: "organization",
      byTool: [
        {
          toolName: "Read",
          invocationCount: 2,
          errorCount: 1,
          sessionCount: 2,
        },
        {
          toolName: "Bash",
          invocationCount: 1,
          errorCount: 0,
          sessionCount: 1,
        },
      ],
      byAgentType: [
        {
          agentType: "main",
          count: 1,
          successCount: 1,
          failedCount: 0,
          avgDurationMs: 60_000,
        },
        {
          agentType: "worker",
          count: 1,
          successCount: 0,
          failedCount: 1,
          avgDurationMs: 120_000,
        },
      ],
      byRepository: [
        {
          repositoryFullName: "closedloop-ai/symphony-alpha",
          sessionCount: 200,
          inputTokens: 2000,
          outputTokens: 1000,
          estimatedCost: 50,
          errorCount: 0,
        },
        {
          repositoryFullName: "closedloop-ai/closedloop-electron",
          sessionCount: 1,
          inputTokens: 30,
          outputTokens: 15,
          estimatedCost: 0.75,
          errorCount: 2,
        },
      ],
      byProject: [
        {
          projectId: "project-1",
          projectName: "Agent Platform",
          projectSlug: "agent-platform",
          sessionCount: 200,
          inputTokens: 2000,
          outputTokens: 1000,
          estimatedCost: 50,
        },
        {
          projectId: "project-2",
          projectName: "Desktop",
          projectSlug: "desktop",
          sessionCount: 1,
          inputTokens: 30,
          outputTokens: 15,
          estimatedCost: 0.75,
        },
      ],
    });

    expect(findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cursor: { artifactId: "session-200" },
        skip: 1,
      })
    );
    expect(findMany).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        cursor: { artifactId: "session-200" },
        skip: 1,
      })
    );
  });
});

describe("toLocalDateOnly (FEA-1459)", () => {
  it("formats date in UTC when timezone is null", () => {
    // 2026-06-08T02:30:00Z is still June 8 in UTC
    const date = new Date("2026-06-08T02:30:00.000Z");
    expect(toLocalDateOnly(date, null)).toBe("2026-06-08");
  });

  it("formats date in UTC when timezone is undefined", () => {
    const date = new Date("2026-06-08T02:30:00.000Z");
    expect(toLocalDateOnly(date, undefined)).toBe("2026-06-08");
  });

  it("shifts to previous calendar day for evening CDT session", () => {
    // 2026-06-08T02:30:00Z = 2026-06-07T21:30:00 CDT (America/Chicago is UTC-5 in summer)
    const date = new Date("2026-06-08T02:30:00.000Z");
    expect(toLocalDateOnly(date, "America/Chicago")).toBe("2026-06-07");
  });

  it("keeps same day when local time is still same calendar day", () => {
    // 2026-06-08T15:00:00Z = 2026-06-08T10:00:00 CDT
    const date = new Date("2026-06-08T15:00:00.000Z");
    expect(toLocalDateOnly(date, "America/Chicago")).toBe("2026-06-08");
  });

  it("handles positive-offset timezone (shifts forward)", () => {
    // 2026-06-07T23:30:00Z = 2026-06-08T08:30:00 Asia/Tokyo (UTC+9)
    const date = new Date("2026-06-07T23:30:00.000Z");
    expect(toLocalDateOnly(date, "Asia/Tokyo")).toBe("2026-06-08");
  });

  it("falls back to UTC for invalid timezone", () => {
    const date = new Date("2026-06-08T02:30:00.000Z");
    expect(toLocalDateOnly(date, "Invalid/Timezone")).toBe("2026-06-08");
  });
});
