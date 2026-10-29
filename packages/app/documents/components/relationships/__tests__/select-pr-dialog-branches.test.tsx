import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import {
  GitHubPRState,
  type GitHubPullRequestSummary,
} from "@repo/api/src/types/github";
import { PullRequestLabelSyncStatus } from "@repo/api/src/types/pull-request-label-sync-status";
import { RepoSource } from "@repo/app/documents/editors/shared/job-repositories/use-resolved-job-repos";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectPullRequestDialog } from "../select-pr-dialog";

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockCreateArtifactLink = vi.fn();
const mockUseResolvedArtifactLinks = vi.fn();
const mockUseResolvedJobRepos = vi.fn();
const mockToastSuccess = vi.fn();
const mockToastWarning = vi.fn();

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => false,
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    warning: (...args: unknown[]) => mockToastWarning(...args),
  },
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  }),
}));

vi.mock("@repo/app/documents/hooks/use-artifact-links", async () => {
  const actual = await vi.importActual(
    "@repo/app/documents/hooks/use-artifact-links"
  );
  return {
    ...actual,
    useCreateArtifactLink: () => ({ mutateAsync: mockCreateArtifactLink }),
    useResolvedArtifactLinks: (...args: unknown[]) =>
      mockUseResolvedArtifactLinks(...args),
  };
});

vi.mock(
  "@repo/app/documents/editors/shared/job-repositories/use-resolved-job-repos",
  async () => {
    const actual = await vi.importActual<
      typeof import("@repo/app/documents/editors/shared/job-repositories/use-resolved-job-repos")
    >(
      "@repo/app/documents/editors/shared/job-repositories/use-resolved-job-repos"
    );
    return {
      ...actual,
      useResolvedJobRepos: (...args: unknown[]) =>
        mockUseResolvedJobRepos(...args),
    };
  }
);

const NO_DOCUMENT_REGEX = /No document is available to link this pull request/;
const NO_REPOSITORY_REGEX = /No repository configured for this project/;
const SEARCH_PLACEHOLDER = "Search pull requests...";
const PR_TITLE_REGEX = /Fix direct feature PR linking/;
// Titles deliberately carry none of the state words below, so a badge
// assertion cannot be satisfied by the row's own title text.
const MERGED_TITLE_REGEX = /Landed the parser rewrite/;
const CLOSED_TITLE_REGEX = /Abandoned the parser rewrite/;
const DRAFT_TITLE_REGEX = /Still drafting the parser rewrite/;
const OPEN_TITLE_REGEX = /Ready for review/;
const DOC_LINKED_TITLE_REGEX = /Tracked but linked by a document target/;
const BRANCH_LINKED_TITLE_REGEX = /Tracked and linked by current PR/;
const BRANCH_URL_LINKED_REGEX = /Tracked and linked by branch URL/;
const PLAIN_PR_TITLE_REGEX = /Neither tracked nor linked/;
const OTHER_REPO_TITLE_REGEX = /Work in the other repository/;
const LINKED_BADGE_TEXT = "Linked";
const GITHUB_REJECTED_REGEX = /GitHub rejected the labels\./;
const LINKING_IN_FLIGHT_TEXT = "Linking PR...";
const CHECKING_LINKS_TEXT = "Checking existing PR links...";
const NO_RESULTS_TEXT = "No pull requests found.";
const LOADING_RESULTS_TEXT = "Loading pull requests...";
const PARTIAL_FAILURE_TEXT =
  "Could not load PRs from 1 of 2 repositories. Showing results from the remaining repositories.";

const PRIMARY_REPO = {
  id: "repo-1",
  fullName: "acme/repo",
  source: RepoSource.TeamDefault,
};

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

function renderDialog(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}

function rowFor(title: RegExp): HTMLElement {
  const row = screen.getByText(title).closest("[cmdk-item]");
  if (!(row instanceof HTMLElement)) {
    throw new Error(`row for ${title} not rendered`);
  }
  return row;
}

