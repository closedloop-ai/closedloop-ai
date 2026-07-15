import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { ArtifactType } from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import type { Mock } from "vitest";
import { vi } from "vitest";
import { agentSessionsService } from "./service";
import { mocks } from "./service.test-mocks";

export const SESSION_STARTED_AT = new Date("2026-05-20T17:00:00.000Z");
export const SESSION_UPDATED_AT = new Date("2026-05-20T17:05:00.000Z");

export function installDb(db: Record<string, unknown>) {
  const dbWithDefaults = {
    $executeRaw: vi.fn(),
    // FEA-2913: persistSessionChildren recomputes the tool-use/error counts in
    // one conditional-aggregation query; default it to a zero-count row so the
    // upsert path resolves without each test wiring the raw call.
    $queryRawUnsafe: vi
      .fn()
      .mockResolvedValue([{ toolUseCount: 0n, errorCount: 0n }]),
    artifactLink: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    // findSessionDetail enriches with the per-file transcript availability
    // summary (PLN-1289); default to no rows unless a test overrides it.
    sessionTranscript: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    ...db,
  };
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
  mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
}

export function buildSyncedSession(
  overrides: Partial<SyncedAgentSession> = {}
) {
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

export function buildDefaultAgentSessionMocks(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> & { findUnique: Mock; upsert: Mock; update: Mock } {
  return {
    findUnique: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue({ artifactId: "persisted-session-1" }),
    update: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

// generateSlug() allocates a SES-* slug via slugCounter.upsert inside the sync
// transaction when a session artifact is first created.
export function buildSlugCounterMock(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> & { upsert: Mock } {
  return {
    upsert: vi.fn().mockResolvedValue({ currentValue: 1 }),
    ...overrides,
  };
}

export function buildAgentSessionDbMock(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> & { findUnique: Mock; findMany: Mock } {
  return {
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

export function buildAttributionLensRecord(input: {
  artifactId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
  branches: unknown[];
}) {
  return {
    artifactId: input.artifactId,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheReadTokens: input.cacheReadTokens,
    cacheWriteTokens: input.cacheWriteTokens,
    estimatedCost: input.estimatedCost,
    artifact: {
      organizationId: "org-1",
      sourceLinks: input.branches,
    },
  };
}

export function trustedBranch(
  targetId: string,
  branchName: string,
  prNumber: number
) {
  return {
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionPr,
      relationTypes: [SessionPrRelationType.Created],
      confidence: 1,
    },
    targetId,
    target: {
      organizationId: "org-1",
      branch: {
        branchName,
        repository: { fullName: "closedloop-ai/symphony-alpha" },
        currentPullRequestDetail: {
          number: prNumber,
          title: `PR ${prNumber}`,
          isCurrent: true,
          lastVerifiedAt: new Date("2026-03-01T12:00:00.000Z"),
          repository: { fullName: "closedloop-ai/symphony-alpha" },
        },
      },
    },
  };
}

export function staleBranch(
  targetId: string,
  branchName: string,
  prNumber: number
) {
  const branch = trustedBranch(targetId, branchName, prNumber);
  return {
    ...branch,
    target: {
      organizationId: branch.target.organizationId,
      branch: {
        ...branch.target.branch,
        currentPullRequestDetail: {
          ...branch.target.branch.currentPullRequestDetail,
          lastVerifiedAt: null,
        },
      },
    },
  };
}

export function referencedBranch(
  targetId: string,
  branchName: string,
  prNumber: number
) {
  return {
    ...trustedBranch(targetId, branchName, prNumber),
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionPr,
      relationTypes: [SessionPrRelationType.Referenced],
      confidence: 1,
    },
  };
}

export function lowConfidenceBranch(
  targetId: string,
  branchName: string,
  prNumber: number
) {
  return {
    ...trustedBranch(targetId, branchName, prNumber),
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionPr,
      relationTypes: [SessionPrRelationType.Created],
      confidence: 0.25,
    },
  };
}

export function buildDefaultAgentSessionEventMocks(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> & { count: Mock; aggregate: Mock } {
  return {
    count: vi.fn().mockResolvedValue(0),
    // PLN-1034: persistSessionChildren derives last_activity_at from the latest
    // event time; default to none so it floors at the session start.
    aggregate: vi.fn().mockResolvedValue({ _max: { eventCreatedAt: null } }),
    ...overrides,
  };
}

export function buildPersistedAgent(
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

export function buildPersistedEvent(
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

export function buildSessionListRecord(
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
      // Org SSOT the by-id session read asserts against (FEA-2734); the detail
      // resolver runs resolveOrgScopeVia() over this before returning.
      organizationId: "org-1",
      name: "Session One",
      status: "completed",
      slug: "SES-1",
      project: {
        id: "project-1",
        name: "Agent Platform",
        slug: "agent-platform",
      },
      sourceLinks: [],
    },
    ...overrides,
  };
}

export function buildSessionDetailRecord(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ...buildSessionListRecord(),
    origin: "DESKTOP_SYNC",
    state: null,
    branch: null,
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

export function buildSourceArtifactRecord(
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

export function buildAnalyticsScalarRecord(
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

export function buildAnalyticsJsonRecord(
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

export type BranchIngestMocks = {
  artifactLinkUpsert: ReturnType<typeof vi.fn>;
  artifactLinkFindFirst: ReturnType<typeof vi.fn>;
  installationFindFirst: ReturnType<typeof vi.fn>;
  repoFindMany: ReturnType<typeof vi.fn>;
  branchFindFirst: ReturnType<typeof vi.fn>;
  branchDetailUpdateMany: ReturnType<typeof vi.fn>;
  artifactCreate: ReturnType<typeof vi.fn>;
  sessionDetailUpdate: ReturnType<typeof vi.fn>;
  commitDetailFindMany: ReturnType<typeof vi.fn>;
  commitDetailCreate: ReturnType<typeof vi.fn>;
  commitDetailUpdate: ReturnType<typeof vi.fn>;
};

export function installBranchIngestDb(overrides: {
  existingLink?: unknown;
  repos?: Array<{ id: string; fullName: string }>;
  branches?: Array<{
    artifactId: string;
    repositoryId: string;
    branchName: string;
  }>;
  installation?: { id: string } | null;
  // Source artifact → project mapping used to resolve the session's project
  // (attribution.sourceArtifactId). Present only in the create-path test.
  artifactProjects?: Array<{ id: string; projectId: string }>;
}): BranchIngestMocks {
  const artifactLinkUpsert = vi.fn().mockResolvedValue({});
  const artifactLinkFindFirst = vi
    .fn()
    .mockResolvedValue(overrides.existingLink ?? null);
  const installationFindFirst = vi
    .fn()
    .mockResolvedValue(
      overrides.installation === undefined
        ? { id: "install-1" }
        : overrides.installation
    );
  const repoFindMany = vi
    .fn()
    .mockResolvedValue(
      overrides.repos ?? [{ id: "repo-1", fullName: "acme/web" }]
    );
  // PLN-1099 Phase 1: the branch lane resolves-or-creates on the D2 key via
  // findFirst. These unit sessions carry no project attribution, so
  // resolveProjectId returns null — a findFirst MISS therefore defers (a
  // project-less branch can't be created), exactly as before. The create path
  // (project resolved) is covered by the branch integration tests.
  const branches = overrides.branches ?? [];
  const branchFindFirst = vi
    .fn()
    .mockImplementation((args: { where?: { branchName?: string } }) => {
      const branchName = args?.where?.branchName;
      const match = branches.find((b) => b.branchName === branchName);
      return Promise.resolve(match ? { artifactId: match.artifactId } : null);
    });
  const artifactCreate = vi.fn().mockResolvedValue({ id: "created-branch-1" });
  // PLN-1099 Phase 2b: the set-once/earliest-wins push-state stamp
  // (`stampBranchFirstPush`) issues a guarded branchDetail.updateMany.
  const branchDetailUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const sessionDetailUpdate = vi.fn().mockResolvedValue({});

  // FEA-2731 commit lane: an in-memory CommitDetail delegate exercising the
  // (org, repo, sha-prefix) findMany + create + update-by-id that
  // reconcileCommitOnTx uses.
  const commitRows: Record<string, unknown>[] = [];
  let commitSeq = 0;
  const commitDetailFindMany = vi.fn().mockImplementation(
    (args: {
      where?: {
        organizationId?: string;
        repositoryFullName?: string;
        sha?: { startsWith?: string };
      };
    }) => {
      const where = args?.where ?? {};
      const prefix = where.sha?.startsWith;
      return Promise.resolve(
        commitRows.filter(
          (r) =>
            r.organizationId === where.organizationId &&
            r.repositoryFullName === where.repositoryFullName &&
            (prefix === undefined || String(r.sha).startsWith(prefix))
        )
      );
    }
  );
  const commitDetailCreate = vi
    .fn()
    .mockImplementation((args: { data: Record<string, unknown> }) => {
      const row = { ...args.data, id: `commit-${++commitSeq}` };
      commitRows.push(row);
      return Promise.resolve(row);
    });
  const commitDetailUpdate = vi
    .fn()
    .mockImplementation(
      (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = commitRows.find((r) => r.id === args.where.id);
        if (row) {
          Object.assign(row, args.data);
        }
        return Promise.resolve(row);
      }
    );

  installDb({
    computeTarget: {
      findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
      update: vi.fn().mockResolvedValue({ id: "target-1" }),
    },
    slugCounter: buildSlugCounterMock(),
    sessionDetail: buildDefaultAgentSessionMocks({
      findUnique: vi.fn().mockResolvedValue({ metadata: null }),
      update: sessionDetailUpdate,
    }),
    artifact: {
      create: artifactCreate,
      findMany: vi.fn().mockResolvedValue(overrides.artifactProjects ?? []),
    },
    artifactLink: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findFirst: artifactLinkFindFirst,
      findMany: vi.fn().mockResolvedValue([]),
      upsert: artifactLinkUpsert,
    },
    agentSessionEvent: buildDefaultAgentSessionEventMocks(),
    agentSessionTokenUsage: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    gitHubInstallation: { findFirst: installationFindFirst },
    gitHubInstallationRepository: { findMany: repoFindMany },
    branchDetail: {
      findFirst: branchFindFirst,
      updateMany: branchDetailUpdateMany,
    },
    commitDetail: {
      findMany: commitDetailFindMany,
      create: commitDetailCreate,
      update: commitDetailUpdate,
    },
  });

  return {
    artifactLinkUpsert,
    artifactLinkFindFirst,
    installationFindFirst,
    repoFindMany,
    branchFindFirst,
    branchDetailUpdateMany,
    artifactCreate,
    sessionDetailUpdate,
    commitDetailFindMany,
    commitDetailCreate,
    commitDetailUpdate,
  };
}

export function syncBranchRefs(
  artifactRefs: SyncedArtifactRef[],
  attribution?: SyncedAgentSession["attribution"]
) {
  return agentSessionsService.upsertSessions(
    {
      organizationId: "org-1",
      userId: "user-1",
      computeTargetId: "target-1",
    },
    {
      schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
      batchId: "branch-batch",
      syncMode: AgentSessionSyncMode.Incremental,
      sessionCount: 1,
      sessions: [
        buildSyncedSession({
          artifactRefs,
          ...(attribution ? { attribution } : {}),
        }),
      ],
    }
  );
}
