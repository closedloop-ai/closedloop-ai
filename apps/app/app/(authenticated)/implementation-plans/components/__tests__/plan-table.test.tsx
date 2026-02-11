import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createMockArtifact,
  createMockPullRequest,
} from "@/__tests__/fixtures/artifacts";
import { PlanTable } from "../plan-table";

// Mock the hooks
const mockUseRouter = vi.fn();
const mockUseArtifactsBySubtype = vi.fn();
const mockUseDeleteArtifact = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => mockUseRouter(),
}));

vi.mock("@/hooks/queries/use-artifacts", async () => {
  const actual = await vi.importActual("@/hooks/queries/use-artifacts");
  return {
    ...actual,
    useArtifactsBySubtype: () => mockUseArtifactsBySubtype(),
    useDeleteArtifact: () => mockUseDeleteArtifact(),
  };
});

const PULL_REQUEST_REGEX = /Pull request/;

describe("PlanTable - PR Icon Display", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseRouter.mockReturnValue({ push: vi.fn() });
    mockUseDeleteArtifact.mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  test("displays PR icon with link when plan has pullRequest", () => {
    const mockPR = createMockPullRequest({
      number: 99,
      htmlUrl: "https://github.com/org/repo/pull/99",
    });

    const mockPlan = createMockArtifact({
      id: "plan-1",
      title: "Implementation Plan with PR",
      subtype: "IMPLEMENTATION_PLAN",
      pullRequest: mockPR,
    });

    mockUseArtifactsBySubtype.mockReturnValue({
      data: [mockPlan],
      isLoading: false,
      error: null,
    });

    render(<PlanTable />);

    expect(screen.getByText("Implementation Plan with PR")).toBeInTheDocument();

    const prLink = screen.getByRole("link", { name: "Pull request #99" });
    expect(prLink).toBeInTheDocument();
    expect(prLink).toHaveAttribute(
      "href",
      "https://github.com/org/repo/pull/99"
    );
    expect(prLink).toHaveAttribute("target", "_blank");
    expect(prLink).toHaveAttribute("rel", "noopener noreferrer");
  });

  test("does not display PR icon when plan has no pullRequest", () => {
    const mockPlan = createMockArtifact({
      id: "plan-2",
      title: "Plan without PR",
      subtype: "IMPLEMENTATION_PLAN",
      pullRequest: null,
    });

    mockUseArtifactsBySubtype.mockReturnValue({
      data: [mockPlan],
      isLoading: false,
      error: null,
    });

    render(<PlanTable />);

    expect(screen.getByText("Plan without PR")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: PULL_REQUEST_REGEX })
    ).not.toBeInTheDocument();
  });

  test("displays correct PR numbers for different plans", () => {
    const mockPR1 = createMockPullRequest({ number: 100 });
    const mockPR2 = createMockPullRequest({ number: 101 });

    const mockPlans = [
      createMockArtifact({
        id: "plan-1",
        title: "Plan 1",
        subtype: "IMPLEMENTATION_PLAN",
        pullRequest: mockPR1,
      }),
      createMockArtifact({
        id: "plan-2",
        title: "Plan 2",
        subtype: "IMPLEMENTATION_PLAN",
        pullRequest: mockPR2,
      }),
    ];

    mockUseArtifactsBySubtype.mockReturnValue({
      data: mockPlans,
      isLoading: false,
      error: null,
    });

    render(<PlanTable />);

    expect(
      screen.getByRole("link", { name: "Pull request #100" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Pull request #101" })
    ).toBeInTheDocument();
  });

  test("renders loading state correctly", () => {
    mockUseArtifactsBySubtype.mockReturnValue({
      data: [],
      isLoading: true,
      error: null,
    });

    const { container } = render(<PlanTable />);

    // Loading state renders a Loader2Icon (SVG with aria-hidden="true")
    const loader = container.querySelector(".animate-spin");
    expect(loader).toBeInTheDocument();
  });

  test("renders error state without crashing", () => {
    const errorMessage = "Failed to fetch plans";
    mockUseArtifactsBySubtype.mockReturnValue({
      data: [],
      isLoading: false,
      error: { message: errorMessage } as Error,
    });

    render(<PlanTable />);

    expect(screen.getByText(errorMessage)).toBeInTheDocument();
  });

  test("renders empty state when no plans exist", () => {
    mockUseArtifactsBySubtype.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    });

    render(<PlanTable />);

    expect(
      screen.getByText(
        "No implementation plans found. Create your first plan to get started."
      )
    ).toBeInTheDocument();
  });
});
