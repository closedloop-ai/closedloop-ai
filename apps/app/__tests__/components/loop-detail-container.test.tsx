/**
 * Unit tests for LoopDetailContainer component.
 * Focuses on the restart button: visibility based on loop status and navigation on success.
 */

import { LoopStatus } from "@repo/api/src/types/loop";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMutateAsync = vi.fn();
const mockCancelMutateAsync = vi.fn();
const mockPush = vi.fn();

const RESTART_BUTTON_NAME = /restart/i;
const CANCEL_BUTTON_NAME = /cancel/i;
const USER_FULL_NAME = /Alice Smith/;
const USER_ID = /user-1/;
const MIKES_MACBOOK = /Mikes-MacBook/;
const ONLINE = /online/;
const TARGET_CLOUD = /Target: Cloud/;
const TARGET_LABEL = /Target:/;

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: mockPush, replace: vi.fn() })),
  usePathname: vi.fn(() => "/loops/loop-001"),
  useSearchParams: vi.fn(
    () =>
      new URLSearchParams() as unknown as ReturnType<
        typeof import("next/navigation").useSearchParams
      >
  ),
}));

vi.mock("@/hooks/queries/use-loops", () => ({
  useLoop: vi.fn(),
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

vi.mock("@/hooks/queries/use-artifacts", () => ({
  useArtifact: vi.fn(() => ({ data: null })),
}));

// Mock heavy sub-components that would require extra providers or network calls
vi.mock("@/components/loops/loop-progress-panel", () => ({
  LoopProgressPanel: () => <div data-testid="loop-progress-panel" />,
}));

vi.mock("@/components/loops/loop-audit-log", () => ({
  LoopAuditLog: () => <div data-testid="loop-audit-log" />,
}));

import { LoopDetailContainer } from "@/app/(authenticated)/loops/[id]/loop-detail-container";
// Import after mocks
import {
  useCancelLoop,
  useLoop,
  useResumeLoop,
} from "@/hooks/queries/use-loops";
import { createMockLoopWithUser } from "../fixtures/loops";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LoopDetailContainer — restart button visibility", () => {
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

  it("renders the restart button for a FAILED loop", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({ status: LoopStatus.Failed }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-001" />);

    expect(
      screen.getByRole("button", { name: RESTART_BUTTON_NAME })
    ).toBeInTheDocument();
  });

  it("renders the restart button for a TIMED_OUT loop", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({ status: LoopStatus.TimedOut }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-002" />);

    expect(
      screen.getByRole("button", { name: RESTART_BUTTON_NAME })
    ).toBeInTheDocument();
  });

  it("renders the restart button for a CANCELLED loop", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({ status: LoopStatus.Cancelled }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-006" />);

    expect(
      screen.getByRole("button", { name: RESTART_BUTTON_NAME })
    ).toBeInTheDocument();
  });

  it("does not render the restart button for a COMPLETED loop", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({ status: LoopStatus.Completed }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-003" />);

    expect(
      screen.queryByRole("button", { name: RESTART_BUTTON_NAME })
    ).not.toBeInTheDocument();
  });

  it("does not render the restart button for a RUNNING loop", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({ status: LoopStatus.Running }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-004" />);

    expect(
      screen.queryByRole("button", { name: RESTART_BUTTON_NAME })
    ).not.toBeInTheDocument();
  });

  it("does not render the restart button for a PENDING loop", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({ status: LoopStatus.Pending }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-005" />);

    expect(
      screen.queryByRole("button", { name: RESTART_BUTTON_NAME })
    ).not.toBeInTheDocument();
  });

  it("displays user name instead of user ID", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        status: LoopStatus.Failed,
        user: {
          id: "user-1",
          firstName: "Alice",
          lastName: "Smith",
          avatarUrl: null,
          email: "alice@example.com",
        },
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-006" />);

    expect(screen.getByText(USER_FULL_NAME)).toBeInTheDocument();
    expect(screen.queryByText(USER_ID)).not.toBeInTheDocument();
  });
});

