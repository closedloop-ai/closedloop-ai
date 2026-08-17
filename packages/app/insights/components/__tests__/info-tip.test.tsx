import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InfoTip } from "../info-tip";

// A tile id registered in `metric-info.ts`.
const KNOWN_TILE_ID = "kpi:merged";
const KNOWN_WHAT = "Pull requests merged in the selected period.";

/**
 * ISS-5501. The registry suite (`lib/__tests__/tile-catalog.test.ts`) pins this
 * copy in `METRIC_INFO`, but it reads `getMetricInfo` and renders nothing — it
 * stays green if the popover stops rendering a field, or stops opening at all.
 * These pin the same three claims as RENDERED text, through the real
 * `InfoHint` popover, so the reader-facing failure modes are covered and not
 * just the registry entry.
 */
const MERGE_RATE_TILE_ID = "kpi:merge-rate";
const MERGE_RATE_LINES = [
  "Share of decided PRs (merged or closed) that merged.",
  "Merged PRs divided by decided PRs (merged + closed). PRs still open are excluded, so they don't drag the rate down.",
  "Merged and closed PRs are read from PR state.",
];
/**
 * The denominator neither producer uses — the whole defect. "opened"/"opens",
 * not "open": the corrected copy says "PRs still open are excluded", which is
 * the right claim.
 */
const OPENED_PR_DENOMINATOR = /\bopen(ed|s)\b/i;

describe("InfoTip", () => {
  it("renders nothing for a tile id with no registered definition", () => {
    const { container } = render(<InfoTip tileId="nope:none" />);
    expect(container.firstChild).toBeNull();
  });

  it("reveals the metric explainer on hover, with no click required", async () => {
    render(<InfoTip tileId={KNOWN_TILE_ID} />);
    const trigger = screen.getByRole("button", { name: "Metric details" });

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });

    const dialog = await screen.findByRole("dialog", {
      name: "Metric details",
    });
    expect(dialog.textContent).toContain(KNOWN_WHAT);
  });

  it("carries the dashboard grid's drag-cancel class on the trigger", () => {
    // The dashboard grid gates dragging to `.insights-drag-handle` and also
    // cancels a drag begun on `.insights-widget-control` (dashboard-grid.tsx), so
    // the info trigger must carry that class to match the tile's other controls.
    render(<InfoTip tileId={KNOWN_TILE_ID} />);
    const trigger = screen.getByRole("button", { name: "Metric details" });
    expect(trigger.className).toContain("insights-widget-control");
  });

  it("dismisses on pointer-out", async () => {
    render(<InfoTip tileId={KNOWN_TILE_ID} />);
    const trigger = screen.getByRole("button", { name: "Metric details" });

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    await screen.findByRole("dialog", { name: "Metric details" });

    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("renders the decided merge-rate denominator, never the opened-PR one (ISS-5501)", async () => {
    render(<InfoTip tileId={MERGE_RATE_TILE_ID} />);
    const trigger = screen.getByRole("button", { name: "Metric details" });

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });

    const dialog = await screen.findByRole("dialog", {
      name: "Metric details",
    });
    for (const line of MERGE_RATE_LINES) {
      expect(dialog.textContent).toContain(line);
    }
    // Asserted against the WHOLE popover rather than the lines named above, so
    // a revert cannot reintroduce the wrong denominator in a field this test
    // does not happen to enumerate.
    expect(dialog.textContent).not.toMatch(OPENED_PR_DENOMINATOR);
  });
});
