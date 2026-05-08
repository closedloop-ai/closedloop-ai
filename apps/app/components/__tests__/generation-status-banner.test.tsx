import type { GenerationStatus } from "@repo/api/src/types/document";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { GenerationStatusBanner } from "../generation-status-banner";

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

describe("GenerationStatusBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Toast on SUCCESS transition
  // ---------------------------------------------------------------------------

  it("calls toast.success exactly once when generationStatus transitions to SUCCESS", () => {
    const onComplete = vi.fn();
    const { rerender } = render(
      <GenerationStatusBanner
        generationStatus={makeStatus({ status: "RUNNING", command: "plan" })}
        onGenerationComplete={onComplete}
      />
    );

    expect(toast.success).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();

    rerender(
      <GenerationStatusBanner
        generationStatus={makeStatus({ status: "SUCCESS", command: "plan" })}
        onGenerationComplete={onComplete}
      />
    );

    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith(
      "Generation completed successfully"
    );
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("does not call toast.success again on subsequent re-renders with the same SUCCESS status", () => {
    const status = makeStatus({ status: "SUCCESS", command: "plan" });
    const { rerender } = render(
      <GenerationStatusBanner
        generationStatus={makeStatus({ status: "RUNNING", command: "plan" })}
      />
    );

    rerender(<GenerationStatusBanner generationStatus={status} />);
    expect(toast.success).toHaveBeenCalledTimes(1);

    rerender(<GenerationStatusBanner generationStatus={status} />);
    rerender(<GenerationStatusBanner generationStatus={status} />);

    // Still only called once
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("does not fire toast after unmount and remount when status is already SUCCESS", () => {
    const successStatus = makeStatus({ status: "SUCCESS", command: "plan" });
    const { rerender, unmount } = render(
      <GenerationStatusBanner
        generationStatus={makeStatus({ status: "RUNNING", command: "plan" })}
      />
    );

    rerender(<GenerationStatusBanner generationStatus={successStatus} />);
    expect(toast.success).toHaveBeenCalledTimes(1);

    // Unmount and remount with SUCCESS — simulates parent re-render from cache invalidation
    unmount();
    render(<GenerationStatusBanner generationStatus={successStatus} />);

    // Still only called once — no previous status means no transition detected
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("fires toast again for a new generation cycle on the same artifact", () => {
    // First cycle: RUNNING → SUCCESS
    const { rerender } = render(
      <GenerationStatusBanner
        generationStatus={makeStatus({ status: "RUNNING", command: "plan" })}
      />
    );

    rerender(
      <GenerationStatusBanner
        generationStatus={makeStatus({ status: "SUCCESS", command: "plan" })}
      />
    );
    expect(toast.success).toHaveBeenCalledTimes(1);

    // Second cycle: back to RUNNING (resets toast guard) → SUCCESS again
    rerender(
      <GenerationStatusBanner
        generationStatus={makeStatus({ status: "RUNNING", command: "plan" })}
      />
    );

    rerender(
      <GenerationStatusBanner
        generationStatus={makeStatus({ status: "SUCCESS", command: "plan" })}
      />
    );

    // Should fire a second time for the new cycle
    expect(toast.success).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------------
  // Active states render correctly
  // ---------------------------------------------------------------------------

  it("renders the banner for PENDING state", () => {
    render(
      <GenerationStatusBanner
        generationStatus={makeStatus({ status: "PENDING", command: "plan" })}
      />
    );

    expect(screen.getByText("Waiting to start...")).toBeInTheDocument();
  });

  it("renders the banner for QUEUED state", () => {
    render(
      <GenerationStatusBanner
        generationStatus={makeStatus({ status: "QUEUED", command: "plan" })}
      />
    );

    expect(screen.getByText("Queued for generation...")).toBeInTheDocument();
  });

  it("renders the banner for RUNNING state", () => {
    render(
      <GenerationStatusBanner
        generationStatus={makeStatus({
          status: "RUNNING",
          command: "execute",
        })}
      />
    );

    expect(
      screen.getByText("Executing plan and creating PR...")
    ).toBeInTheDocument();
  });

  it("renders a spinner icon for active states", () => {
    const { container } = render(
      <GenerationStatusBanner
        generationStatus={makeStatus({ status: "RUNNING", command: "plan" })}
      />
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
    render(
      <GenerationStatusBanner
        generationStatus={makeStatus({
          status: "FAILURE",
          command: "execute",
        })}
      />
    );

    expect(screen.getByText("Plan execution failed")).toBeInTheDocument();
  });

  it("renders the banner for FAILURE state with plan command", () => {
    render(
      <GenerationStatusBanner
        generationStatus={makeStatus({ status: "FAILURE", command: "plan" })}
      />
    );

    expect(screen.getByText("Generation failed")).toBeInTheDocument();
  });

  it("applies destructive styling for FAILURE state", () => {
    const { container } = render(
      <GenerationStatusBanner
        generationStatus={makeStatus({ status: "FAILURE", command: "plan" })}
      />
    );

    const banner = container.firstChild as HTMLElement;
    expect(banner?.className).toMatch(RE_BG_DESTRUCTIVE);
  });

  // ---------------------------------------------------------------------------
  // Hidden states
  // ---------------------------------------------------------------------------

  it("renders nothing when generationStatus is undefined", () => {
    const { container } = render(
      <GenerationStatusBanner generationStatus={undefined} />
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when status is SUCCESS", () => {
    const { container } = render(
      <GenerationStatusBanner
        generationStatus={makeStatus({ status: "SUCCESS", command: "plan" })}
      />
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when status is NONE", () => {
    const { container } = render(
      <GenerationStatusBanner
        generationStatus={makeStatus({ status: "NONE", command: null })}
      />
    );

    expect(container.firstChild).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Banner link rendering
  // ---------------------------------------------------------------------------

  it("renders a loop link when source is loop with loopId", () => {
    const { container } = render(
      <GenerationStatusBanner
        generationStatus={makeStatus({
          status: "RUNNING",
          command: "execute",
          source: "loop",
          loopId: "loop-abc",
        })}
      />
    );

    const link = container.querySelector("a");
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/loops/loop-abc");
    expect(link?.textContent).toBe("View loop");
  });

  it("renders an external link when htmlUrl is provided and source is not loop", () => {
    const { container } = render(
      <GenerationStatusBanner
        generationStatus={makeStatus({
          status: "RUNNING",
          command: "execute",
          htmlUrl: "https://github.com/test/workflow/run/123",
        })}
      />
    );

    const link = container.querySelector("a");
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/test/workflow/run/123"
    );
  });

  it("renders no link when htmlUrl is null and source is not loop", () => {
    const { container } = render(
      <GenerationStatusBanner
        generationStatus={makeStatus({
          status: "RUNNING",
          command: "plan",
          htmlUrl: null,
        })}
      />
    );

    expect(container.querySelector("a")).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Dismiss behavior
  // ---------------------------------------------------------------------------

  it("renders a dismiss button for FAILURE state", () => {
    render(
      <GenerationStatusBanner
        generationStatus={makeStatus({ status: "FAILURE", command: "plan" })}
      />
    );

    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("does not render a dismiss button for active states", () => {
    render(
      <GenerationStatusBanner
        generationStatus={makeStatus({ status: "RUNNING", command: "plan" })}
      />
    );

    expect(
      screen.queryByRole("button", { name: "Dismiss" })
    ).not.toBeInTheDocument();
  });

  it("hides the banner when dismiss is clicked", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <GenerationStatusBanner
        generationStatus={makeStatus({ status: "FAILURE", command: "plan" })}
      />
    );

    expect(screen.getByText("Generation failed")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(container.firstChild).toBeNull();
  });

  it("resets dismissed state when generation becomes active again", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <GenerationStatusBanner
        generationStatus={makeStatus({ status: "FAILURE", command: "plan" })}
      />
    );

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Generation failed")).not.toBeInTheDocument();

    // New generation starts — banner should reappear
    rerender(
      <GenerationStatusBanner
        generationStatus={makeStatus({ status: "RUNNING", command: "plan" })}
      />
    );

    expect(screen.getByText("Generating...")).toBeInTheDocument();
  });

  it("keeps failure dismissed for repeated updates from the same run", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <GenerationStatusBanner
        generationStatus={makeStatus({
          status: "FAILURE",
          command: "plan",
          correlationId: "same-run",
        })}
      />
    );

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Generation failed")).not.toBeInTheDocument();

    rerender(
      <GenerationStatusBanner
        generationStatus={makeStatus({
          status: "FAILURE",
          command: "plan",
          correlationId: "same-run",
        })}
      />
    );

    expect(screen.queryByText("Generation failed")).not.toBeInTheDocument();
  });

  it("shows a new failure when the run identity changes without an active transition", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <GenerationStatusBanner
        generationStatus={makeStatus({
          status: "FAILURE",
          command: "plan",
          correlationId: "run-1",
        })}
      />
    );

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Generation failed")).not.toBeInTheDocument();

    rerender(
      <GenerationStatusBanner
        generationStatus={makeStatus({
          status: "FAILURE",
          command: "plan",
          correlationId: "run-2",
        })}
      />
    );

    expect(screen.getByText("Generation failed")).toBeInTheDocument();
  });
});
