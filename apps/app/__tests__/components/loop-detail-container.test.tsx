/**
 * Unit tests for LoopDetailContainer component.
 * Focuses on the restart button: visibility based on loop status and navigation on success.
 */

import { LoopErrorCode, LoopStatus } from "@repo/api/src/types/loop";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMutateAsync = vi.fn();
const mockCancelMutateAsync = vi.fn();
const mockMutate = vi.fn();
const mockCancelMutate = vi.fn();
const mockPush = vi.fn();

const RESTART_BUTTON_NAME = /restart/i;
const CANCEL_BUTTON_NAME = /cancel/i;
const USER_FULL_NAME = /Alice Smith/;
const USER_ID = /user-1/;
const MIKES_MACBOOK = /Mikes-MacBook/;
const ONLINE = /online/;
const TARGET_CLOUD = /Target: Cloud/;
const TARGET_LABEL = /Target:/;
const CACHE_WRITE = /cache write/i;
const CACHE_READ = /cache read/i;
const NO_OUTPUT_PRODUCED = /No output produced/;
const NO_WORK_PRODUCED_RAW = /NO_WORK_PRODUCED/;
const CLAUDE_RATE_LIMIT_ERROR = /^Claude rate limit reached$/;
const CLAUDE_RATE_LIMIT_MESSAGE =
  /Claude was rate limited before the runner completed\./;
const ERROR_LABEL = /^Error:/;
const ARTIFACTS_TAB_NAME = /Artifacts/i;
const SUPPORT_CLAUDE_OUTPUT_LINK = /claude-output\.jsonl/i;
const SUPPORT_PERF_LINK = /perf\.jsonl/i;

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
    mutate: mockMutate,
    mutateAsync: mockMutateAsync,
    isPending: false,
  })),
  useCancelLoop: vi.fn(() => ({
    mutate: mockCancelMutate,
    mutateAsync: mockCancelMutateAsync,
    isPending: false,
  })),
  useLoopEventsPaginated: vi.fn(() => ({ data: null })),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/analytics/client", () => ({ useFeatureFlag: vi.fn() }));

vi.mock("@/hooks/queries/use-documents", () => ({
  useDocument: vi.fn(() => ({ data: null })),
}));

// Mock heavy sub-components that would require extra providers or network calls
vi.mock("@/components/loops/loop-progress-panel", () => ({
  LoopProgressPanel: () => <div data-testid="loop-progress-panel" />,
}));

vi.mock("@/components/loops/loop-audit-log", () => ({
  LoopAuditLog: () => <div data-testid="loop-audit-log" />,
}));

