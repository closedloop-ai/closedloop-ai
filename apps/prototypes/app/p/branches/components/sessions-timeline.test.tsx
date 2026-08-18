// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { branchRows, type EventDot } from "../mock";
import { buildBranchDetail } from "../mock-detail";
import { timelineColumn, timelineColumnHeightPct } from "../timeline-fixtures";
import { positionEventDots } from "./event-dot-position";
import { BranchSessionsEmptyState } from "./sessions-empty-state";
import { BranchSessionsTimeline } from "./sessions-timeline";

const TIMING_BRANCH_IDS = [
  "br_1281",
  "br_saml",
  "br_dark_mode",
  "br_session_cost",
  "br_1289",
  "br_unpriced_sessions",
] as const;

const event = (leftPct: number, label: string): EventDot => ({
  leftPct,
  kind: "blue",
  label,
  at: "09:00",
  targetTurnId: label,
});

describe("positionEventDots", () => {
  it("centers dots under their activity bar and stacks shared bars vertically", () => {
    const positioned = positionEventDots(
      [
        event(12, "first"),
        event(30, "second"),
        event(34, "third"),
        event(41, "fourth"),
      ],
      8
    );

    expect(positioned.map(({ leftPct }) => leftPct)).toEqual([
      6.25, 31.25, 31.25, 43.75,
    ]);
    expect(positioned.map(({ stackIndex }) => stackIndex)).toEqual([
      0, 0, 1, 0,
    ]);
  });

  it("returns no positioned dots when the timeline has no columns", () => {
    expect(positionEventDots([event(12, "first")], 0)).toEqual([]);
  });

  it("clamps event positions to both ends of the timeline", () => {
    const positioned = positionEventDots(
      [event(-20, "before"), event(120, "after")],
      8
    );

    expect(positioned.map(({ leftPct }) => leftPct)).toEqual([6.25, 93.75]);
  });

  it("derives timeline height from explicit token categories", () => {
    const column = timelineColumn(
      { input: 100, output: 300, cacheRead: 600 },
      []
    );

    expect(timelineColumnHeightPct(column, 2000)).toBe(50);
  });

  it("renders an explicit empty state for a branch with no sessions", () => {
    const { container } = render(<BranchSessionsEmptyState />);

    expect(container.textContent).toContain("No sessions recorded");
    expect(container.textContent).not.toContain("Combined session trace");
  });
});

describe("BranchSessionsTimeline timing completeness", () => {
  it("renders complete bars, events, legend, lifetime LOC/$, and trace", () => {
    const detail = detailFor("br_1281");
    const { container } = render(<BranchSessionsTimeline detail={detail} />);

    expect(screen.getByText(detail.costLabel, { exact: true })).toBeTruthy();
    expect(
      screen.getByText(detail.valuePerDollar, { exact: true })
    ).toBeTruthy();
    expect(
      screen.getByText(detail.wallClockLabel, { exact: true })
    ).toBeTruthy();
    expect(
      container.querySelectorAll('button[aria-label^="Show token breakdown"]')
        .length
    ).toBeGreaterThan(0);
    expect(
      container.querySelectorAll('button[aria-label^="Jump to "]').length
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("Sam Chen").length).toBeGreaterThan(0);
    expect(screen.getByText("Combined session trace")).toBeTruthy();
  });

  it("keeps partial cost disclosure when timing evidence is complete", () => {
    const detail = detailFor("br_1289");
    render(<BranchSessionsTimeline detail={detail} />);

    const costValue = screen.getByText("$280*", { exact: true });
    const disclosureId = costValue.getAttribute("aria-describedby");

    expect(disclosureId).not.toBeNull();
    expect(document.getElementById(disclosureId ?? "")?.textContent).toBe(
      detail.costDisclosure
    );
  });

  it("keeps activity visible when every Session cost is unavailable", () => {
    const detail = detailFor("br_unpriced_sessions");
    const { container } = render(<BranchSessionsTimeline detail={detail} />);

    expect(screen.getAllByText("Unavailable", { exact: true })).toHaveLength(2);
    expect(container.textContent).not.toContain("Unavailable LOC/$");
    expect(container.textContent).toContain(
      "Session cost is unavailable; absence of priced evidence is not treated as $0."
    );
    expect(container.textContent).toContain("2 sessions");
    expect(screen.getByText("Combined session trace")).toBeTruthy();
  });

  it.each([
    {
      id: "br_saml" as const,
      cost: "$1,200*",
      duration: "3h 46m*",
      disclosure:
        "* Timing is unavailable for assertion review follow-up. Cost and duration include only rendered activity with timing data.",
    },
    {
      id: "br_dark_mode" as const,
      cost: "$221*",
      duration: "1h 12m*",
      disclosure:
        "* The 90-day timeline limit omits later activity for design-system-dark-mode-2. Cost and duration include only rendered activity with timing data.",
    },
  ])("associates both rendered-only values with one named disclosure for $id", ({
    id,
    cost,
    duration,
    disclosure,
  }) => {
    const detail = detailFor(id);
    render(<BranchSessionsTimeline detail={detail} />);

    const costValue = screen.getByText(cost, { exact: true });
    const durationValue = screen.getByText(duration, { exact: true });
    const disclosureId = costValue.getAttribute("aria-describedby");

    expect(disclosureId).not.toBeNull();
    expect(durationValue.getAttribute("aria-describedby")).toBe(disclosureId);
    expect(document.getElementById(disclosureId ?? "")?.textContent).toBe(
      disclosure
    );
    expect(
      screen
        .getByText(detail.valuePerDollar, { exact: true })
        .getAttribute("aria-describedby")
    ).toBeNull();
  });

  it("keeps trace evidence while wholly unavailable timing removes bars and events", () => {
    const detail = detailFor("br_session_cost");
    const { container } = render(<BranchSessionsTimeline detail={detail} />);

    const unavailableValues = screen.getAllByText("Unavailable", {
      exact: true,
    });
    expect(container.textContent).toContain("1 session");
    expect(container.textContent).not.toContain("1 sessions");
    expect(unavailableValues).toHaveLength(2);
    const disclosureId = unavailableValues[0]?.getAttribute("aria-describedby");
    expect(disclosureId).not.toBeNull();
    expect(unavailableValues[1]?.getAttribute("aria-describedby")).toBe(
      disclosureId
    );
    expect(screen.getByText("Duration:", { exact: false })).toBeTruthy();
    expect(container.textContent).toContain(
      "Session timing is unavailable, so spend can't be charted by hour."
    );
    expect(container.textContent).toContain(
      "Timing is unavailable for session-cost-rounding-1."
    );
    expect(container.textContent).not.toContain("$0");
    expect(
      screen.getByText(detail.valuePerDollar, { exact: true })
    ).toBeTruthy();
    expect(
      container.querySelector('button[aria-label^="Show token breakdown"]')
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label^="Jump to "]')
    ).toBeNull();
    expect(screen.getByText("Combined session trace")).toBeTruthy();
    expect(container.textContent).toContain(
      "Fix session cost totals so line items and the displayed aggregate use the same rounding rule."
    );
  });
});

function detailFor(id: (typeof TIMING_BRANCH_IDS)[number]) {
  const row = branchRows.find((candidate) => candidate.id === id);
  if (!row) {
    throw new Error(`Missing selectable Branch fixture ${id}`);
  }
  return buildBranchDetail(row);
}
