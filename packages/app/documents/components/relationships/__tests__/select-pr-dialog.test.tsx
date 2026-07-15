import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import {
  GitHubPRState,
  type GitHubPullRequestSummary,
} from "@repo/api/src/types/github";
import { RepoSource } from "@repo/app/loops/hooks/use-resolved-job-repos";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectPullRequestDialog } from "../select-pr-dialog";

function renderWithQueryClient(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}

const mockUseProject = vi.fn();
const mockUseResolvedArtifactLinks = vi.fn();
const mockUseDocument = vi.fn();
const mockGet = vi.fn();
const mockPost = vi.fn();
const mockCreateArtifactLink = vi.fn();
const mockToastSuccess = vi.fn();
const CURRENT_SOURCE_LINKED_PR_REGEX = /already linked on this source/i;
const DIFFERENT_SOURCE_LINKED_PR_REGEX = /linked somewhere else/i;
const EXISTING_PR_LINKS_REGEX = /checking existing pr links/i;
const PR_TITLE_REGEX = /fix direct feature pr linking/i;
const PARTIAL_FAILURE_WARNING_REGEX = /Could not load PRs from/i;
const BOUNDED_READ_WARNING_REGEX = /older pull requests may be omitted/i;
const ALL_REPOS_FAIL_ERROR_REGEX =
  /Failed to load pull requests from all repositories/i;
const SEARCH_PR_PLACEHOLDER_REGEX = /search pull requests/i;
const MULTI_REPO_PR_A_REGEX = /PR A from repo-1 untracked/i;
const MULTI_REPO_PR_B_REGEX = /PR B tracked by repo-2/i;
const MULTI_REPO_PR_C_REGEX = /PR C from repo-1 tracked by repo-2/i;
const LINKED_BADGE_REGEX = /^Linked$/i;
const BRANCH_TRACKED_PR_REGEX = /tracked by branch key/i;
const BRANCH_UNTRACKED_PR_REGEX = /visible untracked branch/i;

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock("@repo/api/src/types/project", async () => {
  const actual = await vi.importActual("@repo/api/src/types/project");
  return {
    ...actual,
    getProjectSettings: () => ({}),
  };
});

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
  },
}));

vi.mock("@repo/app/projects/hooks/use-projects", async () => {
  const actual = await vi.importActual("@repo/app/projects/hooks/use-projects");
  return {
    ...actual,
    useProject: (...args: unknown[]) => mockUseProject(...args),
  };
});

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  }),
}));

vi.mock("@repo/app/documents/hooks/use-documents", async () => {
  const actual = await vi.importActual(
    "@repo/app/documents/hooks/use-documents"
  );
  return {
    ...actual,
    useDocument: (...args: unknown[]) => mockUseDocument(...args),
  };
});

vi.mock("@repo/app/documents/hooks/use-artifact-links", async () => {
  const actual = await vi.importActual(
    "@repo/app/documents/hooks/use-artifact-links"
  );
  return {
    ...actual,
    useCreateArtifactLink: () => ({
      mutateAsync: mockCreateArtifactLink,
    }),
    useResolvedArtifactLinks: (...args: unknown[]) =>
      mockUseResolvedArtifactLinks(...args),
  };
});

const mockUseResolvedJobRepos = vi.fn();

// PLN-529: dialog resolves the project's primary via the shared resolver.
// The repoId is the only field this dialog consumes.
vi.mock("@repo/app/loops/hooks/use-resolved-job-repos", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/app/loops/hooks/use-resolved-job-repos")
  >("@repo/app/loops/hooks/use-resolved-job-repos");
  return {
    ...actual,
    useResolvedJobRepos: (...args: unknown[]) =>
      mockUseResolvedJobRepos(...args),
  };
});

