/**
 * How a loop's ERROR renders on the loop detail page: the friendly-error copy
 * for each error code, the raw technical details behind it, and the
 * `ghost-loop-ux` recovery affordance that a FAILED loop arms.
 *
 * Split out of `loop-detail-container.test.tsx` (ISS-5711) so the error-render
 * concern owns its own file rather than growing the container suite further.
 */
/**
 * Unit tests for LoopDetailContainer component.
 * Focuses on the restart button: visibility based on loop status and navigation on success.
 */

import { DESKTOP_SIGNED_LAUNCH_MANAGED_KEY_ERROR_MESSAGE } from "@repo/api/src/types/friendly-error";
import { LoopErrorCode, LoopStatus } from "@repo/api/src/types/loop";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMutateAsync = vi.fn();
const mockCancelMutateAsync = vi.fn();
const mockMutate = vi.fn();
const mockCancelMutate = vi.fn();
const mockPush = vi.fn();
const mockUseFeatureFlagEnabled = vi.fn();

const NO_OUTPUT_PRODUCED = /No output produced/;
const NO_WORK_PRODUCED_RAW = /NO_WORK_PRODUCED/;
const CLAUDE_RATE_LIMIT_ERROR = /^Claude rate limit reached$/;
const CLAUDE_RATE_LIMIT_MESSAGE =
  /Claude was rate limited before the runner completed\./;
const UNKNOWN_SKILL_ERROR = /^Closedloop plugin command unavailable$/;
const UNKNOWN_SKILL_MESSAGE =
  /Claude could not find the required Closedloop plugin command for this loop\./;
const GENERIC_RUNNER_ERROR = /^Runner failed$/;
const COMMAND_FAILED_EXACT = /^Command failed$/;
const ERROR_LABEL = /^Error:/;
const LAUNCH_FAILED_TITLE = /^The run could not be started$/;
const LAUNCH_FAILED_MESSAGE =
  "The run failed while being prepared and never started.";
const UNKNOWN_CODE_RAW = /SOME_FUTURE_CODE/;
const GENERIC_FAILED_LABEL = /^Failed$/;

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: mockPush, replace: vi.fn() })),
  usePathname: vi.fn(() => "/loops/loop-001"),
  useParams: vi.fn(() => ({ orgSlug: "test-org" })),
  useSearchParams: vi.fn(
    () =>
      new URLSearchParams() as unknown as ReturnType<
        typeof import("next/navigation").useSearchParams
      >
  ),
}));

vi.mock("@repo/app/loops/hooks/use-loops", () => ({
  useLoop: vi.fn(),
  useResumeLoop: vi.fn(() => ({
    mutate: mockMutate,
    mutateAsync: mockMutateAsync,
    isPending: false,
  })),
  useLoopEventsPaginated: vi.fn(() => ({ data: null })),
}));

vi.mock("@/hooks/queries/use-loops", () => ({
  useCancelLoop: vi.fn(() => ({
    mutate: mockCancelMutate,
    mutateAsync: mockCancelMutateAsync,
    isPending: false,
  })),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: vi.fn(),
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => mockUseFeatureFlagEnabled(key),
}));

vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useDocument: vi.fn(() => ({ data: null })),
}));

// The container renders the breadcrumb Header (needs a SidebarProvider) and
// reads useOrgSlug() (needs Clerk) since FEA-3979 — stub both. This suite only
// needs the container to mount; the colocated breadcrumb suite asserts labels.
vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: ({ children }: { children?: ReactNode }) => <nav>{children}</nav>,
}));

vi.mock("@/hooks/use-org-slug", () => ({ useOrgSlug: () => "test-org" }));

// Mock heavy sub-components that would require extra providers or network calls
vi.mock("@repo/app/loops/components/loop-progress-panel", () => ({
  LoopProgressPanel: () => <div data-testid="loop-progress-panel" />,
}));

vi.mock("@repo/app/loops/components/loop-audit-log", () => ({
  LoopAuditLog: () => <div data-testid="loop-audit-log" />,
}));

