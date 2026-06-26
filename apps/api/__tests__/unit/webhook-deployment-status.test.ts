import { LinkType } from "@repo/api/src/types/artifact";
import { Result } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => {
  const mockWithDb: any = vi.fn();
  mockWithDb.tx = vi.fn();
  return { withDb: mockWithDb };
});

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/app/deployments/deployment-service", () => ({
  deploymentService: {
    recordDeployment: vi.fn(),
  },
}));

import { withDb } from "@repo/database";
import { deploymentService } from "@/app/deployments/deployment-service";
import { handleDeploymentStatus } from "@/app/webhooks/github/handlers/deployment-status-handler";

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn> & {
  tx: ReturnType<typeof vi.fn>;
};
const mockRecordDeployment = deploymentService.recordDeployment as ReturnType<
  typeof vi.fn
>;

function buildDeploymentStatusEvent() {
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
  });

  it("does not create a deployment when no branch artifact exists", async () => {
    mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
      id: "repo-1",
    });
    mockDb.branchDetail.findFirst.mockResolvedValue(null);

    const response = await handleDeploymentStatus(buildDeploymentStatusEvent());

    expect(mockRecordDeployment).not.toHaveBeenCalled();
    expect(mockWithDb.tx).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it("records deployment against branchArtifactId and links branch to deployment", async () => {
    mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
      id: "repo-1",
    });
    mockDb.branchDetail.findFirst.mockResolvedValue({
      artifactId: "branch-artifact-1",
      branchName: "feature-branch",
      artifact: {
        organizationId: "org-1",
        projectId: "project-1",
      },
    });
    mockRecordDeployment.mockResolvedValue(
      Result.ok({ id: "deployment-artifact-1" })
    );
    mockTx.artifactLink.findFirst.mockResolvedValue(null);

    const response = await handleDeploymentStatus(buildDeploymentStatusEvent());

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
    });
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it("records deployment scoped to the branch project", async () => {
    mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
      id: "repo-1",
    });
    mockDb.branchDetail.findFirst.mockResolvedValue({
      artifactId: "branch-artifact-1",
      branchName: "feature-branch",
      artifact: {
        organizationId: "org-1",
        projectId: "project-1",
      },
    });
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
    });
    expect(await response.json()).toMatchObject({ ok: true });
  });
});
