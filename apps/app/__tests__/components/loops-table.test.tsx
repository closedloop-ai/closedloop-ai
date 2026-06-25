/**
 * Unit tests for LoopsTable component.
 * Focuses on the restart button row action: when it renders and what it does on click.
 */

import { LoopStatus } from "@repo/api/src/types/loop";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Must be declared before vi.mock factories reference them
const mockMutateAsync = vi.fn();
const mockCancelMutate = vi.fn();
const mockPush = vi.fn();
const mockUseFeatureFlagEnabled = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: mockPush, replace: vi.fn() })),
  usePathname: vi.fn(() => "/loops"),
  useParams: vi.fn(() => ({ orgSlug: "test-org" })),
  useSearchParams: vi.fn(
    () =>
      new URLSearchParams() as unknown as ReturnType<
        typeof import("next/navigation").useSearchParams
      >
  ),
}));

vi.mock("@repo/app/loops/hooks/use-loops", () => ({
  useLoops: vi.fn(() => ({ data: [], isLoading: false, error: null })),
  useResumeLoop: vi.fn(() => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
  })),
}));

vi.mock("@/hooks/queries/use-loops", () => ({
  useCancelLoop: vi.fn(() => ({
    mutate: mockCancelMutate,
    isPending: false,
  })),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => mockUseFeatureFlagEnabled(key),
}));

// Import after mocks
import { useLoops, useResumeLoop } from "@repo/app/loops/hooks/use-loops";
import { createMockLoopWithUser } from "@repo/app/shared/test-fixtures/loops";
import { LoopsTable } from "@/app/(authenticated)/[orgSlug]/loops/components/loops-table";
import { useCancelLoop } from "@/hooks/queries/use-loops";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockUseFeatureFlagEnabled.mockReturnValue(false);
});