describe("LoopDetailContainer — restart button interaction", () => {
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
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        id: "loop-001",
        status: LoopStatus.Failed,
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);
  });

  it("navigates to the new loop id returned by the resume response", async () => {
    mockMutateAsync.mockResolvedValueOnce({
      loopId: "new-loop-999",
      status: LoopStatus.Pending,
    });

    render(<LoopDetailContainer id="loop-001" />);

    fireEvent.click(screen.getByRole("button", { name: RESTART_BUTTON_NAME }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/loops/new-loop-999");
    });
  });

  it("does not navigate to the original loop id after restart", async () => {
    mockMutateAsync.mockResolvedValueOnce({
      loopId: "new-loop-999",
      status: LoopStatus.Pending,
    });

    render(<LoopDetailContainer id="loop-001" />);

    fireEvent.click(screen.getByRole("button", { name: RESTART_BUTTON_NAME }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalled();
    });

    expect(mockPush).not.toHaveBeenCalledWith("/loops/loop-001");
  });
});

describe("LoopDetailContainer — cancel button visibility", () => {
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

  it("renders the cancel button for a RUNNING loop", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({ status: LoopStatus.Running }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-001" />);

    expect(
      screen.getByRole("button", { name: CANCEL_BUTTON_NAME })
    ).toBeInTheDocument();
  });

  it("renders the cancel button for a PENDING loop", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({ status: LoopStatus.Pending }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-002" />);

    expect(
      screen.getByRole("button", { name: CANCEL_BUTTON_NAME })
    ).toBeInTheDocument();
  });

  it("does not render the cancel button for a COMPLETED loop", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({ status: LoopStatus.Completed }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-003" />);

    expect(
      screen.queryByRole("button", { name: CANCEL_BUTTON_NAME })
    ).not.toBeInTheDocument();
  });

  it("does not render the cancel button for a FAILED loop", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({ status: LoopStatus.Failed }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-004" />);

    expect(
      screen.queryByRole("button", { name: CANCEL_BUTTON_NAME })
    ).not.toBeInTheDocument();
  });
});

describe("LoopDetailContainer — compute target display", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useResumeLoop).mockReturnValue({
      mutateAsync: mockMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useResumeLoop>);
    vi.mocked(useCancelLoop).mockReturnValue({
      mutateAsync: mockCancelMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useCancelLoop>);
  });

  it("displays machine name and online status for a local loop", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        status: LoopStatus.Running,
        computeTarget: {
          id: "ct-1",
          machineName: "Mikes-MacBook",
          isOnline: true,
        },
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-001" />);

    expect(screen.getByText(MIKES_MACBOOK)).toBeInTheDocument();
    expect(screen.getByText(ONLINE)).toBeInTheDocument();
  });

  it("displays 'Cloud' for a cloud loop with containerId", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        status: LoopStatus.Completed,
        containerId: "arn:aws:ecs:us-east-1:123:task/abc",
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-002" />);

    expect(screen.getByText(TARGET_CLOUD)).toBeInTheDocument();
  });

  it("does not display compute target for unknown (neither set)", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        status: LoopStatus.Completed,
        containerId: null,
        computeTarget: null,
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-003" />);

    expect(screen.queryByText(TARGET_LABEL)).not.toBeInTheDocument();
  });
});

describe("LoopDetailContainer — cancel button interaction", () => {
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
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        id: "loop-001",
        status: LoopStatus.Running,
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);
  });

  it("calls mutateAsync with the loop id after confirming the stop dialog", async () => {
    render(<LoopDetailContainer id="loop-001" />);

    fireEvent.click(screen.getByRole("button", { name: CANCEL_BUTTON_NAME }));

    const confirmButton = await screen.findByRole("button", {
      name: "Stop Loop",
    });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(mockCancelMutateAsync).toHaveBeenCalledWith("loop-001");
    });
  });

  it("does not navigate away after cancellation", async () => {
    render(<LoopDetailContainer id="loop-001" />);

    fireEvent.click(screen.getByRole("button", { name: CANCEL_BUTTON_NAME }));

    const confirmButton = await screen.findByRole("button", {
      name: "Stop Loop",
    });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(mockCancelMutateAsync).toHaveBeenCalled();
    });

    expect(mockPush).not.toHaveBeenCalled();
  });
});
