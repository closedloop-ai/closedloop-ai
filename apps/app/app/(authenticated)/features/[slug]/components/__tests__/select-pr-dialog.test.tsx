import { EntityType, LinkType } from "@repo/api/src/types/entity-link";
import {
  type ExternalLink,
  ExternalLinkType,
} from "@repo/api/src/types/external-link";
import {
  GitHubPRState,
  type GitHubPullRequestSummary,
} from "@repo/api/src/types/github";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectPullRequestDialog } from "../select-pr-dialog";

const mockUseProject = vi.fn();
const mockUseGitHubPullRequests = vi.fn();
const mockUseExternalLinks = vi.fn();
const mockUseLinkedEntities = vi.fn();
const mockCreateExternalLink = vi.fn();
const mockCreateEntityLink = vi.fn();
const mockToastSuccess = vi.fn();
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

vi.mock("@/hooks/queries/use-external-links", async () => {
  const actual = await vi.importActual("@/hooks/queries/use-external-links");
  return {
    ...actual,
    useCreateExternalLink: () => ({
      mutateAsync: mockCreateExternalLink,
    }),
    useExternalLinks: (...args: unknown[]) => mockUseExternalLinks(...args),
  };
});

vi.mock("@/hooks/queries/use-entity-links", async () => {
  const actual = await vi.importActual("@/hooks/queries/use-entity-links");
  return {
    ...actual,
    useCreateEntityLink: () => ({
      mutateAsync: mockCreateEntityLink,
    }),
    useLinkedEntities: (...args: unknown[]) => mockUseLinkedEntities(...args),
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

function makeExternalLink(overrides: Partial<ExternalLink> = {}): ExternalLink {
  return {
    createdAt: new Date("2026-04-16T12:00:00.000Z"),
    externalUrl: "https://github.com/acme/repo/pull/101",
    id: "external-link-101",
    metadata: null,
    organizationId: "org-1",
    projectId: "project-1",
    title: "PR #101: Fix direct feature PR linking",
    type: ExternalLinkType.PullRequest,
    updatedAt: new Date("2026-04-16T12:00:00.000Z"),
    workstreamId: null,
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
    mockUseExternalLinks.mockReturnValue({
      data: [],
    });
    mockUseLinkedEntities.mockReturnValue({
      data: [],
    });
    mockCreateExternalLink.mockResolvedValue(makeExternalLink());
    mockCreateEntityLink.mockResolvedValue({ id: "entity-link-1" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("links a selected PR directly to the feature without requiring a plan", async () => {
    const user = userEvent.setup();

    render(
      <SelectPullRequestDialog
        featureId="feature-1"
        onOpenChange={vi.fn()}
        open={true}
        projectId="project-1"
      />
    );

    await user.click(screen.getByText(PR_TITLE_REGEX));

    await waitFor(() => {
      expect(mockCreateExternalLink).toHaveBeenCalledWith({
        externalUrl: "https://github.com/acme/repo/pull/101",
        metadata: {
          baseBranch: "main",
          githubId: "gh-pr-101",
          headBranch: "feature/direct-link",
          number: 101,
          state: GitHubPRState.Open,
        },
        projectId: "project-1",
        title: "PR #101: Fix direct feature PR linking",
        type: ExternalLinkType.PullRequest,
      });
    });

    expect(mockCreateEntityLink).toHaveBeenCalledWith({
      linkType: LinkType.Produces,
      sourceId: "feature-1",
      sourceType: EntityType.Feature,
      targetId: "external-link-101",
      targetType: EntityType.ExternalLink,
    });
  });

  it("reuses an existing project PR external link before creating the feature link", async () => {
    const user = userEvent.setup();

    mockUseExternalLinks.mockReturnValue({
      data: [
        makeExternalLink({
          id: "external-link-existing",
        }),
      ],
    });

    render(
      <SelectPullRequestDialog
        featureId="feature-1"
        onOpenChange={vi.fn()}
        open={true}
        projectId="project-1"
      />
    );

    await user.click(screen.getByText(PR_TITLE_REGEX));

    await waitFor(() => {
      expect(mockCreateEntityLink).toHaveBeenCalledWith({
        linkType: LinkType.Produces,
        sourceId: "feature-1",
        sourceType: EntityType.Feature,
        targetId: "external-link-existing",
        targetType: EntityType.ExternalLink,
      });
    });

    expect(mockCreateExternalLink).not.toHaveBeenCalled();
  });
});
