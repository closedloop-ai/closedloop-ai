import type {
  Deployment,
  DeploymentStatusEvent,
  InstallationLite,
} from "@octokit/webhooks-types";
import { LinkType } from "@repo/api/src/types/artifact";
import { Result } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockWithDb, nextHeaders } = vi.hoisted(() => ({
  mockWithDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  nextHeaders: vi.fn(),
}));

// The real enums: the old-payload-shape and unknown-state cases go through the
// route, whose import graph reaches every handler's enums.
vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withDb: mockWithDb,
}));

vi.mock("next/headers", () => ({ headers: nextHeaders }));

vi.mock("@repo/observability/log", () => ({
  log: {
    debug: vi.fn(),
    flush: vi.fn(async () => undefined),
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

vi.mock("@/app/webhooks/github/handlers/branch-activity-producer", () => ({
  GitHubBranchActivityEventName: { DeploymentStatus: "deployment_status" },
  persistGitHubBranchActivity: vi.fn().mockResolvedValue({
    status: "persisted",
    persistenceStatus: "inserted",
  }),
}));

import { GitHubInstallationStatus } from "@repo/database";
import {
  createInstallationLite,
  createRepository,
  createUser,
} from "@/__tests__/fixtures/github-webhook-fixtures";
import { deliverGitHubWebhook } from "@/__tests__/support/webhooks/github/github-webhook-route-delivery.test-helpers";
import { deploymentService } from "@/app/deployments/deployment-service";
import {
  GitHubBranchActivityEventName,
  persistGitHubBranchActivity,
} from "@/app/webhooks/github/handlers/branch-activity-producer";
import { handleDeploymentStatus } from "@/app/webhooks/github/handlers/deployment-status-handler";

const mockRecordDeployment = deploymentService.recordDeployment as ReturnType<
  typeof vi.fn
>;
const mockPersistGitHubBranchActivity =
  persistGitHubBranchActivity as ReturnType<typeof vi.fn>;

type DeploymentStatusOverrides = {
  deployment?: Partial<Deployment>;
  deploymentStatus?: Partial<DeploymentStatusEvent["deployment_status"]>;
  /** `null` sends the delivery without an `installation` block. */
  installation?: InstallationLite | null;
};

function buildDeploymentStatusEvent(
  overrides: DeploymentStatusOverrides = {}
): DeploymentStatusEvent {
  const repository = createRepository(123, {
    full_name: "org/repo",
    owner: createUser({ login: "org", id: 4321, type: "Organization" }),
  });
  const creator = createUser({
    login: "vercel[bot]",
    id: 35_613_825,
    type: "Bot",
  });
  const deployment: Deployment = {
    url: `${repository.url}/deployments/4242`,
    id: 4242,
    node_id: "DE_4242",
    sha: "abc123",
    ref: "feature-branch",
    task: "deploy",
    payload: {},
    original_environment: "Preview",
    environment: "Preview",
    transient_environment: true,
    production_environment: false,
    description: null,
    creator,
    created_at: "2026-08-03T11:58:00.000Z",
    updated_at: "2026-08-03T11:58:00.000Z",
    statuses_url: `${repository.url}/deployments/4242/statuses`,
    repository_url: repository.url,
    performed_via_github_app: null,
    ...overrides.deployment,
  };
  const installation =
    overrides.installation === undefined
      ? createInstallationLite(555)
      : overrides.installation;
  return {
    action: "created",
    deployment,
    deployment_status: {
      url: "https://api.github.com/status",
      id: 99_001,
      node_id: "DES_99001",
      state: "success",
      creator,
      description: "Deployment has completed",
      environment: deployment.environment,
      environment_url: "https://preview.example.com",
      target_url: "https://vercel.com/org/repo/deployments/4242",
      created_at: "2026-08-03T11:59:00.000Z",
      updated_at: "2026-08-03T11:59:00.000Z",
      deployment_url: "https://api.github.com/deployment",
      repository_url: repository.url,
      performed_via_github_app: null,
      ...overrides.deploymentStatus,
    },
    repository,
    sender: creator,
    ...(installation ? { installation } : {}),
  };
}

/**
 * The pre-ISS-4975 fixture shape: no provider ids, no timestamps. Old deliveries
 * (and any provider that omits them) must still drive the current-state path.
 * The Octokit type requires those fields, so this shape is sent through the
 * route's raw body rather than typed.
 */
function buildLegacyDeploymentStatusPayload() {
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
  };
}

describe("handleDeploymentStatus", () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let mockTx: ReturnType<typeof createMockTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    mockTx = createMockTx();
    mockWithDb.mockImplementation((callback: (db: typeof mockDb) => unknown) =>
      callback(mockDb)
    );
    mockWithDb.tx.mockImplementation(
      (callback: (tx: typeof mockTx) => unknown) => callback(mockTx)
    );
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
        sortOrder: 0,
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
        sortOrder: 0,
      },
      select: { id: true },
    });
    expect(await response.json()).toMatchObject({ ok: true });
  });

  describe("deployment_events writes (ISS-12780)", () => {
    it("writes no deployment_events row for a success or a failure transition", async () => {
      withTrackedRepoAndBranch();
      mockRecordDeployment.mockResolvedValue(
        Result.ok({ id: "deployment-artifact-1" })
      );
      mockTx.artifactLink.findFirst.mockResolvedValue(null);

      await handleDeploymentStatus(buildDeploymentStatusEvent());
      await handleDeploymentStatus(
        buildDeploymentStatusEvent({
          deploymentStatus: {
            id: 99_002,
            state: "failure",
            environment_url: undefined,
          },
        })
      );

      expect(mockDb.deploymentEvent.createMany).not.toHaveBeenCalled();
      // Current state still records the success, and only the success.
      expect(mockRecordDeployment).toHaveBeenCalledTimes(1);
    });

    it("does not write current state for a failure transition", async () => {
      withTrackedRepoAndBranch();

      const response = await handleDeploymentStatus(
        buildDeploymentStatusEvent({
          deploymentStatus: {
            id: 99_002,
            state: "failure",
            url: "https://api.github.com/status",
            // A failed deployment reports no environment URL.
            environment_url: undefined,
            created_at: "2026-08-03T11:59:30.000Z",
          },
        })
      );

      expect(mockRecordDeployment).not.toHaveBeenCalled();
      expect(await response.json()).toMatchObject({ ok: true });
    });

    it("accepts an unknown provider state without writing current state", async () => {
      withTrackedRepoAndBranch();

      // A state outside the Octokit union, so it arrives through the route's
      // raw body.
      const event = buildDeploymentStatusEvent({
        deploymentStatus: {
          id: 99_003,
          created_at: "2026-08-03T11:59:00.000Z",
        },
      });
      const response = await deliverGitHubWebhook(nextHeaders, {
        eventType: "deployment_status",
        payload: {
          ...event,
          deployment_status: {
            ...event.deployment_status,
            state: "quantum_rollout",
          },
        },
      });

      expect(mockRecordDeployment).not.toHaveBeenCalled();
      expect(await response.json()).toMatchObject({ ok: true });
    });

    it("still updates current state for an old payload shape", async () => {
      withTrackedRepoAndBranch();
      mockRecordDeployment.mockResolvedValue(
        Result.ok({ id: "deployment-artifact-1" })
      );
      mockTx.artifactLink.findFirst.mockResolvedValue(null);

      const response = await deliverGitHubWebhook(nextHeaders, {
        eventType: "deployment_status",
        payload: buildLegacyDeploymentStatusPayload(),
      });

      expect(mockRecordDeployment).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: "org-1",
          branchArtifactId: "branch-artifact-1",
        })
      );
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

    it("still writes current state when the delivery has no installation id", async () => {
      withTrackedRepoAndBranch();
      mockRecordDeployment.mockResolvedValue(
        Result.ok({ id: "deployment-artifact-1" })
      );
      mockTx.artifactLink.findFirst.mockResolvedValue(null);

      const response = await handleDeploymentStatus(
        buildDeploymentStatusEvent({ installation: null })
      );

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

    it("resolves the branch by ref alone, with no SHA predicate", async () => {
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

    it("still attributes branch activity when the head has moved past the deployment SHA", async () => {
      withBranchHeadAdvancedPast("abc123");

      const event = buildDeploymentStatusEvent();
      const response = await handleDeploymentStatus(event, {
        deliveryId: "deployment-head-moved",
        observedAt: new Date("2026-08-12T14:00:00.000Z"),
      });

      expect(mockPersistGitHubBranchActivity).toHaveBeenCalledWith({
        eventName: GitHubBranchActivityEventName.DeploymentStatus,
        deliveryId: "deployment-head-moved",
        payload: event,
        attribution: {
          organizationId: "org-1",
          branchArtifactId: "branch-artifact-1",
        },
      });
      // Current state is mutable, so the stale SHA must NOT overwrite it.
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

function createMockDb() {
  return {
    gitHubInstallationRepository: {
      findFirst: vi.fn(),
    },
    branchDetail: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    deploymentEvent: {
      createMany: vi.fn(),
    },
  };
}

function createMockTx() {
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    artifact: {
      findFirst: vi.fn().mockResolvedValue({ projectId: "project-1" }),
    },
    artifactLink: {
      findFirst: vi.fn(),
      aggregate: vi.fn().mockResolvedValue({ _max: { sortOrder: null } }),
      create: vi.fn(),
    },
  };
}