describe("LoopsTable — restart button visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMutateAsync.mockResolvedValue({
      loopId: "new-loop-999",
      status: LoopStatus.Pending,
    });
    vi.mocked(useResumeLoop).mockReturnValue({
      mutateAsync: mockMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useResumeLoop>);
  });

  it("renders a restart button for a FAILED loop", () => {
    vi.mocked(useLoops).mockReturnValue({
      data: [createMockLoopWithUser({ status: LoopStatus.Failed })],
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoops>);

    render(<LoopsTable />);

    expect(
      screen.getByRole("button", { name: "Restart loop" })
    ).toBeInTheDocument();
  });

  it("renders a restart button for a TIMED_OUT loop", () => {
    vi.mocked(useLoops).mockReturnValue({
      data: [
        createMockLoopWithUser({ id: "loop-002", status: LoopStatus.TimedOut }),
      ],
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoops>);

    render(<LoopsTable />);

    expect(
      screen.getByRole("button", { name: "Restart loop" })
    ).toBeInTheDocument();
  });

  it("renders a restart button for a CANCELLED loop", () => {
    vi.mocked(useLoops).mockReturnValue({
      data: [
        createMockLoopWithUser({
          id: "loop-003",
          status: LoopStatus.Cancelled,
        }),
      ],
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoops>);

    render(<LoopsTable />);

    expect(
      screen.getByRole("button", { name: "Restart loop" })
    ).toBeInTheDocument();
  });

  it("does not render a restart button for a COMPLETED loop", () => {
    vi.mocked(useLoops).mockReturnValue({
      data: [createMockLoopWithUser({ status: LoopStatus.Completed })],
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoops>);

    render(<LoopsTable />);

    expect(
      screen.queryByRole("button", { name: "Restart loop" })
    ).not.toBeInTheDocument();
  });

  it("does not render a restart button for a RUNNING loop", () => {
    vi.mocked(useLoops).mockReturnValue({
      data: [createMockLoopWithUser({ status: LoopStatus.Running })],
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoops>);

    render(<LoopsTable />);

    expect(
      screen.queryByRole("button", { name: "Restart loop" })
    ).not.toBeInTheDocument();
  });

  it("does not render a restart button for a PENDING loop", () => {
    vi.mocked(useLoops).mockReturnValue({
      data: [createMockLoopWithUser({ status: LoopStatus.Pending })],
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoops>);

    render(<LoopsTable />);

    expect(
      screen.queryByRole("button", { name: "Restart loop" })
    ).not.toBeInTheDocument();
  });
});

describe("LoopsTable — restart button interaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMutateAsync.mockResolvedValue({
      loopId: "new-loop-999",
      status: LoopStatus.Pending,
    });
    vi.mocked(useResumeLoop).mockReturnValue({
      mutateAsync: mockMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useResumeLoop>);
    vi.mocked(useLoops).mockReturnValue({
      data: [
        createMockLoopWithUser({ id: "loop-001", status: LoopStatus.Failed }),
      ],
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoops>);
  });

  it("calls mutateAsync with the loop id when the restart button is clicked", async () => {
    render(<LoopsTable />);

    fireEvent.click(screen.getByRole("button", { name: "Restart loop" }));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({ id: "loop-001" });
    });
  });

  it("preserves legacy restart payload when explicit compute selection is disabled", async () => {
    vi.mocked(useLoops).mockReturnValue({
      data: [
        createMockLoopWithUser({
          id: "loop-001",
          status: LoopStatus.Failed,
          computeTarget: {
            id: "target-1",
            machineName: "danielochoa-MacBook-Pro",
            isOnline: false,
          } as never,
        }),
      ],
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoops>);

    render(<LoopsTable />);

    fireEvent.click(screen.getByRole("button", { name: "Restart loop" }));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({ id: "loop-001" });
    });
  });

  it("passes the displayed compute target id when restarting a targeted loop with explicit selection enabled", async () => {
    mockUseFeatureFlagEnabled.mockReturnValue(true);
    vi.mocked(useLoops).mockReturnValue({
      data: [
        createMockLoopWithUser({
          id: "loop-001",
          status: LoopStatus.Failed,
          computeTarget: {
            id: "target-1",
            machineName: "danielochoa-MacBook-Pro",
            isOnline: false,
          } as never,
        }),
      ],
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoops>);

    render(<LoopsTable />);

    fireEvent.click(screen.getByRole("button", { name: "Restart loop" }));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({
        id: "loop-001",
        computeTargetId: "target-1",
      });
    });
  });

  it("navigates to the new loop id returned by the resume response", async () => {
    mockMutateAsync.mockResolvedValueOnce({
      loopId: "new-loop-999",
      status: LoopStatus.Pending,
    });

    render(<LoopsTable />);

    fireEvent.click(screen.getByRole("button", { name: "Restart loop" }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/test-org/loops/new-loop-999");
    });
  });

  it("does not navigate to the original loop id after restart", async () => {
    mockMutateAsync.mockResolvedValueOnce({
      loopId: "new-loop-999",
      status: LoopStatus.Pending,
    });

    render(<LoopsTable />);

    fireEvent.click(screen.getByRole("button", { name: "Restart loop" }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalled();
    });

    expect(mockPush).not.toHaveBeenCalledWith("/test-org/loops/loop-001");
  });
});

