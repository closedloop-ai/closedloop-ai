import type { MergedTraceItem } from "@repo/api/src/types/branch-trace";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BranchEventDotRail } from "../branch-event-dot-rail";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

const GREEN_EVENT: MergedTraceItem = {
  type: "event",
  sessionId: "ses-1",
  t: "2024-01-01T10:00:00.000Z",
  dot: "g",
  text: "Merged PR #42",
};

describe("BranchEventDotRail marker interactions", () => {
  it("renders each scrubbable dot as a button trigger with a tooltip detail", () => {
    render(
      <BranchEventDotRail
        onScrub={() => undefined}
        traceItems={[GREEN_EVENT]}
      />
    );

    // The dot is a real button (the popover trigger), labelled by the event —
    // reachable by keyboard/tap, not just hover.
    const dot = screen.getByRole("button", { name: "Merged PR #42" });
    expect(dot).toBeInTheDocument();

    expect(screen.getByText("Commits & PRs")).toBeInTheDocument();
    expect(screen.getByText("Merged PR #42")).toBeInTheDocument();
  });

  it("scrubs the playhead to the dot's timestamp on the same tap", () => {
    const onScrub = vi.fn();
    render(<BranchEventDotRail onScrub={onScrub} traceItems={[GREEN_EVENT]} />);

    fireEvent.click(screen.getByRole("button", { name: "Merged PR #42" }));
    expect(onScrub).toHaveBeenCalledWith(GREEN_EVENT.t);
  });

  it("flashes and scrolls to the exact trace row when a row jump is available", () => {
    const onScrubRow = vi.fn();
    render(
      <BranchEventDotRail
        onScrub={() => undefined}
        onScrubRow={onScrubRow}
        traceItems={[GREEN_EVENT]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Merged PR #42" }));
    expect(onScrubRow).toHaveBeenCalledWith(0, true);
  });

  it("keeps a non-scrubbable dot a plain marker (no trigger)", () => {
    render(<BranchEventDotRail traceItems={[GREEN_EVENT]} />);

    // Without `onScrub` there is no trace row to jump to, so the dot stays a
    // plain span (as before) — no button.
    expect(
      screen.queryByRole("button", { name: "Merged PR #42" })
    ).not.toBeInTheDocument();
  });
});
