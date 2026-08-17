import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { ArtifactType } from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import type { Mock } from "vitest";
import { vi } from "vitest";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { mocks } from "./service.test-mocks";

export const SESSION_STARTED_AT = new Date("2026-05-20T17:00:00.000Z");
export const SESSION_UPDATED_AT = new Date("2026-05-20T17:05:00.000Z");

export function installDb(db: Record<string, unknown>) {
  const {
    artifact: artifactOverride,
    artifactLink: artifactLinkOverride,
    computeTarget: computeTargetOverride,
    project: projectOverride,
    publicRepository: publicRepositoryOverride,
    ...dbWithoutDefaults
  } = db;
  // ISS-5355: getUsageSummary now also reads the Project facet options
  // (`buildProjectFacetOptions`), which reads the session→document link edge
  // (`artifactLink.findMany`) and then resolves those project names. Default to
  // no links so every pre-existing usage-summary test resolves with an empty
  // Project facet instead of tripping on an unmocked model; a test that
  // exercises the facet overrides `artifactLink`/`project`.
  const artifactDefaults = {
    groupBy: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    findMany: vi.fn().mockResolvedValue([]),
  };
  const projectDefaults = {
    findMany: vi.fn().mockResolvedValue([]),
  };
  const artifactLinkDefaults = {
    findFirst: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
  };
  const computeTargetDefaults = {
    findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
    update: vi.fn().mockResolvedValue({ id: "target-1" }),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const dbWithDefaults = {
    $executeRaw: vi.fn(),
    // FEA-2913 + ISS-4439: persistSessionChildren recomputes the tool-use/error
    // counts and the MAX(event_created_at) activity timestamp in one
    // conditional-aggregation query, then persists them via a raw UPDATE ...
    // RETURNING. Default both calls to a zero-count / no-activity row so the
    // upsert path resolves without each test wiring the raw calls.
    $queryRawUnsafe: vi
      .fn()
      .mockResolvedValue([
        { toolUseCount: 0n, errorCount: 0n, maxEventCreatedAt: null },
      ]),
    // findSessionDetail enriches with the per-file transcript availability
    // summary (PLN-1289); default to no rows unless a test overrides it.
    sessionTranscript: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // ISS-6028: the delivery summary reads its merged PRs from the PR side
    // (`findMergedPrsLinkedToSessions`) once the session→PR-link probe passes.
    // Default to no merged PRs so a test that wires a truthy probe for another
    // reason (e.g. the attribution lenses) resolves with null delivery cards
    // instead of tripping on an unmocked model; a delivery test overrides it.
    pullRequestDetail: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // FEA-4276: findSessions/listByArtifactIds reconcile each row's cost against
    // the per-event token stream via ONE bounded, org-scoped raw aggregate
    // (getReconciledCostsBySessionId, `$queryRaw`). Default to no per-event rows
    // so existing list tests fall back to the stored rollup without wiring the
    // aggregate; a test that exercises reconciliation overrides `$queryRaw`.
    // NOTE: component-invocations also uses `$queryRaw`; a test wiring the cost
    // aggregate must scope its mock (e.g. branch on the SQL / call order).
    $queryRaw: vi.fn().mockResolvedValue([]),
    // FEA-4022: upsertSessions reads the org's calculateSessionFrustration gate
    // before the transaction (via frustrationSettingService → withDb →
    // organization.findUnique). Default to no settings (gate off) so existing
    // sync tests need no wiring; a test that exercises the opted-in path
    // overrides `organization`.
    organization: {
      findUnique: vi.fn().mockResolvedValue({ settings: null }),
    },
    ...dbWithoutDefaults,
    artifactLink: {
      ...artifactLinkDefaults,
      ...((artifactLinkOverride as Record<string, unknown> | undefined) ?? {}),
    },
    computeTarget: {
      ...computeTargetDefaults,
      ...((computeTargetOverride as Record<string, unknown> | undefined) ?? {}),
    },
    artifact: {
      ...artifactDefaults,
      ...((artifactOverride as Record<string, unknown> | undefined) ?? {}),
    },
    project: {
      ...projectDefaults,
      ...((projectOverride as Record<string, unknown> | undefined) ?? {}),
    },
    publicRepository: {
      findMany: vi.fn().mockResolvedValue([]),
      ...((publicRepositoryOverride as Record<string, unknown> | undefined) ??
        {}),
    },
    gitHubInstallationRepository: {
      findMany: vi.fn().mockResolvedValue([]),
      ...(((dbWithoutDefaults as Record<string, unknown>)
        .gitHubInstallationRepository as Record<string, unknown> | undefined) ??
        {}),
    },
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
  prNumber: number,
  // FEA-4378: optional per-PR LOC carried on the verified detail so the
  // authored-PR KLOC roll-up can be exercised. Absent → the columns are null,
  // matching a PR whose additions/deletions were never fetched from GitHub.
  loc?: { additions: number; deletions: number }
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
          additions: loc?.additions ?? null,
          deletions: loc?.deletions ?? null,
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
): Record<string, unknown> & { count: Mock } {
  return {
    count: vi.fn().mockResolvedValue(0),
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
    lastSyncedAt: SESSION_UPDATED_AT,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 1.25,
    billingMode: null,
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
      lastAgentSessionSyncAt: SESSION_UPDATED_AT,
      // ISS-4827: the ACCEPTED-sync watermark, distinct from the landed-data one
      // above. Equal by default so a fixture that does not care about the split
      // reads the same either way; the ISS-4828 projection tests pin them apart.
      lastAgentSessionSyncAttemptAt: SESSION_UPDATED_AT,
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
    tracePhaseSources: null,
    throttleSources: null,
    correctionSources: null,
    // Always an array in the real Prisma payload (a to-many relation select).
    tokenEvents: [],
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
  publicRepoFindMany: ReturnType<typeof vi.fn>;
  authorityQueryRaw: ReturnType<typeof vi.fn>;
  branchFindFirst: ReturnType<typeof vi.fn>;
  branchFindMany: ReturnType<typeof vi.fn>;
  branchDetailUpdateMany: ReturnType<typeof vi.fn>;
  artifactCreate: ReturnType<typeof vi.fn>;
  sessionDetailUpdate: ReturnType<typeof vi.fn>;
  commitDetailFindMany: ReturnType<typeof vi.fn>;
  commitDetailCreate: ReturnType<typeof vi.fn>;
  commitDetailUpdate: ReturnType<typeof vi.fn>;
};

export function installBranchIngestDb(overrides: {
  existingLink?: unknown;
  repos?: TestRepositoryAuthority[];
  pullRequestRepositories?: TestRepositoryAuthority[];
  publicRepositories?: Array<{
    id: string;
    githubRepoId: string;
    fullName: string;
    defaultBranchName?: string;
  }>;
  branches?: Array<{
    artifactId: string;
    repositoryId: string;
    branchName: string;
    // Optional explicit stored repo full name. When omitted, the row's
    // composite identity resolves `repositoryId` through the repo mock (below).
    // Supply this directly to model cross-repo / same-branch-name rows whose
    // identity the batched commit-lane read must keep distinct.
    repositoryFullName?: string;
  }>;
  installation?: { id: string } | null;
  // Source artifact → project mapping used to resolve the session's project
  // (attribution.sourceArtifactId). Present only in the create-path test.
  artifactProjects?: Array<{ id: string; projectId: string }>;
  // ISS-4946: the persisted row's freshness watermark. Defaults to a value
  // strictly OLDER than the synced session's `updatedAt`, so both PR lanes are
  // ON by default and a test that does not care about freshness exercises the
  // real write path. Pass `SESSION_UPDATED_AT` to opt into the equal-watermark
  // tie, or a later date for a stale redelivery.
  storedSessionUpdatedAt?: Date;
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
  const repos = (
    overrides.repos ?? [{ id: "repo-1", fullName: "acme/web" }]
  ).map((repo) => repositoryWithAvailableDefault(repo));
  const repoFindMany = vi.fn().mockResolvedValue(repos);
  const publicRepositories = (overrides.publicRepositories ?? []).map((repo) =>
    repositoryWithAvailableDefault(repo)
  );
  const publicRepoFindMany = vi.fn().mockResolvedValue(publicRepositories);
  const pullRequestRepositories = (overrides.pullRequestRepositories ?? []).map(
    (repository) => repositoryWithAvailableDefault(repository)
  );
  const authorityQueryRaw = vi
    .fn()
    .mockImplementation((query: { sql?: string }) => {
      if (query.sql?.includes("github_installation_repositories")) {
        return Promise.resolve(
          overrides.installation === null
            ? []
            : repos.filter(
                (repository) => repository.installationStatus !== "INACTIVE"
              )
        );
      }
      if (query.sql?.includes("public_repositories")) {
        return Promise.resolve(publicRepositories);
      }
      if (query.sql?.includes("pull_request_detail")) {
        return Promise.resolve(pullRequestRepositories);
      }
      return Promise.resolve([]);
    });
  const repoFullNameById = new Map(repos.map((r) => [r.id, r.fullName]));
  // The stored composite identity of a branch row is its (repositoryFullName,
  // branchName) pair — the real D2 unique key. A row may pin repositoryFullName
  // directly (to model cross-repo cases) or resolve it from repositoryId via the
  // repo mock. This is what a batched read genuinely selects; the mock must key
  // on it (not echo the query) so a cross-repo attach is caught.
  const storedRepoFullName = (b: {
    repositoryId: string;
    repositoryFullName?: string;
  }): string =>
    b.repositoryFullName ??
    repoFullNameById.get(b.repositoryId) ??
    repos[0]?.fullName ??
    "";
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
  // ISS-4440 commit lane: branches are now resolved in one batched findMany over
  // the distinct (repo, branch) pairs. The mock matches each OR pair against the
  // row's STORED composite identity (repo full name AND branch name) and returns
  // the STORED identity — it never echoes the query. That is what lets a
  // cross-repo attach (right branch name, wrong repo) fail the test instead of
  // silently resolving. It also asserts the read stays org-scoped and that every
  // OR pair carries the full composite key, so a regression to an unscoped or
  // branch-name-only query is caught.
  const branchFindMany = vi.fn().mockImplementation(
    (args: {
      where?: {
        organizationId?: string;
        OR?: Array<{ repositoryFullName: string; branchName: string }>;
      };
    }) => {
      const where = args?.where ?? {};
      // Guard the scoped read shape so a regression to an unscoped or
      // branch-name-only query fails the test (throwing rejects the mocked
      // call, surfacing in the awaiting assertion).
      if (where.organizationId === undefined) {
        throw new Error("batched branch read must be org-scoped");
      }
      const pairs = where.OR ?? [];
      const rows: Array<{
        artifactId: string;
        repositoryFullName: string;
        branchName: string;
      }> = [];
      for (const pair of pairs) {
        if (
          typeof pair.repositoryFullName !== "string" ||
          typeof pair.branchName !== "string"
        ) {
          throw new Error(
            "each batched branch pair must scope both repositoryFullName and branchName"
          );
        }
        const match = branches.find(
          (b) =>
            storedRepoFullName(b) === pair.repositoryFullName &&
            b.branchName === pair.branchName
        );
        if (match) {
          rows.push({
            artifactId: match.artifactId,
            repositoryFullName: storedRepoFullName(match),
            branchName: match.branchName,
          });
        }
      }
      return Promise.resolve(rows);
    }
  );
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
    $queryRaw: authorityQueryRaw,
    computeTarget: {
      findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
      update: vi.fn().mockResolvedValue({ id: "target-1" }),
    },
    slugCounter: buildSlugCounterMock(),
    sessionDetail: buildDefaultAgentSessionMocks({
      // ISS-4946: `sessionUpdatedAt` is a non-null column that the upsert reads
      // as its freshness watermark, so a persisted-row stub must carry it.
      // The DEFAULT is deliberately older than the synced session's `updatedAt`
      // (an ordinary in-order resync that advances the row), which puts both PR
      // lanes ON. Defaulting to the equal watermark instead would silently make
      // every PR-lane write conditional on the fixture happening to carry PR
      // evidence — a new test could then assert nothing and still pass.
      findUnique: vi.fn().mockResolvedValue({
        metadata: null,
        sessionStartedAt: SESSION_STARTED_AT,
        sessionUpdatedAt:
          overrides.storedSessionUpdatedAt ?? SESSION_STARTED_AT,
        sessionEndedAt: null,
      }),
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
    publicRepository: {
      findMany: publicRepoFindMany,
    },
    branchDetail: {
      findFirst: branchFindFirst,
      findMany: branchFindMany,
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
    publicRepoFindMany,
    authorityQueryRaw,
    branchFindFirst,
    branchFindMany,
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

export type TestRepositoryAuthority = {
  id: string;
  fullName: string;
  githubRepoId?: string;
  defaultBranchName?: string | null;
  installationStatus?: "ACTIVE" | "INACTIVE";
  [key: string]: unknown;
};

export function repositoryWithAvailableDefault<
  T extends TestRepositoryAuthority,
>(repository: T) {
  return {
    defaultBranchName: "main",
    defaultBranchAvailability: RepositoryDefaultAvailability.Available,
    defaultBranchCompleteness: RepositoryDefaultCompleteness.Complete,
    defaultBranchReason: null,
    defaultBranchSource: RepositoryDefaultSource.RepositoryRest,
    defaultBranchMechanism: GitHubFetchMechanism.Rest,
    defaultBranchTrigger: GitHubFetchTrigger.Backfill,
    defaultBranchCredentialType: GitHubFetchCredentialType.GitHubApp,
    defaultBranchCredentialOwnerId: null,
    defaultBranchObservationKey: "test-observation",
    defaultBranchObservedAt: new Date("2026-08-11T00:00:00.000Z"),
    defaultBranchEventAt: null,
    ...repository,
    githubRepoId: repository.githubRepoId ?? repository.id,
  };
}
