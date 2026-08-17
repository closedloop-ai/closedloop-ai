import { ArtifactType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionListRecord,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../service";

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

function branchLink({
  id,
  branchName,
  repoFullName,
  branchParticipation,
}: {
  id: string;
  branchName: string;
  repoFullName?: string;
  branchParticipation?: BranchParticipationKind;
}) {
  return {
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionBranch,
      branchName,
      branchRepositoryFullName: repoFullName ?? "closedloop-ai/symphony-alpha",
    },
    ...(branchParticipation ? { branchParticipation } : {}),
    target: {
      id,
      name: branchName,
      type: ArtifactType.Branch,
      branch: {
        repository: repoFullName
          ? { fullName: repoFullName }
          : { fullName: "closedloop-ai/symphony-alpha" },
        currentPullRequestDetail: null,
      },
    },
  };
}

function prLink({
  id,
  branchName,
  prNumber,
  repoFullName,
}: {
  id: string;
  branchName: string;
  prNumber: number;
  repoFullName?: string;
}) {
  return {
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionPr,
      relationTypes: [SessionPrRelationType.Created],
      repositoryFullName: repoFullName ?? "closedloop-ai/symphony-alpha",
      prNumber,
      source: "DETERMINISTIC",
      confidence: 1.0,
      extractorVersion: 1,
    },
    branchParticipation: null,
    target: {
      id,
      name: branchName,
      type: ArtifactType.Branch,
      branch: {
        repository: {
          fullName: repoFullName ?? "closedloop-ai/symphony-alpha",
        },
        currentPullRequestDetail: {
          number: prNumber,
          title: `PR #${prNumber}`,
          prState: "OPEN",
          closedAt: null,
          mergedAt: null,
          lastVerifiedAt: null,
          githubCreatedAt: null,
          isCurrent: true,
          additions: null,
          deletions: null,
          repositoryFullName: repoFullName ?? "closedloop-ai/symphony-alpha",
          repository: null,
        },
      },
    },
  };
}

async function findFirstSession(
  sourceLinks: ReturnType<typeof branchLink | typeof prLink>[],
  repositoryFullName: string | null = null
) {
  installDb({
    sessionDetail: {
      findMany: vi.fn().mockResolvedValue([
        buildSessionListRecord({
          repositoryFullName,
          artifact: {
            name: "Repo-resolution test session",
            status: "completed",
            slug: "SES-REPO",
            project: null,
            sourceLinks,
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
  return result.items[0];
}

describe("ISS-4431: repository resolution from branch links", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves repositoryFullName from touched-branch link when session has no repo", async () => {
    const session = await findFirstSession([
      branchLink({
        id: "branch-1",
        branchName: "feat/iss-4431",
        branchParticipation: BranchParticipationKind.Wrote,
      }),
    ]);

    expect(session.repositoryFullName).toBe("closedloop-ai/symphony-alpha");
    expect(session.repo).toBe("closedloop-ai/symphony-alpha");
  });

  it("branch provenance takes precedence over stored repositoryFullName", async () => {
    const session = await findFirstSession(
      [
        branchLink({
          id: "branch-1",
          branchName: "feat/other",
          repoFullName: "acme/branch-repo",
          branchParticipation: BranchParticipationKind.Wrote,
        }),
      ],
      "acme/stored-repo"
    );

    expect(session.repositoryFullName).toBe("acme/branch-repo");
    expect(session.repo).toBe("acme/branch-repo");
  });

  it("falls back to stored repositoryFullName when no branch link has a repo", async () => {
    const session = await findFirstSession([], "acme/stored-repo");

    expect(session.repositoryFullName).toBe("acme/stored-repo");
    expect(session.repo).toBe("acme/stored-repo");
  });

  it("returns null repositoryFullName when no branch links exist", async () => {
    const session = await findFirstSession([]);

    expect(session.repositoryFullName).toBeNull();
    expect(session.repo).toBeNull();
  });

  it("prefers Wrote-participation branch for repository resolution", async () => {
    const session = await findFirstSession([
      branchLink({
        id: "branch-reviewed",
        branchName: "feat/reviewed",
        repoFullName: "acme/reviewed-repo",
        branchParticipation: BranchParticipationKind.Reviewed,
      }),
      branchLink({
        id: "branch-wrote",
        branchName: "feat/wrote",
        repoFullName: "acme/wrote-repo",
        branchParticipation: BranchParticipationKind.Wrote,
      }),
    ]);

    expect(session.repositoryFullName).toBe("acme/wrote-repo");
    expect(session.repo).toBe("acme/wrote-repo");
  });

  it("repositoryFullName and repo aliases always agree", async () => {
    const session = await findFirstSession([
      branchLink({
        id: "branch-1",
        branchName: "main",
        repoFullName: "acme/web",
        branchParticipation: BranchParticipationKind.Wrote,
      }),
    ]);

    expect(session.repositoryFullName).toBe(session.repo);
  });
});
