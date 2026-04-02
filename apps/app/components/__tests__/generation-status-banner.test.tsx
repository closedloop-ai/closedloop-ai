import type { GenerationStatus } from "@repo/api/src/types/artifact";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Must mock before importing component
vi.mock("@/hooks/queries/use-artifacts", () => ({
  useArtifactGenerationStatus: vi.fn(),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Mock next/link to avoid router context requirements
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

import { toast } from "@repo/design-system/components/ui/sonner";
import { useArtifactGenerationStatus } from "@/hooks/queries/use-artifacts";
import {
  GenerationStatusBanner,
  toastedCorrelationIds,
} from "../generation-status-banner";

const RE_BG_DESTRUCTIVE = /bg-destructive/;

/** Builds a GenerationStatus object with sensible defaults. */
function makeStatus(
  overrides: Partial<GenerationStatus> & {
    status: GenerationStatus["status"];
  }
): GenerationStatus {
  return {
    command: "plan",
    htmlUrl: null,
    startedAt: null,
    completedAt: null,
    correlationId: "test-corr-1",
    ...overrides,
  };
}

/** Sets up the mock hook return value. */
function mockHook(data: GenerationStatus | undefined, isLoading = false): void {
  vi.mocked(useArtifactGenerationStatus).mockReturnValue({
    data,
    isLoading,
    refetch: vi.fn().mockResolvedValue(undefined),
    invalidateCache: vi.fn(),
  } as unknown as ReturnType<typeof useArtifactGenerationStatus>);
}

describe("GenerationStatusBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toastedCorrelationIds.clear();
  });

  // ---------------------------------------------------------------------------
  // Toast on SUCCESS transition
  // ---------------------------------------------------------------------------

  it("calls toast.success exactly once when generationStatus transitions to SUCCESS", () => {
    // Start with an active status
    mockHook(makeStatus({ status: "RUNNING", command: "plan" }));
    const { rerender } = render(
      <GenerationStatusBanner artifactId="artifact-1" />
    );

    expect(toast.success).not.toHaveBeenCalled();

    // Transition to SUCCESS
    mockHook(makeStatus({ status: "SUCCESS", command: "plan" }));
    rerender(<GenerationStatusBanner artifactId="artifact-1" />);

    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith(
      "Generation completed successfully"
    );
  });

  it("does not call toast.success again on subsequent re-renders with the same SUCCESS status", () => {
    // Start with an active status then transition to SUCCESS
    mockHook(makeStatus({ status: "RUNNING", command: "plan" }));
    const { rerender } = render(
      <GenerationStatusBanner artifactId="artifact-1" />
    );

    mockHook(makeStatus({ status: "SUCCESS", command: "plan" }));
    rerender(<GenerationStatusBanner artifactId="artifact-1" />);

    expect(toast.success).toHaveBeenCalledTimes(1);

    // Re-render again with the same SUCCESS status
    rerender(<GenerationStatusBanner artifactId="artifact-1" />);
    rerender(<GenerationStatusBanner artifactId="artifact-1" />);

    // Still only called once
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("does not fire toast again after unmount and remount (same correlationId)", () => {
    mockHook(makeStatus({ status: "RUNNING", command: "plan" }));
    const { rerender, unmount } = render(
      <GenerationStatusBanner artifactId="artifact-1" />
    );

    mockHook(makeStatus({ status: "SUCCESS", command: "plan" }));
    rerender(<GenerationStatusBanner artifactId="artifact-1" />);
    expect(toast.success).toHaveBeenCalledTimes(1);

    // Unmount and remount — simulates parent re-render from cache invalidation
    unmount();
    mockHook(makeStatus({ status: "SUCCESS", command: "plan" }));
    render(<GenerationStatusBanner artifactId="artifact-1" />);

    // Still only called once — module-level Set prevents duplicate
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("fires toast again for a new generation cycle on the same artifact (null correlationId)", () => {
    // First cycle: RUNNING → SUCCESS
    mockHook(makeStatus({ status: "RUNNING", command: "plan", correlationId: null as unknown as string }));
    const { rerender } = render(
      <GenerationStatusBanner artifactId="artifact-1" />
    );

    mockHook(makeStatus({ status: "SUCCESS", command: "plan", correlationId: null as unknown as string }));
    rerender(<GenerationStatusBanner artifactId="artifact-1" />);
    expect(toast.success).toHaveBeenCalledTimes(1);

    // Second cycle: back to RUNNING (clears the toast key) → SUCCESS again
    mockHook(makeStatus({ status: "RUNNING", command: "plan", correlationId: null as unknown as string }));
    rerender(<GenerationStatusBanner artifactId="artifact-1" />);

    mockHook(makeStatus({ status: "SUCCESS", command: "plan", correlationId: null as unknown as string }));
    rerender(<GenerationStatusBanner artifactId="artifact-1" />);

    // Should fire a second time for the new cycle
    expect(toast.success).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------------
  // Active states render correctly
  // ---------------------------------------------------------------------------

  it("renders the banner for PENDING state", () => {
    mockHook(makeStatus({ status: "PENDING", command: "plan" }));
    render(<GenerationStatusBanner artifactId="artifact-1" />);

    expect(screen.getByText("Waiting to start...")).toBeInTheDocument();
  });

  it("renders the banner for QUEUED state", () => {
    mockHook(makeStatus({ status: "QUEUED", command: "plan" }));
    render(<GenerationStatusBanner artifactId="artifact-1" />);

    expect(screen.getByText("Queued for generation...")).toBeInTheDocument();
  });

  it("renders the banner for RUNNING state", () => {
    mockHook(makeStatus({ status: "RUNNING", command: "execute" }));
    render(<GenerationStatusBanner artifactId="artifact-1" />);

    expect(
      screen.getByText("Executing plan and creating PR...")
    ).toBeInTheDocument();
  });

  it("renders a spinner icon for active states", () => {
    mockHook(makeStatus({ status: "RUNNING", command: "plan" }));
    const { container } = render(
      <GenerationStatusBanner artifactId="artifact-1" />
    );

    // Active states render a LoaderIcon (spinning svg)
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg?.classList.contains("animate-spin")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // FAILURE state renders correctly
  // ---------------------------------------------------------------------------

  it("renders the banner for FAILURE state with execute command", () => {
    mockHook(makeStatus({ status: "FAILURE", command: "execute" }));
    render(<GenerationStatusBanner artifactId="artifact-1" />);

    expect(screen.getByText("Plan execution failed")).toBeInTheDocument();
  });

  it("renders the banner for FAILURE state with plan command", () => {
    mockHook(makeStatus({ status: "FAILURE", command: "plan" }));
    render(<GenerationStatusBanner artifactId="artifact-1" />);

    expect(screen.getByText("Generation failed")).toBeInTheDocument();
  });

  it("applies destructive styling for FAILURE state", () => {
    mockHook(makeStatus({ status: "FAILURE", command: "plan" }));
    const { container } = render(
      <GenerationStatusBanner artifactId="artifact-1" />
    );

    const banner = container.firstChild as HTMLElement;
    expect(banner?.className).toMatch(RE_BG_DESTRUCTIVE);
  });

  // ---------------------------------------------------------------------------
  // Hidden states
  // ---------------------------------------------------------------------------

  it("renders nothing when generationStatus is undefined", () => {
    mockHook(undefined);
    const { container } = render(
      <GenerationStatusBanner artifactId="artifact-1" />
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when status is SUCCESS", () => {
    mockHook(makeStatus({ status: "SUCCESS", command: "plan" }));
    const { container } = render(
      <GenerationStatusBanner artifactId="artifact-1" />
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when status is NONE", () => {
    mockHook(makeStatus({ status: "NONE", command: null }));
    const { container } = render(
      <GenerationStatusBanner artifactId="artifact-1" />
    );

    expect(container.firstChild).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Banner link rendering
  // ---------------------------------------------------------------------------

  it("renders a loop link when source is loop with loopId", () => {
    mockHook(
      makeStatus({
        status: "RUNNING",
        command: "execute",
        source: "loop",
        loopId: "loop-abc",
      })
    );
    const { container } = render(
      <GenerationStatusBanner artifactId="artifact-1" />
    );

    const link = container.querySelector("a");
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/loops/loop-abc");
    expect(link?.textContent).toBe("View loop");
  });

  it("renders an external link when htmlUrl is provided and source is not loop", () => {
    mockHook(
      makeStatus({
        status: "RUNNING",
        command: "execute",
        htmlUrl: "https://github.com/test/workflow/run/123",
      })
    );
    const { container } = render(
      <GenerationStatusBanner artifactId="artifact-1" />
    );

    const link = container.querySelector("a");
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/test/workflow/run/123"
    );
  });

  it("renders no link when htmlUrl is null and source is not loop", () => {
    mockHook(
      makeStatus({
        status: "RUNNING",
        command: "plan",
        htmlUrl: null,
      })
    );
    const { container } = render(
      <GenerationStatusBanner artifactId="artifact-1" />
    );

    expect(container.querySelector("a")).not.toBeInTheDocument();
  });
});
