import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import { LinkType } from "@repo/api/src/types/artifact";
import { BranchLifecycleBoundaryKind } from "@repo/api/src/types/branch";
import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { GitHubInstallationStatus, Prisma } from "@repo/database";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  installBranchIngestDb,
  syncBranchRefs,
} from "@/__tests__/support/agent-sessions/branch-ingest.test-harness";
import {
  buildDefaultAgentSessionEventMocks,
  buildDefaultAgentSessionMocks,
  buildSlugCounterMock,
  buildSyncedSession,
  installDb,
  persistedSessionDetail,
  SESSION_STARTED_AT,
  SESSION_UPDATED_AT,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { mocks } from "@/__tests__/support/agent-sessions/service.test-mocks";
import {
  SessionPrLinkAudience,
  sessionPrLinkKindWhere,
} from "@/lib/session-pr-links";
import { agentSessionsService } from "../../service";
import { SessionSyncMetric } from "../session-sync-metrics";

vi.mock("@/app/branches/branch-detail-signal", () => ({
  emitBranchDetailChanged: vi.fn(),
  emitBranchDetailsChanged: vi.fn(),
}));

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

describe("agentSessionsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes session_pr artifact links on present-empty prRefs replay", async () => {
    const artifactLinkDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks(),
      artifactLink: { deleteMany: artifactLinkDeleteMany },
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      gitHubInstallation: {
        findFirst: vi.fn().mockResolvedValue(null),
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

    expect(artifactLinkDeleteMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        sourceId: "persisted-session-1",
        linkType: LinkType.RelatesTo,
        // ISS-5823: the replacement sweep runs at the Evidence audience, so it
        // owns the weak prose tier too — a sweep blind to those rows would
        // orphan every prose-derived link it should have replaced.
        ...sessionPrLinkKindWhere(SessionPrLinkAudience.Evidence),
        // FEA-2729: spare rows that also carry session_branch evidence.
        // ISS-9859: NULL-safe, so a row with no `branchLinked` key — every
        // PR-only link this lane writes — is matched and deleted.
        AND: [
          {
            OR: [
              { metadata: { path: ["branchLinked"], equals: Prisma.AnyNull } },
              { NOT: { metadata: { path: ["branchLinked"], equals: true } } },
            ],
          },
        ],
      },
    });
  });
  it("merges branch evidence onto an existing session_pr link without losing PR markers (merge-into-one-edge)", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
      ],
      existingLink: {
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionPr,
          relationTypes: [SessionPrRelationType.Created],
          repositoryFullName: "acme/web",
          prNumber: 7,
          confidence: 1,
          source: "DETERMINISTIC",
        },
      },
    });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_command",
        relation: ArtifactRefRelation.Created,
        observedAt: "2026-05-20T17:03:00.000Z",
      },
    ]);

    expect(m.linkRow).toHaveBeenCalledTimes(1);
    const metadata = m.linkRow.mock.calls[0][0].metadata;
    expect(metadata.linkKind).toBe(SessionArtifactLinkKind.SessionPr);
    expect(metadata.linkKinds).toEqual([
      SessionArtifactLinkKind.SessionBranch,
      SessionArtifactLinkKind.SessionPr,
    ]);
    expect(metadata.relationTypes).toEqual([SessionPrRelationType.Created]);
    expect(metadata.prNumber).toBe(7);
    expect(metadata.method).toBe("git_command");
    expect(metadata.relation).toBe(ArtifactRefRelation.Created);
    expect(metadata.branchLinked).toBe(true);
  });
  it("persists every same-branch PR identity with per-PR relation types", async () => {
    const artifactLinkDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const artifactLinkUpsert = vi.fn().mockResolvedValue({});
    const pullRequestDetailFindMany = vi.fn().mockResolvedValue([
      {
        id: "prd-1",
        repositoryId: "repo-1",
        number: 42,
        branchArtifactId: "branch-artifact-1",
        isCurrent: false,
      },
      {
        id: "prd-2",
        repositoryId: "repo-1",
        number: 43,
        branchArtifactId: "branch-artifact-1",
        isCurrent: true,
      },
      {
        id: "prd-incidental",
        repositoryId: "repo-1",
        number: 44,
        branchArtifactId: "branch-artifact-1",
        isCurrent: true,
      },
    ]);
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks(),
      artifactLink: {
        deleteMany: artifactLinkDeleteMany,
        upsert: artifactLinkUpsert,
      },
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      gitHubInstallation: {
        findFirst: vi.fn().mockResolvedValue({ id: "install-1" }),
      },
      gitHubInstallationRepository: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: "repo-1", fullName: "closedloop-ai/closedloop-ai" },
          ]),
      },
      pullRequestDetail: {
        findMany: pullRequestDetailFindMany,
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
        batchId: "agg-test-batch",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 1,
        sessions: [
          buildSyncedSession({
            prRefs: [
              {
                repositoryFullName: "closedloop-ai/closedloop-ai",
                prNumber: 42,
                relationType: SessionPrRelationType.Created,
                branchLifecycleEvents: [
                  {
                    kind: BranchLifecycleBoundaryKind.PrRaised,
                    observedAt: "2026-05-20T17:01:00.000Z",
                    evidenceId: "desktop-artifact-link:pr-create",
                  },
                ],
              },
              {
                repositoryFullName: "closedloop-ai/closedloop-ai",
                prNumber: 42,
                relationType: SessionPrRelationType.Referenced,
              },
              {
                repositoryFullName: "closedloop-ai/closedloop-ai",
                prNumber: 43,
                relationType: SessionPrRelationType.Reviewed,
              },
            ],
          }),
        ],
      }
    );

    expect(artifactLinkUpsert).toHaveBeenCalledTimes(1);
    expect(pullRequestDetailFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-1",
          lastVerifiedAt: { not: null },
          OR: [
            { repositoryId: "repo-1", number: 42 },
            { repositoryId: "repo-1", number: 43 },
          ],
        },
        select: expect.objectContaining({
          id: true,
          repositoryId: true,
          number: true,
          branchArtifactId: true,
        }),
      })
    );
    expect(pullRequestDetailFindMany.mock.invocationCallOrder[0]).toBeLessThan(
      artifactLinkUpsert.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    const upsertArg = artifactLinkUpsert.mock.calls[0][0];
    expect(upsertArg.create).toMatchObject({
      sourceId: "persisted-session-1",
      targetId: "branch-artifact-1",
      linkType: LinkType.RelatesTo,
      metadata: expect.objectContaining({
        linkKind: SessionArtifactLinkKind.SessionBranch,
        linkKinds: [
          SessionArtifactLinkKind.SessionBranch,
          SessionArtifactLinkKind.SessionPrSet,
        ],
        relationTypes: [
          SessionPrRelationType.Created,
          SessionPrRelationType.Referenced,
          SessionPrRelationType.Reviewed,
        ],
        branchLifecycleEvents: [
          {
            kind: BranchLifecycleBoundaryKind.PrRaised,
            observedAt: "2026-05-20T17:01:00.000Z",
            evidenceId: "desktop-artifact-link:pr-create",
          },
        ],
        prRefs: [
          {
            repositoryFullName: "closedloop-ai/closedloop-ai",
            prNumber: 42,
            relationTypes: [
              SessionPrRelationType.Created,
              SessionPrRelationType.Referenced,
            ],
          },
          {
            repositoryFullName: "closedloop-ai/closedloop-ai",
            prNumber: 43,
            relationTypes: [SessionPrRelationType.Reviewed],
          },
        ],
      }),
    });
    expect(upsertArg.create.metadata).not.toHaveProperty("repositoryFullName");
    expect(upsertArg.create.metadata).not.toHaveProperty("prNumber");
    expect(upsertArg.create.metadata.prRefs).not.toContainEqual(
      expect.objectContaining({ prNumber: 44 })
    );
    const prDeleteCall = artifactLinkDeleteMany.mock.calls.find(
      (call: unknown[]) =>
        (call[0] as { where: { OR?: unknown[] } }).where.OR !== undefined
    );
    expect(prDeleteCall).toBeDefined();
    const prDeleteArgs = prDeleteCall?.[0];
    expect(prDeleteArgs).toBeDefined();
    // ISS-9859: the branch-evidence exclusion is NULL-safe now, so a row with
    // no `branchLinked` key is deleted and only `branchLinked: true` is spared.
    expect((prDeleteArgs as { where: { AND?: unknown } }).where.AND).toEqual([
      {
        OR: [
          { metadata: { path: ["branchLinked"], equals: Prisma.AnyNull } },
          { NOT: { metadata: { path: ["branchLinked"], equals: true } } },
        ],
      },
    ]);
  });
  it("PR metadata updates preserve existing branch lifecycle metadata on merged edges", async () => {
    const artifactLinkUpsert = vi.fn().mockResolvedValue({});
    const existingMetadata = {
      linkKind: SessionArtifactLinkKind.SessionPr,
      linkKinds: [
        SessionArtifactLinkKind.SessionBranch,
        SessionArtifactLinkKind.SessionPr,
      ],
      branchLinked: true,
      method: "git_push",
      relation: ArtifactRefRelation.Created,
      branchName: "feat/x",
      branchRepositoryFullName: "closedloop-ai/closedloop-ai",
      branchLifecycleEvents: [
        {
          kind: BranchLifecycleBoundaryKind.PrRaised,
          observedAt: "2026-05-20T17:01:00.000Z",
          evidenceId: "desktop-artifact-link:pr-create",
        },
      ],
    };
    const artifactLinkFindMany = vi.fn().mockImplementation((args) =>
      args.select?.targetId
        ? Promise.resolve([
            {
              targetId: "branch-artifact-1",
              metadata: existingMetadata,
            },
          ])
        : Promise.resolve([])
    );
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks(),
      artifactLink: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: artifactLinkFindMany,
        upsert: artifactLinkUpsert,
      },
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      gitHubInstallation: {
        findFirst: vi.fn().mockResolvedValue({ id: "install-1" }),
      },
      gitHubInstallationRepository: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: "repo-1", fullName: "closedloop-ai/closedloop-ai" },
          ]),
      },
      pullRequestDetail: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "prd-1",
            repositoryId: "repo-1",
            number: 42,
            branchArtifactId: "branch-artifact-1",
          },
        ]),
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
        batchId: "preserve-branch-metadata",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 1,
        sessions: [
          buildSyncedSession({
            prRefs: [
              {
                repositoryFullName: "closedloop-ai/closedloop-ai",
                prNumber: 42,
                relationType: SessionPrRelationType.Reviewed,
                branchLifecycleEvents: [
                  {
                    kind: BranchLifecycleBoundaryKind.ReviewFeedback,
                    observedAt: "2026-05-20T17:03:00.000Z",
                    evidenceId: "desktop-artifact-link:review",
                  },
                ],
              },
            ],
          }),
        ],
      }
    );

    const metadata = artifactLinkUpsert.mock.calls[0][0].create.metadata;
    expect(metadata.branchLinked).toBe(true);
    expect(metadata.method).toBe("git_push");
    expect(metadata.relation).toBe(ArtifactRefRelation.Created);
    expect(metadata.linkKinds).toEqual([
      SessionArtifactLinkKind.SessionBranch,
      SessionArtifactLinkKind.SessionPr,
    ]);
    expect(metadata.branchLifecycleEvents).toEqual([
      {
        kind: BranchLifecycleBoundaryKind.PrRaised,
        observedAt: "2026-05-20T17:01:00.000Z",
        evidenceId: "desktop-artifact-link:pr-create",
      },
      {
        kind: BranchLifecycleBoundaryKind.ReviewFeedback,
        observedAt: "2026-05-20T17:03:00.000Z",
        evidenceId: "desktop-artifact-link:review",
      },
    ]);
  });
  it("ignores forged prUrl when resolving canonical prRefs identity", async () => {
    const artifactLinkUpsert = vi.fn().mockResolvedValue({});
    const repoFindMany = vi.fn().mockResolvedValue([
      {
        id: "repo-canonical",
        fullName: "closedloop-ai/closedloop-ai",
      },
    ]);
    const pullRequestDetailFindMany = vi.fn().mockResolvedValue([
      {
        id: "prd-canonical",
        repositoryId: "repo-canonical",
        number: 42,
        branchArtifactId: "branch-artifact-canonical",
      },
    ]);
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks(),
      artifactLink: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        upsert: artifactLinkUpsert,
      },
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      gitHubInstallation: {
        findFirst: vi.fn().mockResolvedValue({ id: "install-1" }),
      },
      gitHubInstallationRepository: {
        findMany: repoFindMany,
      },
      pullRequestDetail: {
        findMany: pullRequestDetailFindMany,
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
        batchId: "url-authority-test-batch",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 1,
        sessions: [
          buildSyncedSession({
            prRefs: [
              {
                repositoryFullName: "closedloop-ai/closedloop-ai",
                prNumber: 42,
                prUrl: "https://github.com/forged-org/forged-repo/pull/999",
                relationType: SessionPrRelationType.Created,
              },
            ],
          }),
        ],
      }
    );

    expect(repoFindMany).toHaveBeenCalledWith({
      where: {
        fullName: { in: ["closedloop-ai/closedloop-ai"] },
        removedAt: null,
        installation: {
          organizationId: "org-1",
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
      select: { id: true, fullName: true },
    });
    expect(pullRequestDetailFindMany).toHaveBeenCalledTimes(1);
    expect(pullRequestDetailFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-1",
          lastVerifiedAt: { not: null },
          OR: [{ repositoryId: "repo-canonical", number: 42 }],
        },
        select: expect.objectContaining({
          id: true,
          repositoryId: true,
          number: true,
          branchArtifactId: true,
        }),
      })
    );
    expect(artifactLinkUpsert).toHaveBeenCalledTimes(1);
    const upsertArg = artifactLinkUpsert.mock.calls[0][0];
    expect(upsertArg.create).toMatchObject({
      sourceId: "persisted-session-1",
      targetId: "branch-artifact-canonical",
      linkType: LinkType.RelatesTo,
      metadata: expect.objectContaining({
        linkKind: "session_pr",
        relationTypes: [SessionPrRelationType.Created],
        repositoryFullName: "closedloop-ai/closedloop-ai",
        prNumber: 42,
      }),
    });
    expect(upsertArg.create.metadata).not.toHaveProperty("prUrl");
  });
  it("stores unresolvable prRefs in session metadata._unresolvedPrRefs", async () => {
    const sessionUpdate = vi.fn().mockResolvedValue({});
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks({
        update: sessionUpdate,
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ metadata: null }),
      }),
      artifactLink: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      gitHubInstallation: {
        findFirst: vi.fn().mockResolvedValue(null),
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
        batchId: "unresolved-test-batch",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 1,
        sessions: [
          buildSyncedSession({
            prRefs: [
              {
                repositoryFullName: "unknown-org/unknown-repo",
                prNumber: 99,
                relationType: SessionPrRelationType.Created,
              },
            ],
          }),
        ],
      }
    );

    const metadataUpdate = sessionUpdate.mock.calls.find((call: unknown[]) => {
      const data = (call[0] as { data: Record<string, unknown> }).data;
      return data.metadata !== undefined;
    });
    expect(metadataUpdate).toBeDefined();
    const metadata = (
      metadataUpdate![0] as { data: { metadata: Record<string, unknown> } }
    ).data.metadata;
    expect(metadata._unresolvedPrRefs).toEqual([
      { repositoryFullName: "unknown-org/unknown-repo", prNumber: 99 },
    ]);
  });
});

