import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import { LinkType } from "@repo/api/src/types/artifact";
import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { GitHubInstallationStatus } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentSessionsService } from "../../service";
import {
  buildDefaultAgentSessionEventMocks,
  buildDefaultAgentSessionMocks,
  buildSlugCounterMock,
  buildSyncedSession,
  installBranchIngestDb,
  installDb,
  syncBranchRefs,
} from "../../service.test-harness";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import("../../service.test-mocks");
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import("../../service.test-mocks");
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
        metadata: { path: ["linkKind"], equals: "session_pr" },
        // FEA-2729: spare rows that also carry session_branch evidence.
        NOT: { metadata: { path: ["branchLinked"], equals: true } },
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

    expect(m.artifactLinkUpsert).toHaveBeenCalledTimes(1);
    const metadata = m.artifactLinkUpsert.mock.calls[0][0].create.metadata;
    // PR precedence keeps the scalar linkKind so the session_pr reader works.
    expect(metadata.linkKind).toBe(SessionArtifactLinkKind.SessionPr);
    // Both kinds are recorded, sorted.
    expect(metadata.linkKinds).toEqual([
      SessionArtifactLinkKind.SessionBranch,
      SessionArtifactLinkKind.SessionPr,
    ]);
    // PR markers preserved…
    expect(metadata.relationTypes).toEqual([SessionPrRelationType.Created]);
    expect(metadata.prNumber).toBe(7);
    // …and branch evidence added.
    expect(metadata.method).toBe("git_command");
    expect(metadata.relation).toBe(ArtifactRefRelation.Created);
    expect(metadata.branchLinked).toBe(true);
  });
  it("aggregates CREATED and REFERENCED prRefs for same PR into single ArtifactLink with relationTypes array", async () => {
    const artifactLinkDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const artifactLinkUpsert = vi.fn().mockResolvedValue({});
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
            { id: "repo-1", fullName: "closedloop-ai/symphony-alpha" },
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
        batchId: "agg-test-batch",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 1,
        sessions: [
          buildSyncedSession({
            prRefs: [
              {
                repositoryFullName: "closedloop-ai/symphony-alpha",
                prNumber: 42,
                relationType: SessionPrRelationType.Created,
              },
              {
                repositoryFullName: "closedloop-ai/symphony-alpha",
                prNumber: 42,
                relationType: SessionPrRelationType.Referenced,
              },
            ],
          }),
        ],
      }
    );

    expect(artifactLinkUpsert).toHaveBeenCalledTimes(1);
    const upsertArg = artifactLinkUpsert.mock.calls[0][0];
    expect(upsertArg.create).toMatchObject({
      sourceId: "persisted-session-1",
      targetId: "branch-artifact-1",
      linkType: LinkType.RelatesTo,
      metadata: expect.objectContaining({
        linkKind: "session_pr",
        relationTypes: [
          SessionPrRelationType.Created,
          SessionPrRelationType.Referenced,
        ],
        repositoryFullName: "closedloop-ai/symphony-alpha",
        prNumber: 42,
      }),
    });
    // FEA-2729: the PR lane's replacement delete must spare rows that also
    // carry session_branch evidence (a merged edge keeps linkKind=session_pr).
    const prDeleteCall = artifactLinkDeleteMany.mock.calls.find(
      (call: unknown[]) =>
        (call[0] as { where: Record<string, unknown> }).where.metadata !==
        undefined
    );
    expect(prDeleteCall).toBeDefined();
    const prDeleteArgs = prDeleteCall?.[0];
    expect(prDeleteArgs).toBeDefined();
    expect((prDeleteArgs as { where: { NOT?: unknown } }).where.NOT).toEqual({
      metadata: { path: ["branchLinked"], equals: true },
    });
  });
  it("ignores forged prUrl when resolving canonical prRefs identity", async () => {
    const artifactLinkUpsert = vi.fn().mockResolvedValue({});
    const repoFindMany = vi.fn().mockResolvedValue([
      {
        id: "repo-canonical",
        fullName: "closedloop-ai/symphony-alpha",
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
                repositoryFullName: "closedloop-ai/symphony-alpha",
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
        installationId: "install-1",
        fullName: { in: ["closedloop-ai/symphony-alpha"] },
        removedAt: null,
        installation: {
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
      select: { id: true, fullName: true },
    });
    expect(pullRequestDetailFindMany).toHaveBeenCalledWith({
      where: {
        isCurrent: true,
        lastVerifiedAt: { not: null },
        OR: [{ repositoryId: "repo-canonical", number: 42 }],
      },
      select: { repositoryId: true, number: true, branchArtifactId: true },
    });
    expect(artifactLinkUpsert).toHaveBeenCalledTimes(1);
    const upsertArg = artifactLinkUpsert.mock.calls[0][0];
    expect(upsertArg.create).toMatchObject({
      sourceId: "persisted-session-1",
      targetId: "branch-artifact-canonical",
      linkType: LinkType.RelatesTo,
      metadata: expect.objectContaining({
        linkKind: "session_pr",
        relationTypes: [SessionPrRelationType.Created],
        repositoryFullName: "closedloop-ai/symphony-alpha",
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
