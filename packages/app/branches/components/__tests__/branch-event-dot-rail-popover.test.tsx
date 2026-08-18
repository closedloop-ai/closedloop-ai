import type { MergedTraceItem } from "@repo/api/src/types/branch-trace";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BranchEventDotRail } from "../branch-event-dot-rail";

// FEA-3866: the event-dot marker detail is a tap-triggered `Popover`, not a
// mouse-position tooltip. The dot is the popover trigger, so it opens on click
// (no hover dependency), gives focus + Escape for free, and still scrubs the
// playhead on the same click.

const GREEN_EVENT: MergedTraceItem = {
  type: "event",
  sessionId: "ses-1",
  t: "2024-01-01T10:00:00.000Z",
  dot: "g",
  text: "Merged PR #42",
};

describe("BranchEventDotRail — tap Popover (FEA-3866)", () => {
  it("renders each scrubbable dot as a button trigger and opens its detail on click", () => {
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

    // The detail is not in the DOM until the dot is tapped (no hover-mounted
    // tooltip). Clicking opens the popover content with the category + label.
    expect(screen.queryByText("Commits, PRs & merges")).not.toBeInTheDocument();
    fireEvent.click(dot);
    expect(screen.getByText("Commits, PRs & merges")).toBeInTheDocument();
    expect(screen.getByText("Merged PR #42")).toBeInTheDocument();
  });

  it("scrubs the playhead to the dot's timestamp on the same tap", () => {
    const onScrub = vi.fn();
    render(<BranchEventDotRail onScrub={onScrub} traceItems={[GREEN_EVENT]} />);

    fireEvent.click(screen.getByRole("button", { name: "Merged PR #42" }));
    expect(onScrub).toHaveBeenCalledWith(GREEN_EVENT.t);
  });

  it("keeps a non-scrubbable dot a plain, non-interactive marker (no trigger)", () => {
    render(<BranchEventDotRail traceItems={[GREEN_EVENT]} />);

    // Without `onScrub` there is no trace row to jump to, so the dot stays a
    // plain span (as before) — no button, no popover.
    expect(
      screen.queryByRole("button", { name: "Merged PR #42" })
    ).not.toBeInTheDocument();
  });
});
