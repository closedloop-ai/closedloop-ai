import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  GitHubInstallationStatus: {
    ACTIVE: "ACTIVE",
  },
}));

import {
  GitHubCommentOwnerFailureReason,
  resolveGitHubCommentOwner,
} from "./comment-owner-resolver";

const ACTIVE_INSTALLATION = {
  id: "installation-record-1",
  organizationId: "org-1",
  status: "ACTIVE",
};

const REPOSITORY = { id: "repository-record-1" };

const PULL_REQUEST_DETAIL = {
  id: "pull-request-detail-1",
  branchArtifactId: "branch-artifact-1",
  branchArtifact: { organizationId: "org-1" },
};

let tx: {
  gitHubInstallation: { findMany: ReturnType<typeof vi.fn> };
  gitHubInstallationRepository: { findMany: ReturnType<typeof vi.fn> };
  pullRequestDetail: { findMany: ReturnType<typeof vi.fn> };
};
let onResolved: ReturnType<typeof vi.fn>;

describe("resolveGitHubCommentOwner", () => {
  beforeEach(() => {
    tx = {
      gitHubInstallation: { findMany: vi.fn() },
      gitHubInstallationRepository: { findMany: vi.fn() },
      pullRequestDetail: { findMany: vi.fn() },
    };
    onResolved = vi.fn();
  });

  it("returns unmatched_installation and does not invoke the callback", async () => {
    tx.gitHubInstallation.findMany.mockResolvedValue([]);

    await expect(resolve(onResolved)).resolves.toEqual({
      ok: false,
      code: GitHubCommentOwnerFailureReason.UnmatchedInstallation,
    });
    expect(onResolved).not.toHaveBeenCalled();
    expect(tx.gitHubInstallationRepository.findMany).not.toHaveBeenCalled();
  });

  it("returns inactive_installation and does not invoke the callback", async () => {
    tx.gitHubInstallation.findMany.mockResolvedValue([
      { ...ACTIVE_INSTALLATION, status: "SUSPENDED" },
    ]);

    await expect(resolve(onResolved)).resolves.toEqual({
      ok: false,
      code: GitHubCommentOwnerFailureReason.InactiveInstallation,
    });
    expect(onResolved).not.toHaveBeenCalled();
    expect(tx.gitHubInstallationRepository.findMany).not.toHaveBeenCalled();
  });

  it("returns missing_repository when the repo id is not under the webhook installation", async () => {
    tx.gitHubInstallation.findMany.mockResolvedValue([ACTIVE_INSTALLATION]);
    tx.gitHubInstallationRepository.findMany.mockResolvedValue([]);

    await expect(resolve(onResolved)).resolves.toEqual({
      ok: false,
      code: GitHubCommentOwnerFailureReason.MissingRepository,
    });
    expect(tx.gitHubInstallationRepository.findMany).toHaveBeenCalledWith({
      where: {
        installationId: "installation-record-1",
        githubRepoId: "789",
      },
      select: { id: true },
      take: 2,
    });
    expect(onResolved).not.toHaveBeenCalled();
    expect(tx.pullRequestDetail.findMany).not.toHaveBeenCalled();
  });

  it("does not match duplicate repo ids across other installations or orgs", async () => {
    tx.gitHubInstallation.findMany.mockResolvedValue([ACTIVE_INSTALLATION]);
    tx.gitHubInstallationRepository.findMany.mockResolvedValue([]);

    await resolve(onResolved);

    expect(tx.gitHubInstallationRepository.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          installationId: "installation-record-1",
          githubRepoId: "789",
        },
      })
    );
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("returns missing_pull_request_detail and does not invoke the callback", async () => {
    tx.gitHubInstallation.findMany.mockResolvedValue([ACTIVE_INSTALLATION]);
    tx.gitHubInstallationRepository.findMany.mockResolvedValue([REPOSITORY]);
    tx.pullRequestDetail.findMany.mockResolvedValue([]);

    await expect(resolve(onResolved)).resolves.toEqual({
      ok: false,
      code: GitHubCommentOwnerFailureReason.MissingPullRequestDetail,
    });
    expect(tx.pullRequestDetail.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { repositoryId: "repository-record-1", number: 42 },
      })
    );
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("returns ambiguous_owner and does not invoke the callback", async () => {
    tx.gitHubInstallation.findMany.mockResolvedValue([ACTIVE_INSTALLATION]);
    tx.gitHubInstallationRepository.findMany.mockResolvedValue([REPOSITORY]);
    tx.pullRequestDetail.findMany.mockResolvedValue([
      {
        ...PULL_REQUEST_DETAIL,
        branchArtifact: { organizationId: "other-org" },
      },
    ]);

    await expect(resolve(onResolved)).resolves.toEqual({
      ok: false,
      code: GitHubCommentOwnerFailureReason.AmbiguousOwner,
    });
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("returns ambiguous_owner when the optional organization guard does not match", async () => {
    tx.gitHubInstallation.findMany.mockResolvedValue([ACTIVE_INSTALLATION]);

    await expect(
      resolve(onResolved, { organizationId: "other-org" })
    ).resolves.toEqual({
      ok: false,
      code: GitHubCommentOwnerFailureReason.AmbiguousOwner,
    });
    expect(onResolved).not.toHaveBeenCalled();
    expect(tx.gitHubInstallationRepository.findMany).not.toHaveBeenCalled();
  });

  it("returns owner ids and invokes the callback on success", async () => {
    tx.gitHubInstallation.findMany.mockResolvedValue([ACTIVE_INSTALLATION]);
    tx.gitHubInstallationRepository.findMany.mockResolvedValue([REPOSITORY]);
    tx.pullRequestDetail.findMany.mockResolvedValue([PULL_REQUEST_DETAIL]);

    await expect(resolve(onResolved)).resolves.toEqual({
      ok: true,
      organizationId: "org-1",
      installationRecordId: "installation-record-1",
      repositoryRecordId: "repository-record-1",
      branchArtifactId: "branch-artifact-1",
      pullRequestDetailId: "pull-request-detail-1",
    });
    expect(onResolved).toHaveBeenCalledWith({
      ok: true,
      organizationId: "org-1",
      installationRecordId: "installation-record-1",
      repositoryRecordId: "repository-record-1",
      branchArtifactId: "branch-artifact-1",
      pullRequestDetailId: "pull-request-detail-1",
    });
  });
});

function resolve(
  onResolved?: ReturnType<typeof vi.fn>,
  overrides: Partial<Parameters<typeof resolveGitHubCommentOwner>[1]> = {}
) {
  return resolveGitHubCommentOwner(
    tx as unknown as Parameters<typeof resolveGitHubCommentOwner>[0],
    { installationId: 99, repositoryId: 789, pullNumber: 42, ...overrides },
    onResolved as Parameters<typeof resolveGitHubCommentOwner>[2]
  );
}
