import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import {
  BranchLifecycleBoundaryKind,
  BranchParticipationKind,
} from "@repo/api/src/types/branch";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  SessionArtifactLinkKind,
  SessionArtifactLinkMetadataSource,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDefaultAgentSessionEventMocks,
  buildDefaultAgentSessionMocks,
  buildSlugCounterMock,
  buildSyncedSession,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../../service";

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

describe("agentSessionsService PR-only replacements", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears stale PR-derived branch projection on a PR-only replacement", async () => {
    const artifactLinkUpsert = vi.fn().mockResolvedValue({});
    const existingMetadata = {
      linkKind: SessionArtifactLinkKind.SessionPr,
      linkKinds: [
        SessionArtifactLinkKind.SessionBranch,
        SessionArtifactLinkKind.SessionPr,
      ],
      method: ArtifactRefMethod.PrCreateOutput,
      relation: ArtifactRefRelation.Created,
      observedAt: "2026-05-20T17:01:00.000Z",
      branchName: "feat/x",
      branchRepositoryFullName: "closedloop-ai/closedloop-ai",
      branchParticipation: BranchParticipationKind.Wrote,
      branchSource: SessionArtifactLinkMetadataSource.DesktopSync,
      branchExtractorVersion: 1,
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
              branchParticipation: BranchParticipationKind.Wrote,
              branchParticipationMethod: ArtifactRefMethod.PrCreateOutput,
              branchParticipationObservedAt: new Date(
                "2026-05-20T17:01:00.000Z"
              ),
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
        batchId: "pr-only-replacement-clears-branch-projection",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 1,
        sessions: [
          buildSyncedSession({
            prRefs: [
              {
                repositoryFullName: "closedloop-ai/closedloop-ai",
                prNumber: 42,
                relationType: SessionPrRelationType.Referenced,
              },
            ],
          }),
        ],
      }
    );

    const update = artifactLinkUpsert.mock.calls[0][0].update;
    expect(update).toMatchObject({
      branchParticipation: null,
      branchParticipationMethod: null,
      branchParticipationObservedAt: null,
      metadata: expect.objectContaining({
        linkKind: SessionArtifactLinkKind.SessionPr,
        linkKinds: [SessionArtifactLinkKind.SessionPr],
        relationTypes: [SessionPrRelationType.Referenced],
        repositoryFullName: "closedloop-ai/closedloop-ai",
        prNumber: 42,
      }),
    });
    expect(update.metadata).not.toHaveProperty("branchLinked");
    expect(update.metadata).not.toHaveProperty("branchParticipation");
    expect(update.metadata).not.toHaveProperty("branchName");
    expect(update.metadata).not.toHaveProperty("branchLifecycleEvents");
  });
});
