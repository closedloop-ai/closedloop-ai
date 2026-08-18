/**
 * LoopDetailContainer — diagnostics block and support-artifacts tab.
 *
 * Split out of the grandfathered `apps/app/__tests__/components/
 * loop-detail-container.test.tsx` (FEA-3979) to keep that file shrinking: these
 * two suites are self-contained and only touch the diagnostics `logTail` render
 * and the Artifacts tab, so they carry their own minimal mock stack here.
 */

import { LoopErrorCode, LoopStatus } from "@repo/api/src/types/loop";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMutate = vi.fn();
const mockCancelMutate = vi.fn();
const mockUseFeatureFlagEnabled = vi.fn();

const ARTIFACTS_TAB_NAME = /Artifacts/i;
const SUPPORT_CLAUDE_OUTPUT_LINK = /claude-output\.jsonl/i;
const SUPPORT_PERF_LINK = /perf\.jsonl/i;

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
  usePathname: vi.fn(() => "/test-org/loops/loop-001"),
  useParams: vi.fn(() => ({ orgSlug: "test-org" })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock("@repo/app/loops/hooks/use-loops", () => ({
  useLoop: vi.fn(),
  useResumeLoop: vi.fn(() => ({ mutate: mockMutate, isPending: false })),
  useLoopEventsPaginated: vi.fn(() => ({ data: null })),
}));

vi.mock("@/hooks/queries/use-loops", () => ({
  useCancelLoop: vi.fn(() => ({ mutate: mockCancelMutate, isPending: false })),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/analytics/client", () => ({ useFeatureFlag: vi.fn() }));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => mockUseFeatureFlagEnabled(key),
}));

vi.mock("@repo/app/documents/hooks/use-documents", () => ({
  useDocument: vi.fn(() => ({ data: null })),
}));

vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: ({ children }: { children?: ReactNode }) => <nav>{children}</nav>,
}));

vi.mock("@/hooks/use-org-slug", () => ({ useOrgSlug: () => "test-org" }));

vi.mock("@repo/app/loops/components/loop-progress-panel", () => ({
  LoopProgressPanel: () => <div data-testid="loop-progress-panel" />,
}));

vi.mock("@repo/app/loops/components/loop-audit-log", () => ({
  LoopAuditLog: () => <div data-testid="loop-audit-log" />,
}));

import { useFeatureFlag } from "@repo/analytics/client";
// Import after mocks.
import {
  useLoop,
  useLoopEventsPaginated,
} from "@repo/app/loops/hooks/use-loops";
import { createMockLoopWithUser } from "@repo/app/shared/test-fixtures/loops";
import { LoopDetailContainer } from "../loop-detail-container";

beforeEach(() => {
  vi.clearAllMocks();
  mockUseFeatureFlagEnabled.mockReturnValue(false);
});

describe("LoopDetailContainer -- diagnostics UI", () => {
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