import { useFeatureFlag } from "@repo/analytics/client";
import { LoopDetailContainer } from "@/app/(authenticated)/loops/[id]/loop-detail-container";
// Import after mocks
import {
  useCancelLoop,
  useLoop,
  useLoopEventsPaginated,
  useResumeLoop,
} from "@/hooks/queries/use-loops";
import {
  createMockLoopWithUser,
  RUNNER_RATE_LIMIT_LOOP_ERROR,
} from "../fixtures/loops";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LoopDetailContainer — restart button visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useResumeLoop).mockReturnValue({
      mutate: mockMutate,
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
    mockMutate.mockImplementation((_, opts) =>
      opts?.onSuccess?.({ loopId: "new-loop-999", status: LoopStatus.Pending })
    );
    vi.mocked(useResumeLoop).mockReturnValue({
      mutate: mockMutate,
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
    render(<LoopDetailContainer id="loop-001" />);

    fireEvent.click(screen.getByRole("button", { name: RESTART_BUTTON_NAME }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/loops/new-loop-999");
    });
  });

  it("does not navigate to the original loop id after restart", async () => {
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
      mutate: mockCancelMutate,
      mutateAsync: mockCancelMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useCancelLoop>);
    vi.mocked(useResumeLoop).mockReturnValue({
      mutate: mockMutate,
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
      mutate: mockMutate,
      mutateAsync: mockMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useResumeLoop>);
    vi.mocked(useCancelLoop).mockReturnValue({
      mutate: mockCancelMutate,
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
    mockCancelMutate.mockImplementation((_, opts) => opts?.onSuccess?.());
    vi.mocked(useCancelLoop).mockReturnValue({
      mutate: mockCancelMutate,
      mutateAsync: mockCancelMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useCancelLoop>);
    vi.mocked(useResumeLoop).mockReturnValue({
      mutate: mockMutate,
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

  it("calls mutate with the loop id after confirming the stop dialog", async () => {
    render(<LoopDetailContainer id="loop-001" />);

    fireEvent.click(screen.getByRole("button", { name: CANCEL_BUTTON_NAME }));

    const confirmButton = await screen.findByRole("button", {
      name: "Stop Loop",
    });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(mockCancelMutate).toHaveBeenCalledWith(
        "loop-001",
        expect.any(Object)
      );
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
      expect(mockCancelMutate).toHaveBeenCalled();
    });

    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe("LoopDetailContainer — cache token display", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useResumeLoop).mockReturnValue({
      mutate: mockMutate,
      mutateAsync: mockMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useResumeLoop>);
    vi.mocked(useCancelLoop).mockReturnValue({
      mutate: mockCancelMutate,
      mutateAsync: mockCancelMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useCancelLoop>);
  });

  it("shows cache write/read summary when tokensByModel has cacheCreation and cacheRead data", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        status: LoopStatus.Completed,
        tokensInput: 50_000,
        tokensOutput: 30_000,
        tokensByModel: {
          "claude-sonnet-4-5": {
            input: 50_000,
            output: 30_000,
            cacheCreation: 5000,
            cacheRead: 2000,
          },
        },
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-001" />);

    expect(screen.getByText(CACHE_WRITE)).toBeInTheDocument();
    expect(screen.getByText(CACHE_READ)).toBeInTheDocument();
  });

  it("does not show cache summary when cacheCreation and cacheRead are zero", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        status: LoopStatus.Completed,
        tokensInput: 50_000,
        tokensOutput: 30_000,
        tokensByModel: {
          "claude-sonnet-4-5": {
            input: 50_000,
            output: 30_000,
            cacheCreation: 0,
            cacheRead: 0,
          },
        },
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-001" />);

    expect(screen.queryByText(CACHE_WRITE)).not.toBeInTheDocument();
  });

  it("does not show cache summary when tokensByModel is null", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        status: LoopStatus.Completed,
        tokensInput: 10_000,
        tokensOutput: 5000,
        tokensByModel: null,
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-001" />);

    expect(screen.queryByText(CACHE_WRITE)).not.toBeInTheDocument();
  });

  it("headline shows in/out when cache data is present", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        status: LoopStatus.Completed,
        tokensInput: 10_000,
        tokensOutput: 5000,
        tokensByModel: {
          "claude-sonnet-4-5": {
            input: 10_000,
            output: 5000,
            cacheCreation: 8000,
            cacheRead: 3000,
          },
        },
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-001" />);

    // Stacked layout: Input and Output shown as separate labeled values
    expect(screen.getByText("10.0k")).toBeInTheDocument();
    expect(screen.getByText("5.0k")).toBeInTheDocument();
    // "effective" label and effective total should be absent
    expect(screen.queryByText("effective")).not.toBeInTheDocument();
    expect(screen.queryByText("~23.3k")).not.toBeInTheDocument();
  });

  it("cache-only case: input=0, output=0, cacheRead>0 still renders cache summary", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        status: LoopStatus.Completed,
        tokensInput: 0,
        tokensOutput: 0,
        tokensByModel: {
          default: {
            input: 0,
            output: 0,
            cacheCreation: 0,
            cacheRead: 4000,
          },
        },
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-001" />);

    // Should show "-" when input and output are both 0
    expect(screen.getByText("-")).toBeInTheDocument();
    // Cache summary should still render
    expect(screen.getByText(CACHE_READ)).toBeInTheDocument();
  });

  it("headline abbreviates large numbers (formatTokenCount)", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        status: LoopStatus.Completed,
        tokensInput: 15_000_000,
        tokensOutput: 2800,
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-001" />);

    // Stacked layout: large numbers abbreviated
    expect(screen.getByText("15.0M")).toBeInTheDocument();
    expect(screen.getByText("2.8k")).toBeInTheDocument();
  });

  it("default key is filtered from ModelTokenBreakdown (no model row rendered for it)", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        status: LoopStatus.Completed,
        tokensInput: 10_000,
        tokensOutput: 5000,
        tokensByModel: {
          default: {
            input: 10_000,
            output: 5000,
            cacheCreation: 2000,
            cacheRead: 500,
          },
        },
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-001" />);

    // The "Default" model row must not be rendered in the per-model breakdown
    // (the "default" key is a synthetic fallback, not a real model name)
    expect(screen.queryByText("Default")).not.toBeInTheDocument();
    // But the cache summary in MetadataCards still shows (from all tokensByModel values)
    expect(screen.getByText(CACHE_WRITE)).toBeInTheDocument();
  });
});

