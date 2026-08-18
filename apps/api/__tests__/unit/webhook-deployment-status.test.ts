import { LinkType } from "@repo/api/src/types/artifact";
import { DeploymentEventState } from "@repo/api/src/types/deployment-event";
import { Result } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => {
  const mockWithDb: any = vi.fn();
  mockWithDb.tx = vi.fn();
  return {
    GitHubInstallationStatus: {
      ACTIVE: "ACTIVE",
    },
    withDb: mockWithDb,
  };
});

vi.mock("@repo/observability/log", () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/app/deployments/deployment-service", () => ({
  deploymentService: {
    recordDeployment: vi.fn(),
  },
  recordDeploymentTxOptions: { timeout: 15_000 },
}));

vi.mock("@/app/deployments/deployment-event-service", () => ({
  deploymentEventService: {
    recordEvent: vi.fn(),
  },
}));

vi.mock("@/app/webhooks/github/handlers/branch-activity-producer", () => ({
  GitHubBranchActivityEventName: { DeploymentStatus: "deployment_status" },
  persistGitHubBranchActivity: vi.fn().mockResolvedValue({
    status: "persisted",
    persistenceStatus: "inserted",
  }),
}));

import { GitHubInstallationStatus, withDb } from "@repo/database";
import { deploymentEventService } from "@/app/deployments/deployment-event-service";
import { deploymentService } from "@/app/deployments/deployment-service";
import {
  GitHubBranchActivityEventName,
  persistGitHubBranchActivity,
} from "@/app/webhooks/github/handlers/branch-activity-producer";
import { handleDeploymentStatus } from "@/app/webhooks/github/handlers/deployment-status-handler";

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn> & {
  tx: ReturnType<typeof vi.fn>;
};
const mockRecordDeployment = deploymentService.recordDeployment as ReturnType<
  typeof vi.fn
>;
const mockRecordEvent = deploymentEventService.recordEvent as ReturnType<
  typeof vi.fn
>;
const mockPersistGitHubBranchActivity =
  persistGitHubBranchActivity as ReturnType<typeof vi.fn>;

function buildDeploymentStatusEvent(overrides: Record<string, unknown> = {}) {
  return {
    deployment: {
      id: 4242,
      environment: "Preview",
      ref: "feature-branch",
      sha: "abc123",
      created_at: "2026-08-03T11:58:00.000Z",
      transient_environment: true,
      production_environment: false,
    },
    deployment_status: {
      id: 99_001,
      state: "success",
      environment_url: "https://preview.example.com",
      url: "https://api.github.com/status",
      deployment_url: "https://api.github.com/deployment",
      created_at: "2026-08-03T11:59:00.000Z",
    },
    repository: {
      id: 123,
      full_name: "org/repo",
    },
    installation: {
      id: 555,
    },
    ...overrides,
  } as any;
}

/**
 * The pre-ISS-4975 fixture shape: no provider ids, no timestamps. Old deliveries
 * (and any provider that omits them) must still drive the current-state path.
 */
function buildLegacyDeploymentStatusEvent() {
  return {
    deployment: {
      environment: "Preview",
      ref: "feature-branch",
      sha: "abc123",
      transient_environment: true,
      production_environment: false,
    },
    deployment_status: {
      state: "success",
      environment_url: "https://preview.example.com",
      url: "https://api.github.com/status",
      deployment_url: "https://api.github.com/deployment",
    },
    repository: {
      id: 123,
      full_name: "org/repo",
    },
    installation: {
      id: 555,
    },
  } as any;
}

