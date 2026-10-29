import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectionFindFirst: vi.fn(),
  findCoveringInstallation: vi.fn(),
  withDb: vi.fn(),
}));

vi.mock("@repo/database", () => ({ withDb: mocks.withDb }));

vi.mock("@/lib/github/installation-repository-lookup", () => ({
  findCoveringInstallation: mocks.findCoveringInstallation,
}));

import { gitHubSyncPoolIsEmpty } from "@/lib/github/github-sync-credential-probe";

const INPUT = {
  organizationId: "org-1",
  target: { owner: "Dev", repo: "Local-Repo" },
};

describe("gitHubSyncPoolIsEmpty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withDb.mockImplementation((callback) =>
      callback({
        gitHubUserConnection: { findFirst: mocks.connectionFindFirst },
      })
    );
    mocks.findCoveringInstallation.mockResolvedValue(null);
    mocks.connectionFindFirst.mockResolvedValue(null);
  });

  it("is empty with no covering installation and no org connection", async () => {
    await expect(gitHubSyncPoolIsEmpty(INPUT)).resolves.toBe(true);
    expect(mocks.findCoveringInstallation).toHaveBeenCalledWith(
      "org-1",
      "Dev/Local-Repo"
    );
    expect(mocks.connectionFindFirst).toHaveBeenCalledWith({
      where: { organizationId: "org-1" },
      select: { id: true },
    });
  });

  it("is not empty when an installation covers the repository, without reading the pool", async () => {
    mocks.findCoveringInstallation.mockResolvedValue({
      installationId: "install-1",
    });

    await expect(gitHubSyncPoolIsEmpty(INPUT)).resolves.toBe(false);
    expect(mocks.connectionFindFirst).not.toHaveBeenCalled();
  });

  it("is not empty when the org has a pool connection", async () => {
    mocks.connectionFindFirst.mockResolvedValue({ id: "connection-1" });

    await expect(gitHubSyncPoolIsEmpty(INPUT)).resolves.toBe(false);
  });
});