describe("LoopDetailContainer -- NO_WORK_PRODUCED label rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useResumeLoop).mockReturnValue({
      mutate: mockMutate,
      mutateAsync: mockMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useResumeLoop>);
    vi.mocked(useCancelLoop).mockReturnValue({
      mutate: mockCancelMutate,
      mutateAsync: mockCancelMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useCancelLoop>);
  });

  it("renders 'No output produced' for FAILED loop with NO_WORK_PRODUCED error when flag is enabled", () => {
    vi.mocked(useFeatureFlag).mockReturnValue({
      key: "ghost-loop-ux",
      enabled: true,
      variant: undefined,
      payload: undefined,
    });
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        status: LoopStatus.Failed,
        error: {
          code: LoopErrorCode.NoWorkProduced,
          message: "The loop produced no output.",
        },
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-001" />);

    expect(screen.getByText(NO_OUTPUT_PRODUCED)).toBeInTheDocument();
  });

  it("does not render 'No output produced' for FAILED loop with CONTEXT_LIMIT_EXCEEDED error when flag is enabled", () => {
    vi.mocked(useFeatureFlag).mockReturnValue({
      key: "ghost-loop-ux",
      enabled: true,
      variant: undefined,
      payload: undefined,
    });
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        status: LoopStatus.Failed,
        error: {
          code: LoopErrorCode.ContextLimitExceeded,
          message: "Context window exceeded.",
        },
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-002" />);

    expect(screen.queryByText(NO_OUTPUT_PRODUCED)).not.toBeInTheDocument();
  });

  it("renders no error label block when FAILED loop has no error", () => {
    vi.mocked(useFeatureFlag).mockReturnValue({
      key: "ghost-loop-ux",
      enabled: true,
      variant: undefined,
      payload: undefined,
    });
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        status: LoopStatus.Failed,
        error: null,
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-003" />);

    expect(screen.queryByText(NO_OUTPUT_PRODUCED)).not.toBeInTheDocument();
    expect(screen.queryByText(ERROR_LABEL)).not.toBeInTheDocument();
  });

  it("renders runner failure reason from result subcode when flag is disabled", () => {
    vi.mocked(useFeatureFlag).mockReturnValue({
      key: "ghost-loop-ux",
      enabled: false,
      variant: undefined,
      payload: undefined,
    });
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        status: LoopStatus.Failed,
        error: RUNNER_RATE_LIMIT_LOOP_ERROR,
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-runner-error" />);

    expect(screen.getByText(CLAUDE_RATE_LIMIT_ERROR)).toBeInTheDocument();
    expect(screen.getByText(CLAUDE_RATE_LIMIT_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText("RUNNER_ERROR")).not.toBeInTheDocument();
  });

  it("renders friendly 'No output produced' copy and preserves raw details when flag is disabled", () => {
    vi.mocked(useFeatureFlag).mockReturnValue({
      key: "ghost-loop-ux",
      enabled: false,
      variant: undefined,
      payload: undefined,
    });
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        status: LoopStatus.Failed,
        error: {
          code: LoopErrorCode.NoWorkProduced,
          message: "The loop produced no output.",
        },
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-004" />);

    expect(screen.getByText(NO_OUTPUT_PRODUCED)).toBeInTheDocument();
    expect(screen.getByText(NO_WORK_PRODUCED_RAW)).toBeInTheDocument();
  });
});