function makePullRequest(
  overrides: Partial<GitHubPullRequestSummary> = {}
): GitHubPullRequestSummary {
  return {
    author: "octocat",
    baseBranch: "main",
    githubId: "gh-pr-101",
    headBranch: "feature/direct-link",
    headSha: "head-sha-101",
    htmlUrl: "https://github.com/acme/repo/pull/101",
    isDraft: false,
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
    number: 101,
    state: GitHubPRState.Open,
    title: "Fix direct feature PR linking",
    updatedAt: "2026-04-16T12:00:00.000Z",
    ...overrides,
  };
}

describe("SelectPullRequestDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", MockResizeObserver);

    mockUseProject.mockReturnValue({
      data: { id: "project-1", settings: {} },
    });
    mockGet.mockResolvedValue({
      pullRequests: [makePullRequest()],
      trackedPrUrls: [],
    });
    mockUseResolvedJobRepos.mockReturnValue({
      primary: {
        id: "repo-1",
        fullName: "acme/repo",
        source: RepoSource.TeamDefault,
        inPool: false,
      },
      additional: [],
      pool: [],
      isLoading: false,
    });
    mockUseResolvedArtifactLinks.mockReturnValue({
      data: [],
      isLoading: false,
    });
    mockUseDocument.mockReturnValue({ data: undefined });
    mockPost.mockResolvedValue({ id: "pr-artifact-101" });
    mockCreateArtifactLink.mockResolvedValue({ id: "artifact-link-1" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("links a selected PR directly to the feature without requiring a plan", async () => {
    const user = userEvent.setup();

    renderWithQueryClient(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={vi.fn()}
        open={true}
        projectId="project-1"
      />
    );

    await waitFor(() => screen.getByText(PR_TITLE_REGEX));
    await user.click(screen.getByText(PR_TITLE_REGEX));

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        "/artifact-links/pull-requests",
        expect.objectContaining({
          externalUrl: "https://github.com/acme/repo/pull/101",
          number: 101,
          githubId: "gh-pr-101",
          headBranch: "feature/direct-link",
          headSha: "head-sha-101",
          baseBranch: "main",
          state: GitHubPRState.Open,
          isDraft: false,
          closedAt: null,
          mergedAt: null,
          mergeCommitSha: null,
          projectId: "project-1",
          title: "PR #101: Fix direct feature PR linking",
        })
      );
    });

    expect(mockCreateArtifactLink).toHaveBeenCalledWith({
      linkType: LinkType.Produces,
      sourceId: "feature-1",
      targetId: "pr-artifact-101",
    });
  });

  it("links a selected PR to the plan when a plan exists", async () => {
    const user = userEvent.setup();

    renderWithQueryClient(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={vi.fn()}
        open={true}
        planId="plan-1"
        projectId="project-1"
      />
    );

    await waitFor(() => screen.getByText(PR_TITLE_REGEX));
    await user.click(screen.getByText(PR_TITLE_REGEX));

    await waitFor(() => {
      expect(mockCreateArtifactLink).toHaveBeenCalledWith({
        linkType: LinkType.Produces,
        sourceId: "plan-1",
        targetId: "pr-artifact-101",
      });
    });
  });

  it("hides tracked PRs that are linked elsewhere", async () => {
    const visiblePullRequest = makePullRequest({
      githubId: "gh-pr-102",
      headBranch: "feature/current-link",
      htmlUrl: "https://github.com/acme/repo/pull/102",
      number: 102,
      title: "Already linked on this source",
    });
    const hiddenPullRequest = makePullRequest({
      githubId: "gh-pr-103",
      headBranch: "feature/other-link",
      htmlUrl: "https://github.com/acme/repo/pull/103",
      number: 103,
      title: "Linked somewhere else",
    });

    mockGet.mockResolvedValue({
      pullRequests: [visiblePullRequest, hiddenPullRequest],
      trackedPrUrls: [visiblePullRequest.htmlUrl, hiddenPullRequest.htmlUrl],
    });
    mockUseResolvedArtifactLinks.mockReturnValue({
      data: [
        {
          id: "artifact-link-102",
          sourceId: "feature-1",
          targetId: "pr-artifact-102",
          source: {
            id: "feature-1",
            type: ArtifactType.Document,
            subtype: null,
            name: "Feature",
            slug: "feature-1",
            externalUrl: null,
          },
          target: {
            id: "pr-artifact-102",
            type: ArtifactType.Branch,
            subtype: null,
            name: "PR",
            slug: null,
            externalUrl: visiblePullRequest.htmlUrl,
          },
        },
      ],
      isLoading: false,
    });

    renderWithQueryClient(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={vi.fn()}
        open={true}
        projectId="project-1"
      />
    );

    await waitFor(() => {
      expect(
        screen.getByText(CURRENT_SOURCE_LINKED_PR_REGEX)
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByText(DIFFERENT_SOURCE_LINKED_PR_REGEX)
    ).not.toBeInTheDocument();
  });

  it("recognizes a linked branch artifact by current PR URL when the artifact URL is a branch tree", async () => {
    const user = userEvent.setup();
    const pullRequest = makePullRequest({
      htmlUrl: "https://github.com/acme/repo/pull/104",
      number: 104,
      title: "Already linked on this source",
    });

    mockGet.mockResolvedValue({
      pullRequests: [pullRequest],
      trackedPrUrls: [],
    });
    mockUseResolvedArtifactLinks.mockReturnValue({
      data: [
        {
          id: "artifact-link-104",
          sourceId: "feature-1",
          targetId: "branch-artifact-104",
          source: {
            id: "feature-1",
            type: ArtifactType.Document,
            subtype: null,
            name: "Feature",
            slug: "feature-1",
            externalUrl: null,
          },
          target: {
            id: "branch-artifact-104",
            type: ArtifactType.Branch,
            subtype: null,
            name: "feature/direct-link",
            slug: null,
            externalUrl:
              "https://github.com/acme/repo/tree/feature%2Fdirect-link",
            branch: {
              currentPullRequest: {
                htmlUrl: pullRequest.htmlUrl,
              },
            },
          },
        },
      ],
      isLoading: false,
    });

    renderWithQueryClient(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={vi.fn()}
        open={true}
        projectId="project-1"
      />
    );

    await waitFor(() => {
      expect(
        screen.getByText(CURRENT_SOURCE_LINKED_PR_REGEX)
      ).toBeInTheDocument();
    });
    expect(screen.getByText(LINKED_BADGE_REGEX)).toBeInTheDocument();

    await user.click(screen.getByText(CURRENT_SOURCE_LINKED_PR_REGEX));

    expect(mockPost).not.toHaveBeenCalled();
    expect(mockCreateArtifactLink).not.toHaveBeenCalled();
  });

  it("hides tracked PRs while the source-linked PRs are still loading", async () => {
    const pullRequest = makePullRequest();

    mockGet.mockResolvedValue({
      pullRequests: [pullRequest],
      trackedPrUrls: [pullRequest.htmlUrl],
    });
    mockUseResolvedArtifactLinks.mockReturnValue({
      data: [],
      isLoading: true,
    });

    renderWithQueryClient(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={vi.fn()}
        open={true}
        projectId="project-1"
      />
    );

    await waitFor(() => {
      expect(screen.getByText(EXISTING_PR_LINKS_REGEX)).toBeInTheDocument();
    });
    expect(screen.queryByText(PR_TITLE_REGEX)).not.toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockCreateArtifactLink).not.toHaveBeenCalled();
  });

  it("shows partial-failure warning when some repos fail", async () => {
    const successPr = makePullRequest({
      githubId: "gh-pr-101",
      htmlUrl: "https://github.com/acme/repo/pull/101",
      number: 101,
      title: "Fix direct feature PR linking",
    });

    mockUseResolvedJobRepos.mockReturnValue({
      primary: {
        id: "repo-1",
        fullName: "acme/repo",
        source: RepoSource.TeamDefault,
        inPool: false,
      },
      additional: [
        {
          id: "repo-2",
          fullName: "acme/repo-fork",
          source: RepoSource.ProjectOverride,
          inPool: false,
        },
      ],
      pool: [],
      isLoading: false,
    });
    // repo-1 succeeds, repo-2 fails
    mockGet.mockImplementation((url: string) => {
      if (url.includes("repo-2")) {
        return Promise.reject(new Error("Not found"));
      }
      return Promise.resolve({ pullRequests: [successPr], trackedPrUrls: [] });
    });

    renderWithQueryClient(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={vi.fn()}
        open={true}
        projectId="project-1"
      />
    );

    await waitFor(() => {
      expect(
        screen.getByText(PARTIAL_FAILURE_WARNING_REGEX)
      ).toBeInTheDocument();
    });
    expect(screen.getByText(PR_TITLE_REGEX)).toBeInTheDocument();
  });

  it("shows bounded-read warning when GitHub reports truncated PR results", async () => {
    mockGet.mockResolvedValue({
      pullRequests: [makePullRequest()],
      trackedPrUrls: [],
      truncated: true,
    });

    renderWithQueryClient(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={vi.fn()}
        open={true}
        projectId="project-1"
      />
    );

    await waitFor(() => {
      expect(screen.getByText(BOUNDED_READ_WARNING_REGEX)).toBeInTheDocument();
    });
    expect(screen.getByText(PR_TITLE_REGEX)).toBeInTheDocument();
  });

  it("does not show repo labels when only a single repo is configured", async () => {
    // Default beforeEach setup: primary repo only, additional: [] — backward compat case.
    // The component only renders the repo label Badge when allRepoIds.length > 1.
    renderWithQueryClient(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={vi.fn()}
        open={true}
        projectId="project-1"
      />
    );

    await waitFor(() => {
      expect(screen.getByText(PR_TITLE_REGEX)).toBeInTheDocument();
    });

    // Repo label badge (fullName "acme/repo") must not appear in single-repo mode.
    expect(screen.queryByText("acme/repo")).not.toBeInTheDocument();

    // Partial-failure warning must not appear.
    expect(
      screen.queryByText(PARTIAL_FAILURE_WARNING_REGEX)
    ).not.toBeInTheDocument();

    // All-repos-fail error must not appear.
    expect(
      screen.queryByText(ALL_REPOS_FAIL_ERROR_REGEX)
    ).not.toBeInTheDocument();
  });

  it("hides PRs tracked across multiple repos", async () => {
    // PR-A: from repo-1, not tracked by either repo — should be visible
    const prA = makePullRequest({
      githubId: "gh-pr-201",
      headBranch: "feature/pr-a",
      htmlUrl: "https://github.com/acme/repo/pull/201",
      number: 201,
      title: "PR A from repo-1 untracked",
    });
    // PR-B: from repo-2, tracked by repo-2's trackedPrUrls — should be hidden
    const prB = makePullRequest({
      githubId: "gh-pr-202",
      headBranch: "feature/pr-b",
      htmlUrl: "https://github.com/acme/repo-2/pull/202",
      number: 202,
      title: "PR B tracked by repo-2",
    });
    // PR-C: from repo-1, but tracked by repo-2's trackedPrUrls (cross-repo) — should be hidden
    const prC = makePullRequest({
      githubId: "gh-pr-203",
      headBranch: "feature/pr-c",
      htmlUrl: "https://github.com/acme/repo/pull/203",
      number: 203,
      title: "PR C from repo-1 tracked by repo-2",
    });

    mockUseResolvedJobRepos.mockReturnValue({
      primary: {
        id: "repo-1",
        fullName: "acme/repo",
        source: RepoSource.TeamDefault,
        inPool: false,
      },
      additional: [
        {
          id: "repo-2",
          fullName: "acme/repo-2",
          source: RepoSource.ProjectOverride,
          inPool: false,
        },
      ],
      pool: [],
      isLoading: false,
    });
    mockGet.mockImplementation((url: string) => {
      if (url.includes("repo-2")) {
        // repo-2 returns PR-B and tracks both PR-B and PR-C (cross-repo)
        return Promise.resolve({
          pullRequests: [prB],
          trackedPrUrls: [prB.htmlUrl, prC.htmlUrl],
        });
      }
      // repo-1 returns PR-A and PR-C, tracks nothing itself
      return Promise.resolve({
        pullRequests: [prA, prC],
        trackedPrUrls: [],
      });
    });
    mockUseResolvedArtifactLinks.mockReturnValue({
      data: [],
      isLoading: false,
    });

    renderWithQueryClient(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={vi.fn()}
        open={true}
        projectId="project-1"
      />
    );

    // PR-A (untracked) should be visible
    await waitFor(() => {
      expect(screen.getByText(MULTI_REPO_PR_A_REGEX)).toBeInTheDocument();
    });

    // PR-B is tracked by repo-2's trackedPrUrls and not linked to the current
    // source — it must be hidden
    expect(screen.queryByText(MULTI_REPO_PR_B_REGEX)).not.toBeInTheDocument();

    // PR-C is from repo-1 but appears in repo-2's trackedPrUrls (cross-repo
    // filtering) — it must also be hidden
    expect(screen.queryByText(MULTI_REPO_PR_C_REGEX)).not.toBeInTheDocument();
  });

  it("shows all-repos-fail error when all repos fail", async () => {
    mockUseResolvedJobRepos.mockReturnValue({
      primary: {
        id: "repo-1",
        fullName: "acme/repo",
        source: RepoSource.TeamDefault,
        inPool: false,
      },
      additional: [
        {
          id: "repo-2",
          fullName: "acme/repo-fork",
          source: RepoSource.ProjectOverride,
          inPool: false,
        },
      ],
      pool: [],
      isLoading: false,
    });
    mockGet.mockRejectedValue(new Error("Network error"));

    renderWithQueryClient(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={vi.fn()}
        open={true}
        projectId="project-1"
      />
    );

    await waitFor(() => {
      expect(screen.getByText(ALL_REPOS_FAIL_ERROR_REGEX)).toBeInTheDocument();
    });
    expect(
      screen.queryByPlaceholderText(SEARCH_PR_PLACEHOLDER_REGEX)
    ).not.toBeInTheDocument();
  });

  it("hides PRs whose repo:branch key is tracked, even when the PR URL is not", async () => {
    // The backend reports already-tracked branches via `trackedBranchKeys`
    // (`<repoFullName>:<headBranch>`), distinct from URL-based `trackedPrUrls`.
    const trackedByBranch = makePullRequest({
      githubId: "gh-pr-301",
      headBranch: "feature/tracked-branch",
      htmlUrl: "https://github.com/acme/repo/pull/301",
      number: 301,
      title: "Tracked by branch key",
    });
    const untracked = makePullRequest({
      githubId: "gh-pr-302",
      headBranch: "feature/untracked",
      htmlUrl: "https://github.com/acme/repo/pull/302",
      number: 302,
      title: "Visible untracked branch",
    });

    mockGet.mockResolvedValue({
      pullRequests: [trackedByBranch, untracked],
      trackedPrUrls: [],
      trackedBranchKeys: ["acme/repo:feature/tracked-branch"],
    });

    renderWithQueryClient(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={vi.fn()}
        open={true}
        projectId="project-1"
      />
    );

    // The untracked PR (same repo, different branch) stays visible.
    await waitFor(() => {
      expect(screen.getByText(BRANCH_UNTRACKED_PR_REGEX)).toBeInTheDocument();
    });
    // The PR whose `acme/repo:feature/tracked-branch` key matches is filtered
    // out entirely — hidden and therefore unselectable.
    expect(screen.queryByText(BRANCH_TRACKED_PR_REGEX)).not.toBeInTheDocument();
  });
});