/**
 * ISS-4946 (review, PR #4327): the legacy `pullRequests` blob and the session→PR
 * artifact links describe ONE PR state, and the read boundary splits across them
 * — `toSessionPullRequestProjection` seeds `prs` from the blob while
 * `verifiedMergedCount` and the authored-PR LOC arm are computed from the links.
 * Gating only the blob left a stale redelivery able to keep the newer blob and
 * still wipe the links, so the row settled into blob-plus-zero-links: every blob
 * entry unadjudicated, which the authoring gate reads as "no link rejects this,
 * keep it", and the pills and the merge count disagree on one record.
 *
 * These are service-level, not `toTraceDetailPatch`-level, precisely because the
 * invariant is about the two lanes agreeing across one apply.
 */
describe("agentSessionsService — PR blob and session_pr links share one gate (ISS-4946)", () => {
  const STALE_STORED_UPDATED_AT = new Date("2026-05-20T17:10:00.000Z");
  // Strictly older than SESSION_UPDATED_AT: an in-order resync that advances the
  // row. Named rather than inlined so it is not mistaken for a start timestamp.
  const FRESHER_STORED_UPDATED_AT = new Date("2026-05-20T17:00:00.000Z");

  // `mocks.emitTelemetryMetric` is module-level state that `installDb` does not
  // reset, and the `clearAllMocks` above lives inside a DIFFERENT describe. The
  // negative telemetry assertions below would otherwise be reading calls left by
  // whichever test ran last — passing on ordering luck rather than on behavior.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function installPrLaneDb(storedUpdatedAt: Date) {
    const artifactLinkDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const sessionDetailUpsert = vi
      .fn()
      .mockResolvedValue(persistedSessionDetail("persisted-session-1"));
    installDb({
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
        update: vi.fn().mockResolvedValue({ id: "target-1" }),
      },
      slugCounter: buildSlugCounterMock(),
      sessionDetail: buildDefaultAgentSessionMocks({
        // An already-persisted row is what makes this the update arm, and its
        // `sessionUpdatedAt` is the watermark the incoming batch is judged
        // against.
        findUnique: vi.fn().mockResolvedValue({
          artifactId: "persisted-session-1",
          agents: [],
          dataRevision: null,
          pendingChunkRevision: null,
          pendingChunkTotal: null,
          pendingChunkReceived: null,
          sessionStartedAt: SESSION_STARTED_AT,
          sessionUpdatedAt: storedUpdatedAt,
          sessionEndedAt: null,
          artifact: { status: SESSION_STATUS.ACTIVE },
        }),
        upsert: sessionDetailUpsert,
      }),
      artifactLink: {
        deleteMany: artifactLinkDeleteMany,
        upsert: vi.fn().mockResolvedValue({}),
      },
      agentSessionEvent: buildDefaultAgentSessionEventMocks(),
      agentSessionTokenUsage: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      gitHubInstallation: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    });
    return { artifactLinkDeleteMany, sessionDetailUpsert };
  }

  function syncSession(overrides: Partial<SyncedAgentSession>) {
    return agentSessionsService.upsertSessions(
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
        sessions: [buildSyncedSession(overrides)],
      }
    );
  }

  function countSessionPrDeletes(deleteMany: Mock): number {
    return deleteMany.mock.calls.filter((call: unknown[]) => {
      const arg = call[0] as
        | {
            where?: {
              OR?: Array<{ metadata?: { equals?: string } }>;
            };
          }
        | undefined;
      return arg?.where?.OR?.some(
        (clause) =>
          clause.metadata?.equals === SessionArtifactLinkKind.SessionPr
      );
    }).length;
  }

  function updateArm(upsert: Mock): Record<string, unknown> {
    return (upsert.mock.calls[0][0] as { update: Record<string, unknown> })
      .update;
  }

  it("skips BOTH lanes on a stale redelivery", async () => {
    const { artifactLinkDeleteMany, sessionDetailUpsert } = installPrLaneDb(
      STALE_STORED_UPDATED_AT
    );

    await syncSession({ prRefs: [] });

    expect(Object.hasOwn(updateArm(sessionDetailUpsert), "pullRequests")).toBe(
      false
    );
    expect(countSessionPrDeletes(artifactLinkDeleteMany)).toBe(0);
    // An ordinary stale skip is the regression this issue FIXES, not an accepted
    // loss — and it is the commoner event. Emitting the tie signal here would
    // drown the case that signal exists to surface.
    expect(mocks.emitTelemetryMetric).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.PrStatePreservedOnTie,
      })
    );
  });

  // whitlockk's tie case: pre-3bc26f527 Desktop builds commit the session row and
  // the PR/link phases separately under one `updatedAt`, so an empty pre-link
  // snapshot and a populated post-link snapshot compare EQUAL to the stored
  // watermark. Sync can reorder, so the empty one must not be allowed to land
  // last and clear the newer PR state.
  it("skips BOTH lanes for an equal-watermark snapshot carrying no PR evidence", async () => {
    const { artifactLinkDeleteMany, sessionDetailUpsert } =
      installPrLaneDb(SESSION_UPDATED_AT);

    await syncSession({ prRefs: [] });

    expect(Object.hasOwn(updateArm(sessionDetailUpsert), "pullRequests")).toBe(
      false
    );
    expect(countSessionPrDeletes(artifactLinkDeleteMany)).toBe(0);
    // The tie-break's accepted loss: this same shape is indistinguishable on the
    // wire from a genuine retraction, and on an ended session no later batch
    // moves the watermark to relitigate it. AGENTS.md forbids absorbing that
    // silently, so the skip is reported to the same monitored path the
    // poisoned-watermark repair uses.
    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.PrStatePreservedOnTie,
      })
    );
  });

  // The counter measures what the tie-break COSTS, so a tie that suppressed
  // nothing must stay out of it. A pre-link-extraction build sends neither shape:
  // the blob patch omits the column and the link lane early-returns on an
  // undefined ref list, so both lanes skip without preserving anything.
  it("does not report a tie-preserve when the snapshot carries neither PR shape", async () => {
    const { artifactLinkDeleteMany, sessionDetailUpsert } =
      installPrLaneDb(SESSION_UPDATED_AT);

    await syncSession({});

    expect(Object.hasOwn(updateArm(sessionDetailUpsert), "pullRequests")).toBe(
      false
    );
    expect(countSessionPrDeletes(artifactLinkDeleteMany)).toBe(0);
    expect(mocks.emitTelemetryMetric).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.PrStatePreservedOnTie,
      })
    );
  });

  it("runs BOTH lanes for an equal-watermark snapshot that carries PR evidence", async () => {
    const { artifactLinkDeleteMany, sessionDetailUpsert } =
      installPrLaneDb(SESSION_UPDATED_AT);

    await syncSession({
      prs: [{ num: 7, title: "PR #7", status: "merged" }],
      prRefs: [
        {
          repositoryFullName: "acme/web",
          prNumber: 7,
          relationType: SessionPrRelationType.Created,
        },
      ],
    });

    expect(updateArm(sessionDetailUpsert).pullRequests).toEqual([
      { num: 7, title: "PR #7", status: "merged" },
    ]);
    expect(countSessionPrDeletes(artifactLinkDeleteMany)).toBe(1);
  });

  // whitlockk's second edge case: `updatedAt` is Desktop-produced and unvalidated,
  // so a bad clock can persist a watermark years ahead. Max-wins then keeps it
  // forever and every legitimate sync compares older, freezing the PR lanes (and
  // every other guarded column) on that row. A plausible batch must be able to
  // unstick it.
  it("runs BOTH lanes when the stored watermark is implausibly future (poisoned-clock repair)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T17:30:00.000Z"));
    try {
      const { artifactLinkDeleteMany, sessionDetailUpsert } = installPrLaneDb(
        new Date("2031-05-20T17:00:00.000Z")
      );

      await syncSession({
        prs: [{ num: 7, title: "PR #7", status: "merged" }],
        prRefs: [
          {
            repositoryFullName: "acme/web",
            prNumber: 7,
            relationType: SessionPrRelationType.Created,
          },
        ],
      });

      expect(updateArm(sessionDetailUpsert).pullRequests).toEqual([
        { num: 7, title: "PR #7", status: "merged" },
      ]);
      expect(countSessionPrDeletes(artifactLinkDeleteMany)).toBe(1);
      // The repair also replaces the poisoned column, so the row stops needing
      // the escape hatch on every subsequent sync.
      expect(updateArm(sessionDetailUpsert).sessionUpdatedAt).toEqual(
        SESSION_UPDATED_AT
      );
      // AGENTS.md "Handling Bad or Nonsensical Data": the repair must stay on
      // the monitored path, so pin the emission a refactor would otherwise drop.
      expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith(
        expect.objectContaining({
          metric: SessionSyncMetric.PoisonedWatermarkRepaired,
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs BOTH lanes for a strictly fresher retraction so the clear still lands", async () => {
    const { artifactLinkDeleteMany, sessionDetailUpsert } = installPrLaneDb(
      FRESHER_STORED_UPDATED_AT
    );

    await syncSession({ prRefs: [] });

    expect(updateArm(sessionDetailUpsert).pullRequests).toBe(Prisma.DbNull);
    expect(countSessionPrDeletes(artifactLinkDeleteMany)).toBe(1);
  });

  // The split state the OR'd evidence flag would have reintroduced from inside
  // the gate: the two desktop producers have independent caps and different
  // admission predicates, so `prs` populated with `prRefs: []` is a shape the
  // wire genuinely carries. Under one shared boolean the blob's evidence let the
  // link lane through, and its delete-and-recreate wiped every session_pr row —
  // populated blob, zero links, exactly what this issue exists to prevent.
  it("does not let the blob's evidence open the link lane at an equal watermark", async () => {
    const { artifactLinkDeleteMany, sessionDetailUpsert } =
      installPrLaneDb(SESSION_UPDATED_AT);

    await syncSession({
      prs: [{ num: 7, title: "PR #7", status: "merged" }],
      prRefs: [],
    });

    // The blob carries its own evidence, so it writes.
    expect(updateArm(sessionDetailUpsert).pullRequests).toEqual([
      { num: 7, title: "PR #7", status: "merged" },
    ]);
    // The link lane has nothing to write, so it must PRESERVE rather than wipe.
    expect(countSessionPrDeletes(artifactLinkDeleteMany)).toBe(0);
    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.PrStatePreservedOnTie,
      })
    );
  });

  // The mirror image, and the reason the gate is per-lane rather than per-shape:
  // link evidence must not authorize the blob's destructive CLEAR either.
  it("does not let the link lane's evidence open the blob at an equal watermark", async () => {
    const { artifactLinkDeleteMany, sessionDetailUpsert } =
      installPrLaneDb(SESSION_UPDATED_AT);

    await syncSession({
      prRefs: [
        {
          repositoryFullName: "acme/web",
          prNumber: 7,
          relationType: SessionPrRelationType.Created,
        },
      ],
    });

    expect(Object.hasOwn(updateArm(sessionDetailUpsert), "pullRequests")).toBe(
      false
    );
    expect(countSessionPrDeletes(artifactLinkDeleteMany)).toBe(1);
  });
});
