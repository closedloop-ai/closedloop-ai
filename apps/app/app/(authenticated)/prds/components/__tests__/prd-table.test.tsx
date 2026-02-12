import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createMockArtifact,
  createMockPullRequest,
} from "@/__tests__/fixtures/artifacts";
import { PRDTable } from "../prd-table";

// Mock the hooks
const mockUseRouter = vi.fn();
const mockUseArtifactsBySubtype = vi.fn();
const mockUseUpdateArtifact = vi.fn();
const mockUseDeleteArtifact = vi.fn();
const mockUseProjects = vi.fn();

// Mock TanStack Query's useQueryClient
const mockInvalidateQueries = vi.fn();
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: () => ({
      invalidateQueries: mockInvalidateQueries,
    }),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => mockUseRouter(),
}));

vi.mock("@/hooks/queries/use-artifacts", async () => {
  const actual = await vi.importActual("@/hooks/queries/use-artifacts");
  return {
    ...actual,
    useArtifactsBySubtype: () => mockUseArtifactsBySubtype(),
    useUpdateArtifact: () => mockUseUpdateArtifact(),
    useDeleteArtifact: () => mockUseDeleteArtifact(),
  };
});

vi.mock("@/hooks/queries/use-projects", async () => {
  const actual = await vi.importActual("@/hooks/queries/use-projects");
  return {
    ...actual,
    useProjects: () => mockUseProjects(),
  };
});

const PULL_REQUEST_REGEX = /Pull request/;

describe("PRDTable - PR Icon Display", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseRouter.mockReturnValue({ push: vi.fn() });
    mockUseUpdateArtifact.mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
    });
    mockUseDeleteArtifact.mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
    });
    mockUseProjects.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    });
    mockInvalidateQueries.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  test("displays PR icon with link when artifact has pullRequest", () => {
    const mockPR = createMockPullRequest({
      number: 42,
      htmlUrl: "https://github.com/org/repo/pull/42",
    });

    const mockPRD = createMockArtifact({
      id: "prd-1",
      title: "PRD with PR",
      subtype: "PRD",
      pullRequest: mockPR,
    });

    mockUseArtifactsBySubtype.mockReturnValue({
      data: [mockPRD],
      isLoading: false,
      error: null,
    });

    render(<PRDTable />);

    // Verify artifact title is rendered
    expect(screen.getByText("PRD with PR")).toBeInTheDocument();

    // Verify PR link is rendered with correct attributes
    const prLink = screen.getByRole("link", { name: "Pull request #42" });
    expect(prLink).toBeInTheDocument();
    expect(prLink).toHaveAttribute(
      "href",
      "https://github.com/org/repo/pull/42"
    );
    expect(prLink).toHaveAttribute("target", "_blank");
    expect(prLink).toHaveAttribute("rel", "noopener noreferrer");
  });

  test("does not display PR icon when artifact has no pullRequest", () => {
    const mockPRD = createMockArtifact({
      id: "prd-2",
      title: "PRD without PR",
      subtype: "PRD",
      pullRequest: null,
    });

    mockUseArtifactsBySubtype.mockReturnValue({
      data: [mockPRD],
      isLoading: false,
      error: null,
    });

    render(<PRDTable />);

    expect(screen.getByText("PRD without PR")).toBeInTheDocument();

    // Verify no PR link is rendered
    expect(
      screen.queryByRole("link", { name: PULL_REQUEST_REGEX })
    ).not.toBeInTheDocument();
  });

  test("does not display PR icon when pullRequest is undefined", () => {
    const mockPRD = createMockArtifact({
      id: "prd-3",
      title: "PRD with undefined PR",
      subtype: "PRD",
      pullRequest: undefined,
    });

    mockUseArtifactsBySubtype.mockReturnValue({
      data: [mockPRD],
      isLoading: false,
      error: null,
    });

    render(<PRDTable />);

    expect(screen.getByText("PRD with undefined PR")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: PULL_REQUEST_REGEX })
    ).not.toBeInTheDocument();
  });

  test("displays PR icons for multiple artifacts with PRs", () => {
    const mockPR1 = createMockPullRequest({ number: 10 });
    const mockPR2 = createMockPullRequest({ number: 20 });

    const mockPRDs = [
      createMockArtifact({
        id: "prd-1",
        title: "PRD 1",
        pullRequest: mockPR1,
      }),
      createMockArtifact({
        id: "prd-2",
        title: "PRD 2",
        pullRequest: mockPR2,
      }),
      createMockArtifact({
        id: "prd-3",
        title: "PRD 3",
        pullRequest: null,
      }),
    ];

    mockUseArtifactsBySubtype.mockReturnValue({
      data: mockPRDs,
      isLoading: false,
      error: null,
    });

    render(<PRDTable />);

    // Verify two PR links are rendered
    expect(
      screen.getByRole("link", { name: "Pull request #10" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Pull request #20" })
    ).toBeInTheDocument();

    // Verify only two PR links (not three)
    const prLinks = screen.getAllByRole("link", { name: PULL_REQUEST_REGEX });
    expect(prLinks).toHaveLength(2);
  });

  test("renders loading state without errors", () => {
    mockUseArtifactsBySubtype.mockReturnValue({
      data: [],
      isLoading: true,
      error: null,
    });

    const { container } = render(<PRDTable />);

    // Loading state renders a Loader2Icon (SVG with aria-hidden="true")
    const loader = container.querySelector(".animate-spin");
    expect(loader).toBeInTheDocument();
  });

  test("renders error state without crashing", () => {
    mockUseArtifactsBySubtype.mockReturnValue({
      data: [],
      isLoading: false,
      error: new Error("Failed to fetch PRDs"),
    });

    render(<PRDTable />);

    expect(screen.getByText("Failed to fetch PRDs")).toBeInTheDocument();
  });

  test("renders empty state when no PRDs exist", () => {
    mockUseArtifactsBySubtype.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    });

    render(<PRDTable />);

    expect(
      screen.getByText("No PRDs found. Create your first PRD to get started.")
    ).toBeInTheDocument();
  });
});
