import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMockArtifact } from "@/__tests__/fixtures/artifacts";
import { PlanTable } from "../plan-table";

// Mock the hooks
const mockUseRouter = vi.fn();
const mockUseArtifacts = vi.fn();
const mockUseDeleteArtifact = vi.fn();
const mockUseUpdateArtifact = vi.fn();
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
    useArtifacts: () => mockUseArtifacts(),
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

describe("PlanTable", () => {
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

  test("renders plan artifacts", () => {
    const mockPlan = createMockArtifact({
      id: "plan-1",
      title: "Implementation Plan Alpha",
      type: "IMPLEMENTATION_PLAN",
    });

    mockUseArtifacts.mockReturnValue({
      data: [mockPlan],
      isLoading: false,
      error: null,
    });

    render(<PlanTable />);

    expect(screen.getByText("Implementation Plan Alpha")).toBeInTheDocument();
  });

  test("renders loading state correctly", () => {
    mockUseArtifacts.mockReturnValue({
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
    mockUseArtifacts.mockReturnValue({
      data: [],
      isLoading: false,
      error: { message: errorMessage } as Error,
    });

    render(<PlanTable />);

    expect(screen.getByText(errorMessage)).toBeInTheDocument();
  });

  test("renders empty state when no plans exist", () => {
    mockUseArtifacts.mockReturnValue({
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

  test("renders multiple plan artifacts", () => {
    const mockPlans = [
      createMockArtifact({
        id: "plan-1",
        title: "Plan 1",
        type: "IMPLEMENTATION_PLAN",
      }),
      createMockArtifact({
        id: "plan-2",
        title: "Plan 2",
        type: "IMPLEMENTATION_PLAN",
      }),
    ];

    mockUseArtifacts.mockReturnValue({
      data: mockPlans,
      isLoading: false,
      error: null,
    });

    render(<PlanTable />);

    expect(screen.getByText("Plan 1")).toBeInTheDocument();
    expect(screen.getByText("Plan 2")).toBeInTheDocument();
  });
});
