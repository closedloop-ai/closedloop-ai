import {
  GitHubAccessDenialReason,
  GitHubCredentialKind,
} from "@repo/api/src/types/github";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetGitHubClient, mockGetInstallationOctokit } = vi.hoisted(() => ({
  mockGetGitHubClient: vi.fn(),
  mockGetInstallationOctokit: vi.fn(),
}));

vi.mock("@/lib/github/github-client-resolver", () => ({
  getGitHubClient: mockGetGitHubClient,
}));

// Still mocked so the assertions below can prove it is never reached: the
// installation fallback was removed, not merely bypassed (PRD-562 strictness).
vi.mock("@repo/github/installation-auth", () => ({
  getInstallationOctokit: mockGetInstallationOctokit,
}));

import { GitHubAccessIntent } from "@/lib/github/github-access";
import {
  resolveBranchViewReadClient,
  runBranchViewRead,
} from "@/lib/github/github-branch-view-read-client";

const INPUT = {
  organizationId: "org-1",
  userId: "user-1",
  target: { owner: "Acme", repo: "Widgets" },
};

const USER_OCTOKIT = { marker: "user-octokit" };

function resolverReturnsUserClient() {
  mockGetGitHubClient.mockResolvedValue({
    ok: true,
    value: {
      octokit: USER_OCTOKIT,
      kind: GitHubCredentialKind.GithubAppUser,
      actingAs: { githubUserId: "9001", login: "octocat" },
      rateLimitTier: 15_000,
    },
  });
}

function resolverDenies(reason: GitHubAccessDenialReason) {
  mockGetGitHubClient.mockResolvedValue({ ok: false, error: { reason } });
}

describe("resolveBranchViewReadClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the resolver's user-lane client when resolution succeeds", async () => {
    resolverReturnsUserClient();

    const client = await resolveBranchViewReadClient(INPUT);

    expect(mockGetGitHubClient).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      target: { owner: "Acme", repo: "Widgets" },
      intent: GitHubAccessIntent.ReadAsUser,
    });
    expect(client).toEqual({
      ok: true,
      value: {
        octokit: USER_OCTOKIT,
        kind: GitHubCredentialKind.GithubAppUser,
      },
    });
  });

  it.each([
    GitHubAccessDenialReason.NotConnected,
    GitHubAccessDenialReason.Revoked,
    GitHubAccessDenialReason.NoInstallation,
    GitHubAccessDenialReason.InsufficientScope,
  ])("surfaces a %s denial instead of reading through the installation credential", async (reason) => {
    resolverDenies(reason);

    const client = await resolveBranchViewReadClient(INPUT);

    expect(client).toEqual({ ok: false, error: { reason } });
    // The core of the strictness change: an org member the resolver denied
    // must not be served by a credential that can see repositories their own
    // GitHub account cannot.
    expect(mockGetInstallationOctokit).not.toHaveBeenCalled();
  });
});

describe("runBranchViewRead", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolverReturnsUserClient();
  });

  it("returns the user-lane result", async () => {
    const read = vi.fn().mockResolvedValue("diff-contents");

    const result = await runBranchViewRead(INPUT, read);

    expect(result).toEqual({ ok: true, value: "diff-contents" });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(USER_OCTOKIT);
    expect(mockGetInstallationOctokit).not.toHaveBeenCalled();
  });

  it("does not run the read at all when resolution is denied", async () => {
    resolverDenies(GitHubAccessDenialReason.NotConnected);
    const read = vi.fn();

    const result = await runBranchViewRead(INPUT, read);

    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.NotConnected },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("returns a revoked denial when the read throws 401, without retrying", async () => {
    const read = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("Bad credentials"), { status: 401 })
      );

    const result = await runBranchViewRead(INPUT, read);

    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.Revoked },
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(mockGetInstallationOctokit).not.toHaveBeenCalled();
  });

  it("returns a no_installation denial when the read throws 404", async () => {
    const read = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("Not Found"), { status: 404 })
      );

    const result = await runBranchViewRead(INPUT, read);

    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.NoInstallation },
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("classifies an unexpected upstream failure as unavailable rather than throwing", async () => {
    // The route's contract is a typed denial; a 5xx must not escape as an
    // uncaught throw and become a generic 500.
    const read = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("Server error"), { status: 502 })
      );

    const result = await runBranchViewRead(INPUT, read);

    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.Unavailable },
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("turns a caller-flagged cloaked result into a denial instead of returning it", async () => {
    // GitHub answers 404 (not 403) for a private repo the credential cannot
    // see, so a lost-access read looks like an ordinary empty result. Returning
    // it would render an empty diff and quietly lie about the file.
    const read = vi.fn().mockResolvedValue("cloaked-contents");

    const result = await runBranchViewRead(
      INPUT,
      read,
      (contents) => contents === "cloaked-contents"
    );

    expect(result).toEqual({
      ok: false,
      error: { reason: GitHubAccessDenialReason.NoInstallation },
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(mockGetInstallationOctokit).not.toHaveBeenCalled();
  });

  it("returns a plausible result untouched when looksCloaked says no", async () => {
    const read = vi.fn().mockResolvedValue("real-contents");

    const result = await runBranchViewRead(INPUT, read, () => false);

    expect(result).toEqual({ ok: true, value: "real-contents" });
  });
});