describe("LoopsTable — cancel button visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useCancelLoop).mockReturnValue({
      mutate: mockCancelMutate,
      isPending: false,
    } as unknown as ReturnType<typeof useCancelLoop>);
    vi.mocked(useResumeLoop).mockReturnValue({
      mutateAsync: mockMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useResumeLoop>);
  });

  it("renders a cancel button for a RUNNING loop", () => {
    vi.mocked(useLoops).mockReturnValue({
      data: [createMockLoopWithUser({ status: LoopStatus.Running })],
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoops>);

    render(<LoopsTable />);

    expect(
      screen.getByRole("button", { name: "Stop loop" })
    ).toBeInTheDocument();
  });

  it("renders a cancel button for a PENDING loop", () => {
    vi.mocked(useLoops).mockReturnValue({
      data: [createMockLoopWithUser({ status: LoopStatus.Pending })],
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoops>);

    render(<LoopsTable />);

    expect(
      screen.getByRole("button", { name: "Stop loop" })
    ).toBeInTheDocument();
  });

  it("renders a cancel button for a CLAIMED loop", () => {
    vi.mocked(useLoops).mockReturnValue({
      data: [createMockLoopWithUser({ status: LoopStatus.Claimed })],
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoops>);

    render(<LoopsTable />);

    expect(
      screen.getByRole("button", { name: "Stop loop" })
    ).toBeInTheDocument();
  });

  it("does not render a cancel button for a COMPLETED loop", () => {
    vi.mocked(useLoops).mockReturnValue({
      data: [createMockLoopWithUser({ status: LoopStatus.Completed })],
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoops>);

    render(<LoopsTable />);

    expect(
      screen.queryByRole("button", { name: "Stop loop" })
    ).not.toBeInTheDocument();
  });

  it("does not render a cancel button for a FAILED loop", () => {
    vi.mocked(useLoops).mockReturnValue({
      data: [createMockLoopWithUser({ status: LoopStatus.Failed })],
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoops>);

    render(<LoopsTable />);

    expect(
      screen.queryByRole("button", { name: "Stop loop" })
    ).not.toBeInTheDocument();
  });
});

describe("LoopsTable — compute target column", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useResumeLoop).mockReturnValue({
      mutateAsync: mockMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useResumeLoop>);
    vi.mocked(useCancelLoop).mockReturnValue({
      mutate: mockCancelMutate,
      isPending: false,
    } as unknown as ReturnType<typeof useCancelLoop>);
  });

  it("renders machine name for a local loop (computeTarget set)", () => {
    vi.mocked(useLoops).mockReturnValue({
      data: [
        createMockLoopWithUser({
          status: LoopStatus.Running,
          computeTarget: {
            id: "ct-1",
            machineName: "Mikes-MacBook",
            isOnline: true,
          },
        }),
      ],
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoops>);

    render(<LoopsTable />);

    expect(screen.getByText("Mikes-MacBook")).toBeInTheDocument();
  });

  it("renders 'Cloud' for a cloud loop (containerId set, no computeTarget)", () => {
    vi.mocked(useLoops).mockReturnValue({
      data: [
        createMockLoopWithUser({
          status: LoopStatus.Running,
          containerId: "arn:aws:ecs:us-east-1:123:task/abc",
        }),
      ],
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoops>);

    render(<LoopsTable />);

    expect(screen.getByText("Cloud")).toBeInTheDocument();
  });

  it("renders '-' for unknown compute target (neither set)", () => {
    vi.mocked(useLoops).mockReturnValue({
      data: [
        createMockLoopWithUser({
          status: LoopStatus.Completed,
          containerId: null,
          computeTarget: null,
        }),
      ],
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoops>);

    render(<LoopsTable />);

    // The Target column shows "-" — there may be other "-" cells, so check the table has one
    const cells = screen.getAllByText("-");
    expect(cells.length).toBeGreaterThan(0);
  });
});

describe("LoopsTable — cancel button interaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCancelMutate.mockImplementation((_input, options) => {
      options?.onSuccess?.();
      options?.onSettled?.();
    });
    vi.mocked(useCancelLoop).mockReturnValue({
      mutate: mockCancelMutate,
      isPending: false,
    } as unknown as ReturnType<typeof useCancelLoop>);
    vi.mocked(useResumeLoop).mockReturnValue({
      mutateAsync: mockMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useResumeLoop>);
    vi.mocked(useLoops).mockReturnValue({
      data: [
        createMockLoopWithUser({ id: "loop-001", status: LoopStatus.Running }),
      ],
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoops>);
  });

  it("calls mutate with the loop identity after confirming the stop dialog", async () => {
    render(<LoopsTable />);

    fireEvent.click(screen.getByRole("button", { name: "Stop loop" }));

    // Confirmation dialog should appear
    const confirmButton = await screen.findByRole("button", {
      name: "Stop Loop",
    });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(mockCancelMutate).toHaveBeenCalledWith(
        {
          id: "loop-001",
          computeTargetId: null,
        },
        expect.objectContaining({
          onSuccess: expect.any(Function),
          onSettled: expect.any(Function),
        })
      );
    });
  });

  it("uses the selected loop snapshot when the table refetches before confirm", async () => {
    const selectedLoop = createMockLoopWithUser({
      id: "loop-001",
      status: LoopStatus.Running,
    });
    vi.mocked(useLoops).mockReturnValue({
      data: [selectedLoop],
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoops>);

    const { rerender } = render(<LoopsTable />);

    fireEvent.click(screen.getByRole("button", { name: "Stop loop" }));
    vi.mocked(useLoops).mockReturnValue({
      data: [] as (typeof selectedLoop)[],
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoops>);
    rerender(<LoopsTable />);

    fireEvent.click(await screen.findByRole("button", { name: "Stop Loop" }));

    await waitFor(() => {
      expect(mockCancelMutate).toHaveBeenCalledWith(
        {
          id: "loop-001",
          computeTargetId: null,
        },
        expect.objectContaining({
          onSuccess: expect.any(Function),
          onSettled: expect.any(Function),
        })
      );
    });
  });
});
