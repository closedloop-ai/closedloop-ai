import { type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

vi.mock("@repo/github", () => ({
  getLatestDeploymentStatusForRef: vi.fn(),
}));

vi.mock("@/app/integrations/github/service", () => ({
  githubService: {
    findInstallationForRepoFullName: vi.fn(),
  },
}));

import { withDb } from "@repo/database";
import { getLatestDeploymentStatusForRef } from "@repo/github";
import { artifactsService } from "@/app/artifacts/service";
import { githubService } from "@/app/integrations/github/service";

const mockWithDb = withDb as unknown as Mock;
const mockGetLatestDeploymentStatusForRef =
  getLatestDeploymentStatusForRef as unknown as Mock;
const mockFindInstallationForRepoFullName =
  githubService.findInstallationForRepoFullName as unknown as Mock;

const BASE_ARTIFACT = {
  id: "artifact-1",
  organizationId: "org-1",
  targetRepo: "acme/repo",
  previewDeployment: {
    ref: "refs/heads/feature-branch",
  },
};

describe("artifactsService.refreshPreviewDeployment", () => {
  beforeEach(() => {
    mockWithDb.mockReset();
    mockGetLatestDeploymentStatusForRef.mockReset();
    mockFindInstallationForRepoFullName.mockReset();
  });

  it("uses installationId and preview environment when refreshing", async () => {
    mockFindInstallationForRepoFullName.mockResolvedValue(123);
    mockGetLatestDeploymentStatusForRef.mockResolvedValue({
      url: "https://preview.example.com",
      state: "ready",
      environment: "preview",
      updatedAt: "2026-02-05T00:00:00Z",
    });

    mockWithDb
      .mockImplementationOnce((callback: any) =>
        callback({
          artifact: {
            findUnique: vi.fn().mockResolvedValue(BASE_ARTIFACT),
          },
        })
      )
      .mockImplementationOnce((callback: any) =>
        callback({
          previewDeployment: {
            update: vi.fn().mockResolvedValue({
              url: "https://preview.example.com",
              status: "ready",
              environment: "preview",
              ref: "refs/heads/feature-branch",
              sha: null,
              updatedAt: new Date("2026-02-05T00:00:00Z"),
            }),
          },
        })
      );

    const result = await artifactsService.refreshPreviewDeployment(
      "artifact-1",
      "org-1"
    );

    expect(mockFindInstallationForRepoFullName).toHaveBeenCalledWith(
      "org-1",
      "acme/repo"
    );
    expect(mockGetLatestDeploymentStatusForRef).toHaveBeenCalledWith(
      "acme/repo",
      "refs/heads/feature-branch",
      {
        installationId: 123,
        environment: "preview",
      }
    );
    expect(result).toEqual({
      url: "https://preview.example.com",
      state: "ready",
      environment: "preview",
      ref: "refs/heads/feature-branch",
      sha: null,
      updatedAt: new Date("2026-02-05T00:00:00Z"),
    });
  });
});
