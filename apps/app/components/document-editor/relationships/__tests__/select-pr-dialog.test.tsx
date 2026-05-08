import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import {
  GitHubPRState,
  type GitHubPullRequestSummary,
} from "@repo/api/src/types/github";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectPullRequestDialog } from "@/components/document-editor/relationships/select-pr-dialog";

function renderWithQueryClient(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}

const mockUseProject = vi.fn();
const mockUseGitHubPullRequests = vi.fn();
const mockUseResolvedArtifactLinks = vi.fn();
const mockUseDocument = vi.fn();
const mockPost = vi.fn();
const mockCreateArtifactLink = vi.fn();
const mockToastSuccess = vi.fn();
const CURRENT_SOURCE_LINKED_PR_REGEX = /already linked on this source/i;
const DIFFERENT_SOURCE_LINKED_PR_REGEX = /linked somewhere else/i;
const EXISTING_PR_LINKS_REGEX = /checking existing pr links/i;
const PR_TITLE_REGEX = /fix direct feature pr linking/i;

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock("@repo/api/src/types/project", async () => {
  const actual = await vi.importActual("@repo/api/src/types/project");
  return {
    ...actual,
    getProjectSettings: () => ({
      defaultRepository: { repoId: "repo-1" },
    }),
  };
});

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
  },
}));

vi.mock("@/hooks/queries/use-projects", async () => {
  const actual = await vi.importActual("@/hooks/queries/use-projects");
  return {
    ...actual,
    useProject: (...args: unknown[]) => mockUseProject(...args),
  };
});

vi.mock("@/hooks/queries/use-github-integration", async () => {
  const actual = await vi.importActual(
    "@/hooks/queries/use-github-integration"
  );
  return {
    ...actual,
    useGitHubPullRequests: (...args: unknown[]) =>
      mockUseGitHubPullRequests(...args),
  };
});

vi.mock("@/hooks/use-api-client", () => ({
  useApiClient: () => ({
    post: (...args: unknown[]) => mockPost(...args),
  }),
}));

vi.mock("@/hooks/queries/use-documents", async () => {
  const actual = await vi.importActual("@/hooks/queries/use-documents");
  return {
    ...actual,
    useDocument: (...args: unknown[]) => mockUseDocument(...args),
  };
});

vi.mock("@/hooks/queries/use-artifact-links", async () => {
  const actual = await vi.importActual("@/hooks/queries/use-artifact-links");
  return {
    ...actual,
    useCreateArtifactLink: () => ({
      mutateAsync: mockCreateArtifactLink,
    }),
    useResolvedArtifactLinks: (...args: unknown[]) =>
      mockUseResolvedArtifactLinks(...args),
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
    htmlUrl: "https://github.com/acme/repo/pull/101",
    isDraft: false,
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
    mockUseGitHubPullRequests.mockReturnValue({
      data: {
        pullRequests: [makePullRequest()],
        trackedPrUrls: [],
      },
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

    await user.click(screen.getByText(PR_TITLE_REGEX));

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(
        "/artifact-links/pull-requests",
        expect.objectContaining({
          externalUrl: "https://github.com/acme/repo/pull/101",
          number: 101,
          githubId: "gh-pr-101",
          headBranch: "feature/direct-link",
          baseBranch: "main",
          state: GitHubPRState.Open,
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

    await user.click(screen.getByText(PR_TITLE_REGEX));

    await waitFor(() => {
      expect(mockCreateArtifactLink).toHaveBeenCalledWith({
        linkType: LinkType.Produces,
        sourceId: "plan-1",
        targetId: "pr-artifact-101",
      });
    });
  });

  it("hides tracked PRs that are linked elsewhere", () => {
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

    mockUseGitHubPullRequests.mockReturnValue({
      data: {
        pullRequests: [visiblePullRequest, hiddenPullRequest],
        trackedPrUrls: [visiblePullRequest.htmlUrl, hiddenPullRequest.htmlUrl],
      },
      isLoading: false,
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
            type: ArtifactType.PullRequest,
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

    expect(
      screen.getByText(CURRENT_SOURCE_LINKED_PR_REGEX)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(DIFFERENT_SOURCE_LINKED_PR_REGEX)
    ).not.toBeInTheDocument();
  });

  it("hides tracked PRs while the source-linked PRs are still loading", () => {
    const pullRequest = makePullRequest();

    mockUseGitHubPullRequests.mockReturnValue({
      data: {
        pullRequests: [pullRequest],
        trackedPrUrls: [pullRequest.htmlUrl],
      },
      isLoading: false,
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

    expect(screen.getByText(EXISTING_PR_LINKS_REGEX)).toBeInTheDocument();
    expect(screen.queryByText(PR_TITLE_REGEX)).not.toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockCreateArtifactLink).not.toHaveBeenCalled();
  });
});