import { useFeatureFlag } from "@repo/analytics/client";
// Import after mocks
import {
  useLoop,
  useLoopEventsPaginated,
  useResumeLoop,
} from "@repo/app/loops/hooks/use-loops";
import {
  createMockLoopWithUser,
  RUNNER_RATE_LIMIT_LOOP_ERROR,
  RUNNER_UNKNOWN_SKILL_LOOP_ERROR,
} from "@repo/app/shared/test-fixtures/loops";
import { LoopDetailContainer } from "@/app/(authenticated)/[orgSlug]/loops/[id]/loop-detail-container";
import { useCancelLoop } from "@/hooks/queries/use-loops";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockUseFeatureFlagEnabled.mockReturnValue(false);
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

  it("renders unknown-skill runner subcode with plugin guidance when flag is disabled", () => {
    vi.mocked(useFeatureFlag).mockReturnValue({
      key: "ghost-loop-ux",
      enabled: false,
      variant: undefined,
      payload: undefined,
    });
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        status: LoopStatus.Failed,
        error: RUNNER_UNKNOWN_SKILL_LOOP_ERROR,
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-unknown-skill" />);

    expect(screen.getByText(UNKNOWN_SKILL_ERROR)).toBeInTheDocument();
    expect(screen.getByText(UNKNOWN_SKILL_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText("RUNNER_ERROR")).not.toBeInTheDocument();
    expect(screen.queryByText(GENERIC_RUNNER_ERROR)).not.toBeInTheDocument();
  });

  it("renders desktop managed-key fail-fast remediation as visible error copy", () => {
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
          code: LoopErrorCode.ProcessFailed,
          message: DESKTOP_SIGNED_LAUNCH_MANAGED_KEY_ERROR_MESSAGE,
        },
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-managed-key-error" />);

    expect(
      screen.getByText("Desktop managed signing is not ready")
    ).toBeInTheDocument();
    expect(
      screen.getByText(DESKTOP_SIGNED_LAUNCH_MANAGED_KEY_ERROR_MESSAGE)
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Re-run managed onboarding on the selected desktop target."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(COMMAND_FAILED_EXACT)).not.toBeInTheDocument();
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

/**
 * ISS-5711: a loop whose launch failed used to be persisted as CANCELLED with a
 * null error column, so this page told the user they had cancelled their own
 * run and the `ghost-loop-ux` recovery affordance -- gated on
 * `LoopStatus.Failed` -- never armed. Recording the launch failure as FAILED
 * with a LAUNCH_FAILED error is what turns the affordance on; these tests pin
 * both the new shape and the old one it replaced.
 */
describe("LoopDetailContainer -- launch failure recovery affordance", () => {
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
    vi.mocked(useFeatureFlag).mockReturnValue({
      key: "ghost-loop-ux",
      enabled: true,
      variant: undefined,
      payload: undefined,
    });
    // The status badge reads `ghost-loop-ux` through the `@repo/app` feature-flag
    // port, not through `@repo/analytics`. Both resolve the same PostHog flag in
    // production (apps/app mounts the adapter provider), but they are separate
    // mocks here, so this block has to enable both.
    mockUseFeatureFlagEnabled.mockReturnValue(true);
  });

  it("arms the recovery diagnostics fetch and renders LAUNCH_FAILED copy for a failed launch", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        status: LoopStatus.Failed,
        error: {
          code: LoopErrorCode.LaunchFailed,
          message: LAUNCH_FAILED_MESSAGE,
        },
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-launch-failed" />);

    // The title now appears in two places -- the friendly-error alert and the
    // status badge (see the badge test below) -- so assert on all of them.
    expect(screen.getAllByText(LAUNCH_FAILED_TITLE).length).toBeGreaterThan(0);
    expect(vi.mocked(useLoopEventsPaginated)).toHaveBeenCalledWith(
      "loop-launch-failed",
      expect.objectContaining({ type: "error" }),
      { enabled: true }
    );
  });

  // ISS-5711: the status card is the first thing on this page, and until the
  // container actually passed `loop.error?.code` down it rendered a bare
  // "Failed" -- the launch-specific badge path existed but no production mount
  // could reach it. Asserted through the container, not by rendering the badge
  // directly with props the product never supplies.
  it("shows launch-failure copy on the status badge instead of a generic Failed", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        status: LoopStatus.Failed,
        error: {
          code: LoopErrorCode.LaunchFailed,
          message: LAUNCH_FAILED_MESSAGE,
        },
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-launch-failed" />);

    // Exactly one of the LAUNCH_FAILED titles is the status badge, identified
    // by the badge's failure tone rather than by DOM position.
    const badge = screen
      .getAllByText(LAUNCH_FAILED_TITLE)
      .find((element) => element.className.includes("bg-destructive/10"));
    expect(badge).toBeDefined();

    // The generic status label must be gone, or the wiring did nothing.
    expect(screen.queryByText(GENERIC_FAILED_LABEL)).not.toBeInTheDocument();
  });

  // Positive control for the negative assertion above: a FAILED loop with no
  // persisted error code still renders the generic label, so `queryByText`
  // above is actually capable of finding it.
  it("still shows the generic Failed badge when no error code was persisted", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        status: LoopStatus.Failed,
        error: null,
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-failed-no-code" />);

    expect(screen.getByText(GENERIC_FAILED_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(LAUNCH_FAILED_TITLE)).not.toBeInTheDocument();
  });

  it("leaves the recovery affordance disarmed for a genuine user cancellation", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        status: LoopStatus.Cancelled,
        error: null,
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-cancelled" />);

    expect(screen.queryByText(LAUNCH_FAILED_TITLE)).not.toBeInTheDocument();
    expect(vi.mocked(useLoopEventsPaginated)).toHaveBeenCalledWith(
      "loop-cancelled",
      expect.objectContaining({ type: "error" }),
      { enabled: false }
    );
  });

  it("degrades to generic failure copy for an unknown error code from a newer producer", () => {
    vi.mocked(useLoop).mockReturnValue({
      data: createMockLoopWithUser({
        status: LoopStatus.Failed,
        error: {
          code: "SOME_FUTURE_CODE" as LoopErrorCode,
          message: "Something the current client has never heard of.",
        },
      }),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useLoop>);

    render(<LoopDetailContainer id="loop-unknown-code" />);

    expect(screen.queryByText(LAUNCH_FAILED_TITLE)).not.toBeInTheDocument();
    expect(screen.getByText(UNKNOWN_CODE_RAW)).toBeInTheDocument();
  });
});