describe("SelectPullRequestDialog branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({
      pullRequests: [makePullRequest()],
      trackedPrUrls: [],
    });
    mockUseResolvedJobRepos.mockReturnValue({
      primary: PRIMARY_REPO,
      additional: [],
      pool: [],
      isLoading: false,
      poolError: null,
    });
    mockUseResolvedArtifactLinks.mockReturnValue({
      data: [],
      isLoading: false,
    });
    mockPost.mockResolvedValue({ id: "pr-artifact-101" });
    mockCreateArtifactLink.mockResolvedValue({ id: "artifact-link-1" });
  });

  afterEach(() => {
    cleanup();
  });

  it("warns that nothing can be linked when neither a document nor a plan is given", () => {
    renderDialog(
      <SelectPullRequestDialog
        onOpenChange={vi.fn()}
        open
        projectId="project-1"
      />
    );

    expect(screen.getByText(NO_DOCUMENT_REGEX)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(SEARCH_PLACEHOLDER)).toBeNull();
    // With no link owner the resolved-links read is disabled and keyed empty.
    expect(mockUseResolvedArtifactLinks).toHaveBeenCalledWith(
      "",
      expect.objectContaining({ enabled: false })
    );
  });

  it("warns that no repository is configured once the resolver settles empty", () => {
    mockUseResolvedJobRepos.mockReturnValue({
      primary: null,
      additional: [],
      pool: [],
      isLoading: false,
      poolError: null,
    });

    renderDialog(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={vi.fn()}
        open
        projectId="project-1"
      />
    );

    expect(screen.getByText(NO_REPOSITORY_REGEX)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(SEARCH_PLACEHOLDER)).toBeNull();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("keeps the picker up instead of the no-repository warning while the resolver is loading", () => {
    mockUseResolvedJobRepos.mockReturnValue({
      primary: null,
      additional: [],
      pool: [],
      isLoading: true,
      poolError: null,
    });

    renderDialog(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={vi.fn()}
        open
        projectId="project-1"
      />
    );

    expect(screen.queryByText(NO_REPOSITORY_REGEX)).toBeNull();
    expect(screen.getByPlaceholderText(SEARCH_PLACEHOLDER)).toBeInTheDocument();
  });

  it("queries each repository once, skipping a duplicate of the primary and an id-less additional", async () => {
    mockUseResolvedJobRepos.mockReturnValue({
      primary: PRIMARY_REPO,
      additional: [
        { ...PRIMARY_REPO, source: RepoSource.ProjectOverride },
        {
          id: "",
          fullName: "acme/nameless",
          source: RepoSource.ProjectOverride,
        },
      ],
      pool: [],
      isLoading: false,
      poolError: null,
    });

    renderDialog(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={vi.fn()}
        open
        projectId="project-1"
      />
    );

    await waitFor(() => screen.getByText(PR_TITLE_REGEX));
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet.mock.calls[0][0]).toContain("/repositories/repo-1/");
    // One effective repo: no per-row repository badge.
    expect(screen.queryByText("acme/repo")).toBeNull();
  });

  it("labels each row with its repository when more than one repository is queried", async () => {
    mockUseResolvedJobRepos.mockReturnValue({
      primary: PRIMARY_REPO,
      additional: [
        {
          id: "repo-2",
          fullName: "acme/other",
          source: RepoSource.ProjectOverride,
        },
      ],
      pool: [],
      isLoading: false,
      poolError: null,
    });
    mockGet.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes("repo-2")
          ? { pullRequests: [], trackedPrUrls: [] }
          : { pullRequests: [makePullRequest()], trackedPrUrls: [] }
      )
    );

    renderDialog(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={vi.fn()}
        open
        projectId="project-1"
      />
    );

    await waitFor(() => screen.getByText(PR_TITLE_REGEX));
    expect(rowFor(PR_TITLE_REGEX)).toHaveTextContent("acme/repo");
  });

  it("uses the plan as both link owner and tag source when there is no issue document", async () => {
    const user = userEvent.setup();
    renderDialog(
      <SelectPullRequestDialog
        onOpenChange={vi.fn()}
        open
        planId="plan-1"
        projectId="project-1"
      />
    );

    await waitFor(() => screen.getByText(PR_TITLE_REGEX));
    await user.click(screen.getByText(PR_TITLE_REGEX));

    await waitFor(() =>
      expect(mockCreateArtifactLink).toHaveBeenCalledWith({
        linkType: LinkType.Produces,
        sourceId: "plan-1",
        targetId: "pr-artifact-101",
      })
    );
    expect(mockPost).toHaveBeenCalledWith(
      "/artifact-links/pull-requests",
      expect.objectContaining({
        sourceArtifactId: "plan-1",
        linkSourceArtifactId: "plan-1",
      })
    );
  });

  it("skips the client-side link write when the API echoes that it already linked the source", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    mockPost.mockResolvedValue({
      id: "pr-artifact-101",
      linkedSourceArtifactId: "feature-1",
    });

    renderDialog(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={onOpenChange}
        open
        projectId="project-1"
      />
    );

    await waitFor(() => screen.getByText(PR_TITLE_REGEX));
    await user.click(screen.getByText(PR_TITLE_REGEX));

    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith("Linked PR #101")
    );
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockCreateArtifactLink).not.toHaveBeenCalled();
    expect(mockToastWarning).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("routes a failed label sync through a warning toast, not a success toast", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    mockPost.mockResolvedValue({
      id: "pr-artifact-101",
      linkedSourceArtifactId: "feature-1",
      labelSync: {
        status: PullRequestLabelSyncStatus.Failed,
        createdLabels: [],
        addedLabels: [],
        droppedLabels: [],
      },
    });

    renderDialog(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={onOpenChange}
        open
        projectId="project-1"
      />
    );

    await waitFor(() => screen.getByText(PR_TITLE_REGEX));
    await user.click(screen.getByText(PR_TITLE_REGEX));

    await waitFor(() =>
      expect(mockToastWarning).toHaveBeenCalledWith(
        expect.stringMatching(GITHUB_REJECTED_REGEX)
      )
    );
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("badges and colors each row by pull request state", async () => {
    mockGet.mockResolvedValue({
      pullRequests: [
        makePullRequest({
          htmlUrl: "https://github.com/acme/repo/pull/1",
          number: 1,
          state: GitHubPRState.Merged,
          title: "Landed the parser rewrite",
        }),
        makePullRequest({
          htmlUrl: "https://github.com/acme/repo/pull/2",
          number: 2,
          state: GitHubPRState.Closed,
          title: "Abandoned the parser rewrite",
        }),
        makePullRequest({
          htmlUrl: "https://github.com/acme/repo/pull/3",
          number: 3,
          isDraft: true,
          title: "Still drafting the parser rewrite",
        }),
        makePullRequest({
          htmlUrl: "https://github.com/acme/repo/pull/4",
          number: 4,
          title: "Ready for review",
        }),
      ],
      trackedPrUrls: [],
    });

    renderDialog(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={vi.fn()}
        open
        projectId="project-1"
      />
    );

    await waitFor(() => screen.getByText(OPEN_TITLE_REGEX));
    const cases: [RegExp, string, string][] = [
      [MERGED_TITLE_REGEX, "Merged", "text-purple-500"],
      [CLOSED_TITLE_REGEX, "Closed", "text-red-500"],
      [DRAFT_TITLE_REGEX, "Draft", "text-muted-foreground"],
      [OPEN_TITLE_REGEX, "Open", "text-green-500"],
    ];
    for (const [title, badge, iconClass] of cases) {
      const row = rowFor(title);
      expect(within(row).getByText(badge)).toBeInTheDocument();
      expect(row.querySelector("svg")).toHaveClass(iconClass);
      for (const [, otherBadge] of cases.filter(([t]) => t !== title)) {
        expect(within(row).queryByText(otherBadge)).toBeNull();
      }
    }
  });

  it("counts only branch targets as linked, reading the current PR URL when the branch has no external URL", async () => {
    const docLinkedPr = makePullRequest({
      htmlUrl: "https://github.com/acme/repo/pull/501",
      number: 501,
      title: "Tracked but linked by a document target",
    });
    const branchLinkedPr = makePullRequest({
      htmlUrl: "https://github.com/acme/repo/pull/502",
      number: 502,
      title: "Tracked and linked by current PR",
    });
    const branchUrlLinkedPr = makePullRequest({
      htmlUrl: "https://github.com/acme/repo/pull/503",
      number: 503,
      title: "Tracked and linked by branch URL",
    });
    const plainPr = makePullRequest({
      htmlUrl: "https://github.com/acme/repo/pull/504",
      number: 504,
      title: "Neither tracked nor linked",
    });
    mockGet.mockResolvedValue({
      pullRequests: [docLinkedPr, branchLinkedPr, branchUrlLinkedPr, plainPr],
      trackedPrUrls: [
        docLinkedPr.htmlUrl,
        branchLinkedPr.htmlUrl,
        branchUrlLinkedPr.htmlUrl,
      ],
    });
    mockUseResolvedArtifactLinks.mockReturnValue({
      data: [
        {
          id: "link-doc",
          target: {
            id: "doc-target",
            type: ArtifactType.Document,
            externalUrl: docLinkedPr.htmlUrl,
          },
        },
        {
          id: "link-branch",
          target: {
            id: "branch-target",
            type: ArtifactType.Branch,
            externalUrl: null,
            branch: { currentPullRequest: { htmlUrl: branchLinkedPr.htmlUrl } },
          },
        },
        {
          id: "link-branch-url",
          target: {
            id: "branch-url-target",
            type: ArtifactType.Branch,
            externalUrl: branchUrlLinkedPr.htmlUrl,
            // A branch artifact with no PR on it yet: the reader must tolerate
            // the missing `currentPullRequest` and fall through to the URL.
            branch: {},
          },
        },
      ],
      isLoading: false,
    });

    renderDialog(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={vi.fn()}
        open
        projectId="project-1"
      />
    );

    await waitFor(() => screen.getByText(BRANCH_LINKED_TITLE_REGEX));
    for (const title of [BRANCH_LINKED_TITLE_REGEX, BRANCH_URL_LINKED_REGEX]) {
      const row = rowFor(title);
      expect(within(row).getByText(LINKED_BADGE_TEXT)).toBeInTheDocument();
      // Already linked here: the row states it and refuses a second link.
      expect(row).toHaveAttribute("aria-disabled", "true");
    }
    // A non-branch target does not make a tracked PR "linked here", so it
    // stays hidden like any PR tracked elsewhere.
    expect(screen.queryByText(DOC_LINKED_TITLE_REGEX)).toBeNull();

    const plainRow = rowFor(PLAIN_PR_TITLE_REGEX);
    expect(within(plainRow).queryByText(LINKED_BADGE_TEXT)).toBeNull();
    expect(plainRow).not.toHaveAttribute("aria-disabled", "true");
    // The resolved links have settled, so nothing is still being checked.
    expect(screen.queryByText(CHECKING_LINKS_TEXT)).toBeNull();
  });

  it("says it is checking existing links only while that read is in flight and something is tracked", async () => {
    mockGet.mockResolvedValue({
      pullRequests: [makePullRequest()],
      trackedPrUrls: [],
      trackedBranchKeys: ["acme/repo:feature/direct-link"],
    });
    mockUseResolvedArtifactLinks.mockReturnValue({
      data: [],
      isLoading: true,
    });

    renderDialog(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={vi.fn()}
        open
        projectId="project-1"
      />
    );

    // A tracked BRANCH KEY alone, with no tracked URL, is enough to wait on.
    expect(await screen.findByText(CHECKING_LINKS_TEXT)).toBeInTheDocument();
  });

  it("does not say it is checking existing links when nothing is tracked", async () => {
    mockUseResolvedArtifactLinks.mockReturnValue({
      data: [],
      isLoading: true,
    });

    renderDialog(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={vi.fn()}
        open
        projectId="project-1"
      />
    );

    await waitFor(() => screen.getByText(PR_TITLE_REGEX));
    expect(screen.queryByText(CHECKING_LINKS_TEXT)).toBeNull();
  });

  it("reports the link write in flight and clears the report when it settles", async () => {
    const user = userEvent.setup({ delay: null });
    let resolvePost: (value: unknown) => void = () => undefined;
    mockPost.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve;
        })
    );

    renderDialog(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={vi.fn()}
        open
        projectId="project-1"
      />
    );

    await waitFor(() => screen.getByText(PR_TITLE_REGEX));
    expect(screen.queryByText(LINKING_IN_FLIGHT_TEXT)).toBeNull();
    await user.click(screen.getByText(PR_TITLE_REGEX));

    expect(await screen.findByText(LINKING_IN_FLIGHT_TEXT)).toBeInTheDocument();
    // Every row is refused while a link is being written.
    expect(rowFor(PR_TITLE_REGEX)).toHaveAttribute("aria-disabled", "true");

    resolvePost({ id: "pr-artifact-101", linkedSourceArtifactId: "feature-1" });
    await waitFor(() =>
      expect(screen.queryByText(LINKING_IN_FLIGHT_TEXT)).toBeNull()
    );
  });

  it("says the list is loading, then that it is empty, rather than showing nothing", async () => {
    mockGet.mockImplementation(() => new Promise(() => undefined));
    const loading = renderDialog(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={vi.fn()}
        open
        projectId="project-1"
      />
    );

    expect(await screen.findByText(LOADING_RESULTS_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(NO_RESULTS_TEXT)).toBeNull();
    loading.unmount();

    mockGet.mockResolvedValue({ pullRequests: [], trackedPrUrls: [] });
    renderDialog(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={vi.fn()}
        open
        projectId="project-1"
      />
    );

    expect(await screen.findByText(NO_RESULTS_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(LOADING_RESULTS_TEXT)).toBeNull();
  });

  it("searches rows by repository, author and branch as well as number and title", async () => {
    const user = userEvent.setup({ delay: null });
    mockUseResolvedJobRepos.mockReturnValue({
      primary: PRIMARY_REPO,
      additional: [
        {
          id: "repo-2",
          fullName: "acme/other",
          source: RepoSource.ProjectOverride,
        },
      ],
      pool: [],
      isLoading: false,
      poolError: null,
    });
    const otherRepoPr = makePullRequest({
      author: "hopper",
      headBranch: "feature/elsewhere",
      htmlUrl: "https://github.com/acme/other/pull/900",
      number: 900,
      title: "Work in the other repository",
    });
    mockGet.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes("repo-2")
          ? { pullRequests: [otherRepoPr], trackedPrUrls: [] }
          : { pullRequests: [makePullRequest()], trackedPrUrls: [] }
      )
    );

    renderDialog(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={vi.fn()}
        open
        projectId="project-1"
      />
    );

    await waitFor(() => screen.getByText(OTHER_REPO_TITLE_REGEX));
    await user.type(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), "hopper");

    await waitFor(() => expect(screen.queryByText(PR_TITLE_REGEX)).toBeNull());
    expect(screen.getByText(OTHER_REPO_TITLE_REGEX)).toBeInTheDocument();

    await user.clear(screen.getByPlaceholderText(SEARCH_PLACEHOLDER));
    await user.type(
      screen.getByPlaceholderText(SEARCH_PLACEHOLDER),
      "acme/other"
    );

    await waitFor(() => expect(screen.queryByText(PR_TITLE_REGEX)).toBeNull());
    expect(screen.getByText(OTHER_REPO_TITLE_REGEX)).toBeInTheDocument();
  });

  it("names how many repositories failed and how many were read", async () => {
    mockUseResolvedJobRepos.mockReturnValue({
      primary: PRIMARY_REPO,
      additional: [
        {
          id: "repo-2",
          fullName: "acme/other",
          source: RepoSource.ProjectOverride,
        },
      ],
      pool: [],
      isLoading: false,
      poolError: null,
    });
    mockGet.mockImplementation((url: string) =>
      url.includes("repo-2")
        ? Promise.reject(new Error("not found"))
        : Promise.resolve({
            pullRequests: [makePullRequest()],
            trackedPrUrls: [],
          })
    );

    renderDialog(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={vi.fn()}
        open
        projectId="project-1"
      />
    );

    const warning = await screen.findByRole("status");
    expect(warning.textContent).toContain(PARTIAL_FAILURE_TEXT);
  });

  it("holds both reads closed until the dialog opens, then scopes them to this project and source", async () => {
    const closed = renderDialog(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={vi.fn()}
        open={false}
        projectId="project-1"
      />
    );

    expect(mockUseResolvedJobRepos).toHaveBeenCalledWith({
      projectId: "project-1",
      enabled: false,
    });
    expect(mockUseResolvedArtifactLinks).toHaveBeenCalledWith(
      "feature-1",
      expect.objectContaining({ enabled: false })
    );
    expect(mockGet).not.toHaveBeenCalled();
    closed.unmount();
    vi.clearAllMocks();
    mockGet.mockResolvedValue({
      pullRequests: [makePullRequest()],
      trackedPrUrls: [],
    });
    mockUseResolvedJobRepos.mockReturnValue({
      primary: PRIMARY_REPO,
      additional: [],
      pool: [],
      isLoading: false,
      poolError: null,
    });
    mockUseResolvedArtifactLinks.mockReturnValue({
      data: [],
      isLoading: false,
    });

    renderDialog(
      <SelectPullRequestDialog
        documentId="feature-1"
        onOpenChange={vi.fn()}
        open
        projectId="project-1"
      />
    );

    expect(mockUseResolvedJobRepos).toHaveBeenCalledWith({
      projectId: "project-1",
      enabled: true,
    });
    expect(mockUseResolvedArtifactLinks).toHaveBeenCalledWith(
      "feature-1",
      expect.objectContaining({ enabled: true })
    );
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
  });
});