describe("LoopDetailContainer — additional repositories display", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useResumeLoop).mockReturnValue({
      mutate: mockMutate,
      mutateAsync: mockMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useResumeLoop>);
    vi.mocked(useCancelLoop).mockReturnValue({
      mutate: mockCancelMutate,
      mutateAsync: mockCancelMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useCancelLoop>);
  });

  it("renders each additional repo fullName and branch when additionalRepos is non-empty", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        status: LoopStatus.Completed,
        additionalRepos: [
          { fullName: "org/repo-alpha", branch: "main" },
          { fullName: "org/repo-beta", branch: "develop" },
        ],
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-001" />);

    expect(screen.getByText("org/repo-alpha")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("org/repo-beta")).toBeInTheDocument();
    expect(screen.getByText("develop")).toBeInTheDocument();
  });

  it("does not render additional repositories card when additionalRepos is null", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        status: LoopStatus.Completed,
        additionalRepos: null,
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-002" />);

    expect(
      screen.queryByText("Additional Repositories")
    ).not.toBeInTheDocument();
  });
});

describe("LoopDetailContainer -- diagnostics UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useResumeLoop).mockReturnValue({
      mutate: mockMutate,
      mutateAsync: mockMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useResumeLoop>);
    vi.mocked(useCancelLoop).mockReturnValue({
      mutate: mockCancelMutate,
      mutateAsync: mockCancelMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useCancelLoop>);
  });

  it("renders logTail content in diagnostics block when ghostLoopUx is enabled and loop is failed", () => {
    vi.mocked(useFeatureFlag).mockReturnValue({
      key: "ghost-loop-ux",
      enabled: true,
      variant: undefined,
      payload: undefined,
    });
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        status: LoopStatus.Failed,
        error: { code: LoopErrorCode.NoWorkProduced, message: "No output." },
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);
    vi.mocked(useLoopEventsPaginated).mockReturnValue({
      data: {
        data: [
          {
            type: "error",
            code: LoopErrorCode.NoWorkProduced,
            message: "No output.",
            timestamp: "2024-01-01T00:00:00Z",
            logTail: "stderr output here",
          },
        ],
        total: 1,
      },
    } as unknown as ReturnType<typeof useLoopEventsPaginated>);

    render(<LoopDetailContainer id="loop-001" />);

    expect(screen.getByText("stderr output here")).toBeInTheDocument();
  });
});

describe("LoopDetailContainer -- support artifacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useResumeLoop).mockReturnValue({
      mutate: mockMutate,
      mutateAsync: mockMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useResumeLoop>);
    vi.mocked(useCancelLoop).mockReturnValue({
      mutate: mockCancelMutate,
      mutateAsync: mockCancelMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useCancelLoop>);
  });

  it("renders an empty state under the Artifacts tab when there are no support artifacts", async () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({ supportArtifacts: [] } as never),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-001" />);

    expect(screen.queryByText("Support Artifacts")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: ARTIFACTS_TAB_NAME })
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("tab", { name: ARTIFACTS_TAB_NAME })
    );

    expect(
      screen.getByText("No support artifacts uploaded")
    ).toBeInTheDocument();
    expect(
      screen.getByText("This loop did not produce support artifacts.")
    ).toBeInTheDocument();
  });

  it("renders support artifact download links under the Artifacts tab", async () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        supportArtifacts: [
          {
            name: "claude-output.jsonl",
            key: "org-1/loops/loop-1/run-1/support/claude-output.jsonl",
            downloadUrl: "https://download.example/claude",
            sizeBytes: 12,
          },
          {
            name: "perf.jsonl",
            key: "org-1/loops/loop-1/run-1/support/perf.jsonl",
            downloadUrl: "https://download.example/perf",
            sizeBytes: 34,
          },
        ],
      } as never),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-001" />);

    expect(
      screen.queryByRole("link", { name: SUPPORT_CLAUDE_OUTPUT_LINK })
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("tab", { name: ARTIFACTS_TAB_NAME })
    );

    expect(screen.getByText("Support Artifacts")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: SUPPORT_CLAUDE_OUTPUT_LINK })
    ).toHaveAttribute("href", "https://download.example/claude");
    expect(
      screen.getByRole("link", { name: SUPPORT_PERF_LINK })
    ).toHaveAttribute("href", "https://download.example/perf");
  });
});