describe("handleDeploymentStatus", () => {
  let mockDb: any;
  let mockTx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = {
      gitHubInstallationRepository: {
        findFirst: vi.fn(),
      },
      branchDetail: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
    };
    mockTx = {
      artifactLink: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
    };
    mockWithDb.mockImplementation((callback: any) => callback(mockDb));
    mockWithDb.tx.mockImplementation((callback: any) => callback(mockTx));
    mockRecordEvent.mockResolvedValue(Result.ok({ recorded: true }));
    mockDb.branchDetail.findMany.mockImplementation(async (args: unknown) => {
      const row = await mockDb.branchDetail.findFirst(args);
      return row ? [row] : [];
    });
  });

  function withTrackedRepoAndBranch() {
    mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
      id: "repo-1",
      installation: { organizationId: "org-1" },
    });
    mockDb.branchDetail.findFirst.mockResolvedValue({
      artifactId: "branch-artifact-1",
      branchName: "feature-branch",
      headSha: "abc123",
      artifact: {
        organizationId: "org-1",
        projectId: "project-1",
      },
    });
  }

  it("does not create a deployment when no branch artifact exists", async () => {
    mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
      id: "repo-1",
      installation: { organizationId: "org-1" },
    });
    mockDb.branchDetail.findFirst.mockResolvedValue(null);

    const response = await handleDeploymentStatus(buildDeploymentStatusEvent());

    expect(mockRecordDeployment).not.toHaveBeenCalled();
    expect(mockWithDb.tx).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it("fails closed when repository history leaves duplicate ref matches", async () => {
    mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
      id: "repo-1",
      installation: { organizationId: "org-1" },
    });
    mockDb.branchDetail.findMany.mockResolvedValue([
      {
        artifactId: "branch-artifact-old-name",
        branchName: "feature-branch",
        headSha: "abc123",
        artifact: { organizationId: "org-1", projectId: "project-1" },
      },
      {
        artifactId: "branch-artifact-new-name",
        branchName: "feature-branch",
        headSha: "abc123",
        artifact: { organizationId: "org-1", projectId: "project-1" },
      },
    ]);

    const event = buildDeploymentStatusEvent();
    await handleDeploymentStatus(event, {
      deliveryId: "deployment-ambiguous-ref",
      observedAt: new Date("2026-08-12T14:00:00.000Z"),
    });

    expect(mockDb.branchDetail.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 2 })
    );
    expect(mockRecordDeployment).not.toHaveBeenCalled();
    expect(mockPersistGitHubBranchActivity).toHaveBeenCalledWith({
      eventName: GitHubBranchActivityEventName.DeploymentStatus,
      deliveryId: "deployment-ambiguous-ref",
      payload: event,
      attribution: undefined,
    });
  });

  it("rejects tombstoned repositories before deployment writes", async () => {
    mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue(null);

    const response = await handleDeploymentStatus(buildDeploymentStatusEvent());

    expect(mockDb.gitHubInstallationRepository.findFirst).toHaveBeenCalledWith({
      where: {
        githubRepoId: "123",
        fullName: "org/repo",
        removedAt: null,
        installation: {
          installationId: "555",
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
      select: { id: true, installation: { select: { organizationId: true } } },
    });
    expect(mockDb.branchDetail.findFirst).not.toHaveBeenCalled();
    expect(mockRecordDeployment).not.toHaveBeenCalled();
    expect(mockRecordEvent).not.toHaveBeenCalled();
    expect(mockPersistGitHubBranchActivity).not.toHaveBeenCalled();
    expect(mockWithDb.tx).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it("records deployment against branchArtifactId and links branch to deployment", async () => {
    withTrackedRepoAndBranch();
    mockRecordDeployment.mockResolvedValue(
      Result.ok({ id: "deployment-artifact-1" })
    );
    mockTx.artifactLink.findFirst.mockResolvedValue(null);

    const event = buildDeploymentStatusEvent();
    const response = await handleDeploymentStatus(event, {
      deliveryId: "deployment-delivery-1",
      observedAt: new Date("2026-08-12T14:00:00.000Z"),
    });

    expect(mockRecordDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        projectId: "project-1",
        ref: "feature-branch",
        sha: "abc123",
        branchArtifactId: "branch-artifact-1",
      })
    );
    expect(mockTx.artifactLink.create).toHaveBeenCalledWith({
      data: {
        organizationId: "org-1",
        sourceId: "branch-artifact-1",
        targetId: "deployment-artifact-1",
        linkType: LinkType.Produces,
      },
      select: { id: true },
    });
    expect(mockPersistGitHubBranchActivity).toHaveBeenCalledWith({
      eventName: GitHubBranchActivityEventName.DeploymentStatus,
      deliveryId: "deployment-delivery-1",
      payload: event,
      attribution: {
        organizationId: "org-1",
        branchArtifactId: "branch-artifact-1",
      },
    });
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it("records deployment scoped to the branch project", async () => {
    withTrackedRepoAndBranch();
    mockRecordDeployment.mockResolvedValue(
      Result.ok({ id: "deployment-artifact-1" })
    );
    mockTx.artifactLink.findFirst.mockResolvedValue(null);

    const response = await handleDeploymentStatus(buildDeploymentStatusEvent());

    expect(mockRecordDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        projectId: "project-1",
        branchArtifactId: "branch-artifact-1",
      })
    );
    expect(mockTx.artifactLink.create).toHaveBeenCalledWith({
      data: {
        organizationId: "org-1",
        sourceId: "branch-artifact-1",
        targetId: "deployment-artifact-1",
        linkType: LinkType.Produces,
      },
      select: { id: true },
    });
    expect(await response.json()).toMatchObject({ ok: true });
  });

  describe("append-only history (ISS-4975)", () => {
    it("records a failure transition that the old handler dropped", async () => {
      withTrackedRepoAndBranch();

      const response = await handleDeploymentStatus(
        buildDeploymentStatusEvent({
          deployment_status: {
            id: 99_002,
            state: "failure",
            url: "https://api.github.com/status",
            created_at: "2026-08-03T11:59:30.000Z",
          },
        })
      );

      expect(mockRecordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: "org-1",
          repositoryId: "repo-1",
          branchArtifactId: "branch-artifact-1",
          projectId: "project-1",
          externalDeploymentId: "4242",
          externalEventId: "99002",
          state: DeploymentEventState.Failure,
          providerState: "failure",
          environmentUrl: null,
          occurredAt: new Date("2026-08-03T11:59:30.000Z"),
        })
      );
      // A failure must never touch current state.
      expect(mockRecordDeployment).not.toHaveBeenCalled();
      expect(await response.json()).toMatchObject({ ok: true });
    });

    it("appends a second history row for a re-deploy that overwrites current state", async () => {
      withTrackedRepoAndBranch();
      mockRecordDeployment.mockResolvedValue(
        Result.ok({ id: "deployment-artifact-1" })
      );
      mockTx.artifactLink.findFirst.mockResolvedValue({ id: "link-1" });

      await handleDeploymentStatus(buildDeploymentStatusEvent());
      await handleDeploymentStatus(
        buildDeploymentStatusEvent({
          deployment: {
            id: 4243,
            environment: "Preview",
            ref: "feature-branch",
            sha: "def456",
            created_at: "2026-08-03T12:58:00.000Z",
          },
          deployment_status: {
            id: 99_009,
            state: "success",
            // Vercel reuses the preview URL, which is exactly why the
            // current-state row is overwritten and cannot be counted.
            environment_url: "https://preview.example.com",
            created_at: "2026-08-03T12:59:00.000Z",
          },
        })
      );

      expect(mockRecordEvent).toHaveBeenCalledTimes(2);
      const firstEvent = mockRecordEvent.mock.calls[0][0];
      const secondEvent = mockRecordEvent.mock.calls[1][0];
      expect(firstEvent.externalDeploymentId).toBe("4242");
      expect(secondEvent.externalDeploymentId).toBe("4243");
      expect(firstEvent.externalEventId).not.toBe(secondEvent.externalEventId);
      expect(secondEvent.occurredAt).toEqual(
        new Date("2026-08-03T12:59:00.000Z")
      );
    });

    it("records an unknown provider state instead of dropping the event", async () => {
      withTrackedRepoAndBranch();

      const response = await handleDeploymentStatus(
        buildDeploymentStatusEvent({
          deployment_status: {
            id: 99_003,
            state: "quantum_rollout",
            created_at: "2026-08-03T11:59:00.000Z",
          },
        })
      );

      expect(mockRecordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          state: DeploymentEventState.Unknown,
          providerState: "quantum_rollout",
        })
      );
      expect(mockRecordDeployment).not.toHaveBeenCalled();
      expect(await response.json()).toMatchObject({ ok: true });
    });

    it("records history for a repo-level deploy with no branch artifact", async () => {
      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-1",
        installation: { organizationId: "org-1" },
      });
      mockDb.branchDetail.findFirst.mockResolvedValue(null);

      await handleDeploymentStatus(
        buildDeploymentStatusEvent({
          deployment: {
            id: 5000,
            environment: "Production",
            ref: "main",
            sha: "aaa111",
            production_environment: true,
          },
          deployment_status: {
            id: 99_100,
            state: "success",
            created_at: "2026-08-03T11:59:00.000Z",
          },
        })
      );

      expect(mockRecordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: "org-1",
          repositoryId: "repo-1",
          branchArtifactId: null,
          projectId: null,
          production: true,
          ref: "main",
        })
      );
    });

    it("skips history but still updates current state for an old payload shape", async () => {
      withTrackedRepoAndBranch();
      mockRecordDeployment.mockResolvedValue(
        Result.ok({ id: "deployment-artifact-1" })
      );
      mockTx.artifactLink.findFirst.mockResolvedValue(null);

      const response = await handleDeploymentStatus(
        buildLegacyDeploymentStatusEvent()
      );

      expect(mockRecordEvent).not.toHaveBeenCalled();
      expect(mockRecordDeployment).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: "org-1",
          branchArtifactId: "branch-artifact-1",
        })
      );
      expect(await response.json()).toMatchObject({ ok: true });
    });

    it("skips history when the installation has no organization", async () => {
      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-1",
        installation: { organizationId: null },
      });
      mockDb.branchDetail.findFirst.mockResolvedValue(null);

      const response = await handleDeploymentStatus(
        buildDeploymentStatusEvent()
      );

      expect(mockRecordEvent).not.toHaveBeenCalled();
      expect(await response.json()).toMatchObject({ ok: true });
    });

    it("does not fail the webhook when the history write throws", async () => {
      withTrackedRepoAndBranch();
      mockRecordEvent.mockRejectedValue(new Error("db down"));
      mockRecordDeployment.mockResolvedValue(
        Result.ok({ id: "deployment-artifact-1" })
      );
      mockTx.artifactLink.findFirst.mockResolvedValue(null);

      const response = await handleDeploymentStatus(
        buildDeploymentStatusEvent()
      );

      // History is additive: its failure must not turn a webhook that would
      // otherwise update current state into a 500 and a GitHub redelivery.
      expect(mockRecordDeployment).toHaveBeenCalled();
      expect(await response.json()).toMatchObject({ ok: true });
    });

    it("skips history when the payload carries no parseable occurrence time", async () => {
      withTrackedRepoAndBranch();
      mockRecordDeployment.mockResolvedValue(
        Result.ok({ id: "deployment-artifact-1" })
      );
      mockTx.artifactLink.findFirst.mockResolvedValue(null);

      const response = await handleDeploymentStatus(
        buildDeploymentStatusEvent({
          deployment_status: {
            id: 99_200,
            state: "success",
            environment_url: "https://preview.example.com",
            created_at: "not-a-date",
          },
        })
      );

      // An immutable row stamped with the ingest clock would land a delayed
      // redelivery in the wrong DORA window forever, so no row is better.
      expect(mockRecordEvent).not.toHaveBeenCalled();
      // Current state is unaffected — this only gates history.
      expect(mockRecordDeployment).toHaveBeenCalled();
      expect(await response.json()).toMatchObject({ ok: true });
    });
  });

  describe("tenant scoping of the repository lookup (ISS-4975)", () => {
    it("scopes the repository lookup to the delivery's installation", async () => {
      withTrackedRepoAndBranch();
      mockRecordDeployment.mockResolvedValue(
        Result.ok({ id: "deployment-artifact-1" })
      );
      mockTx.artifactLink.findFirst.mockResolvedValue(null);

      await handleDeploymentStatus(buildDeploymentStatusEvent());

      // github_installation_repositories is unique only by
      // (installation_id, github_repo_id), so an unscoped findFirst can resolve
      // a row belonging to a different installation — and a different org.
      expect(
        mockDb.gitHubInstallationRepository.findFirst
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            installation: expect.objectContaining({
              installationId: "555",
              status: GitHubInstallationStatus.ACTIVE,
            }),
          }),
        })
      );
    });

    it("skips history rather than guessing a tenant when the delivery has no installation id", async () => {
      withTrackedRepoAndBranch();
      mockRecordDeployment.mockResolvedValue(
        Result.ok({ id: "deployment-artifact-1" })
      );
      mockTx.artifactLink.findFirst.mockResolvedValue(null);

      const response = await handleDeploymentStatus(
        buildDeploymentStatusEvent({ installation: undefined })
      );

      // Without the installation id the repo row is not tenant scoped, so its
      // organization is a guess — and a history row is immutable.
      expect(mockRecordEvent).not.toHaveBeenCalled();
      // The pre-existing current-state path is unchanged by the missing id.
      expect(mockRecordDeployment).toHaveBeenCalled();
      expect(await response.json()).toMatchObject({ ok: true });
    });
  });

  describe("ref attribution vs the head-SHA guard (ISS-4975)", () => {
    function withBranchHeadAdvancedPast(deploymentSha: string) {
      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-1",
        installation: { organizationId: "org-1" },
      });
      mockDb.branchDetail.findFirst.mockResolvedValue({
        artifactId: "branch-artifact-1",
        branchName: "feature-branch",
        // A push landed after this deployment started.
        headSha: `${deploymentSha}-superseded`,
        artifact: { organizationId: "org-1", projectId: "project-1" },
      });
    }

    it("resolves the branch by ref alone, so the history query carries no SHA predicate", async () => {
      withTrackedRepoAndBranch();
      mockRecordDeployment.mockResolvedValue(
        Result.ok({ id: "deployment-artifact-1" })
      );
      mockTx.artifactLink.findFirst.mockResolvedValue(null);

      await handleDeploymentStatus(buildDeploymentStatusEvent());

      expect(mockDb.branchDetail.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { repositoryId: "repo-1", branchName: "feature-branch" },
          take: 2,
        })
      );
    });

    it("still attributes history to the branch when the head has moved past the deployment SHA", async () => {
      withBranchHeadAdvancedPast("abc123");

      const response = await handleDeploymentStatus(
        buildDeploymentStatusEvent()
      );

      // The row is immutable — losing project/branch attribution here could
      // never be repaired, so a late status must keep it.
      expect(mockRecordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          branchArtifactId: "branch-artifact-1",
          projectId: "project-1",
          organizationId: "org-1",
        })
      );
      // But current state is mutable, so the stale SHA must NOT overwrite it.
      expect(mockRecordDeployment).not.toHaveBeenCalled();
      expect(await response.json()).toMatchObject({ ok: true });
    });

    it("still writes current state when the branch head has not moved", async () => {
      withTrackedRepoAndBranch();
      mockRecordDeployment.mockResolvedValue(
        Result.ok({ id: "deployment-artifact-1" })
      );
      mockTx.artifactLink.findFirst.mockResolvedValue(null);

      await handleDeploymentStatus(buildDeploymentStatusEvent());

      expect(mockRecordDeployment).toHaveBeenCalledWith(
        expect.objectContaining({ branchArtifactId: "branch-artifact-1" })
      );
    });

    it("writes current state for a branch whose head SHA is not yet known", async () => {
      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-1",
        installation: { organizationId: "org-1" },
      });
      mockDb.branchDetail.findFirst.mockResolvedValue({
        artifactId: "branch-artifact-1",
        branchName: "feature-branch",
        headSha: null,
        artifact: { organizationId: "org-1", projectId: "project-1" },
      });
      mockRecordDeployment.mockResolvedValue(
        Result.ok({ id: "deployment-artifact-1" })
      );
      mockTx.artifactLink.findFirst.mockResolvedValue(null);

      await handleDeploymentStatus(buildDeploymentStatusEvent());

      // Preserves the pre-ISS-4975 `OR: [{ headSha: sha }, { headSha: null }]`
      // semantics the query used to express.
      expect(mockRecordDeployment).toHaveBeenCalled();
    });
  });
});
