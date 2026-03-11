/**
 * Unit tests for LoopsTable component.
 * Focuses on the restart button row action: when it renders and what it does on click.
 */

import { LoopStatus } from "@repo/api/src/types/loop";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Must be declared before vi.mock factories reference them
const mockMutateAsync = vi.fn();
const mockCancelMutateAsync = vi.fn();
const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: mockPush, replace: vi.fn() })),
  usePathname: vi.fn(() => "/loops"),
  useSearchParams: vi.fn(
    () =>
      new URLSearchParams() as unknown as ReturnType<
        typeof import("next/navigation").useSearchParams
      >
  ),
}));

vi.mock("@/hooks/queries/use-loops", () => ({
  useLoops: vi.fn(() => ({ data: [], isLoading: false, error: null })),
  useResumeLoop: vi.fn(() => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
  })),
  useCancelLoop: vi.fn(() => ({
    mutateAsync: mockCancelMutateAsync,
    isPending: false,
  })),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { LoopsTable } from "@/app/(authenticated)/loops/components/loops-table";
// Import after mocks
import { useCancelLoop, useLoops, useResumeLoop } from "@/hooks/queries/use-loops";
import { createMockLoopWithUser } from "../fixtures/loops";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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

  it("does not render a restart button for a CANCELLED loop", () => {
    vi.mocked(useLoops).mockReturnValue({
      data: [createMockLoopWithUser({ status: LoopStatus.Cancelled })],
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

  it("navigates to the new loop id returned by the resume response", async () => {
    mockMutateAsync.mockResolvedValueOnce({
      loopId: "new-loop-999",
      status: LoopStatus.Pending,
    });

    render(<LoopsTable />);

    fireEvent.click(screen.getByRole("button", { name: "Restart loop" }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/loops/new-loop-999");
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

    expect(mockPush).not.toHaveBeenCalledWith("/loops/loop-001");
  });
});

describe("LoopsTable — cancel button visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useCancelLoop).mockReturnValue({
      mutateAsync: mockCancelMutateAsync,
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
      screen.getByRole("button", { name: "Cancel loop" })
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
      screen.getByRole("button", { name: "Cancel loop" })
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
      screen.getByRole("button", { name: "Cancel loop" })
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
      screen.queryByRole("button", { name: "Cancel loop" })
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
      screen.queryByRole("button", { name: "Cancel loop" })
    ).not.toBeInTheDocument();
  });
});

describe("LoopsTable — cancel button interaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCancelMutateAsync.mockResolvedValue({});
    vi.mocked(useCancelLoop).mockReturnValue({
      mutateAsync: mockCancelMutateAsync,
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

  it("calls mutateAsync with the loop id when the cancel button is clicked", async () => {
    render(<LoopsTable />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel loop" }));

    await waitFor(() => {
      expect(mockCancelMutateAsync).toHaveBeenCalledWith("loop-001");
    });
  });
});
