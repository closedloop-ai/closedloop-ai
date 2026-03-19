import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const listDeployments = vi.fn();
const listDeploymentStatuses = vi.fn();
const getRepoInstallation = vi.fn().mockResolvedValue({ data: { id: 999 } });

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    repos = {
      listDeployments,
      listDeploymentStatuses,
    };
    apps = {
      getRepoInstallation,
    };
  },
}));

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: vi.fn(() => async (_opts: unknown) => ({ token: "test" })),
}));

import { getLatestDeploymentStatusForRef } from "../index";

describe("getLatestDeploymentStatusForRef", () => {
  beforeAll(() => {
    process.env.GITHUB_APP_ID = "1";
    process.env.GITHUB_APP_PRIVATE_KEY = "test";
    process.env.GITHUB_APP_WEBHOOK_SECRET = "test";
    process.env.GITHUB_APP_CLIENT_ID = "test";
    process.env.GITHUB_APP_CLIENT_SECRET = "test";
    process.env.GITHUB_APP_DISPATCH_REPO = "owner/dispatch";
    process.env.WEBAPP_ENV = "stage";
  });

  beforeEach(() => {
    listDeployments.mockReset();
    listDeploymentStatuses.mockReset();
    getRepoInstallation.mockClear();
  });

  it("returns latest status for preview deployments with env filter", async () => {
    listDeployments.mockResolvedValue({
      data: [
        {
          id: 123,
          environment: "preview",
          updated_at: "2026-02-05T00:00:00Z",
        },
      ],
    });
    listDeploymentStatuses.mockResolvedValue({
      data: [
        {
          state: "success",
          environment_url: "https://preview.example.com",
          target_url: null,
          updated_at: "2026-02-05T00:05:00Z",
        },
      ],
    });

    const result = await getLatestDeploymentStatusForRef("acme/repo", "ref", {
      installationId: 42,
      environment: "preview",
    });

    expect(listDeployments).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "acme",
        repo: "repo",
        ref: "ref",
        environment: "preview",
      })
    );
    expect(result).toEqual({
      url: "https://preview.example.com",
      state: "success",
      environment: "preview",
      updatedAt: "2026-02-05T00:05:00Z",
    });
  });

  it("returns pending when deployment exists but no statuses", async () => {
    listDeployments.mockResolvedValue({
      data: [
        {
          id: 999,
          environment: "preview",
          updated_at: "2026-02-05T00:00:00Z",
        },
      ],
    });
    listDeploymentStatuses.mockResolvedValue({ data: [] });

    const result = await getLatestDeploymentStatusForRef("acme/repo", "ref", {
      installationId: 42,
      environment: "preview",
    });

    expect(result).toEqual({
      url: null,
      state: "pending",
      environment: "preview",
      updatedAt: "2026-02-05T00:00:00Z",
    });
  });
});
