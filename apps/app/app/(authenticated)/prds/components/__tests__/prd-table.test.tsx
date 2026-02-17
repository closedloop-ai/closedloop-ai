import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMockArtifact } from "@/__tests__/fixtures/artifacts";
import { PRDTable } from "../prd-table";

// Mock the hooks
const mockUseRouter = vi.fn();
const mockUseArtifacts = vi.fn();
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

describe("PRDTable", () => {
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

  test("renders PRD artifacts", () => {
    const mockPRD = createMockArtifact({
      id: "prd-1",
      title: "PRD Alpha",
      type: "PRD",
    });

    mockUseArtifacts.mockReturnValue({
      data: [mockPRD],
      isLoading: false,
      error: null,
    });

    render(<PRDTable />);

    expect(screen.getByText("PRD Alpha")).toBeInTheDocument();
  });

  test("renders loading state without errors", () => {
    mockUseArtifacts.mockReturnValue({
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
    mockUseArtifacts.mockReturnValue({
      data: [],
      isLoading: false,
      error: new Error("Failed to fetch PRDs"),
    });

    render(<PRDTable />);

    expect(screen.getByText("Failed to fetch PRDs")).toBeInTheDocument();
  });

  test("renders empty state when no PRDs exist", () => {
    mockUseArtifacts.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    });

    render(<PRDTable />);

    expect(
      screen.getByText("No PRDs found. Create your first PRD to get started.")
    ).toBeInTheDocument();
  });

  test("renders multiple PRD artifacts", () => {
    const mockPRDs = [
      createMockArtifact({
        id: "prd-1",
        title: "PRD 1",
        type: "PRD",
      }),
      createMockArtifact({
        id: "prd-2",
        title: "PRD 2",
        type: "PRD",
      }),
    ];

    mockUseArtifacts.mockReturnValue({
      data: mockPRDs,
      isLoading: false,
      error: null,
    });

    render(<PRDTable />);

    expect(screen.getByText("PRD 1")).toBeInTheDocument();
    expect(screen.getByText("PRD 2")).toBeInTheDocument();
  });
});
