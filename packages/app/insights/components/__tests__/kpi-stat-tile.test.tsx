import type { KpiStat } from "@repo/api/src/types/insights";
import { KpiFormat } from "@repo/api/src/types/insights";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { KpiMetricTile } from "../kpi-stat-tile";

function makeKpi(overrides: Partial<KpiStat> = {}): KpiStat {
  return {
    key: "captured",
    label: "Captured PRs",
    value: 128,
    format: KpiFormat.Number,
    sub: "128 this period",
    deltaPct: null,
    ...overrides,
  };
}

function renderTile(kpi: KpiStat, tileId = "captured") {
  return render(
    <KpiMetricTile
      kpi={kpi}
      pinned={false}
      tileId={tileId}
      title="Captured PRs"
    />
  );
}

describe("KpiMetricTile delta slot (FEA-2494)", () => {
  it("shows a real signed delta for ranges with a prior-period comparison", () => {
    renderTile(makeKpi({ deltaPct: 12 }));

    expect(screen.getByText("+12%")).toBeInTheDocument();
    expect(
      screen.queryByTestId("kpi-delta-placeholder")
    ).not.toBeInTheDocument();
  });

  it("shows a dash placeholder (not an empty slot) when no comparison exists for the range", () => {
    renderTile(makeKpi({ deltaPct: null }));

    const placeholder = screen.getByTestId("kpi-delta-placeholder");
    expect(placeholder).toBeInTheDocument();
    // Visible glyph is an em dash, hidden from assistive tech...
    expect(placeholder).toHaveTextContent("—");
    // ...while a screen-reader-only label explains the absence instead of
    // conveying an empty value.
    expect(placeholder).toHaveTextContent("No prior-period comparison");
    expect(placeholder).toHaveTextContent(
      "Comparisons appear for shorter ranges"
    );
  });

  it("moves the KPI description behind the card info control", async () => {
    const user = userEvent.setup();
    renderTile(
      makeKpi({ label: "Merged PRs", sub: "PRs found in local sessions" }),
      "kpi:merged"
    );

    expect(
      screen.queryByText("PRs found in local sessions")
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Metric details" })
    ).toBeInTheDocument();

    const trigger = screen.getByRole("button", { name: "About Merged PRs" });

    await user.click(trigger);

    const contentId = trigger.getAttribute("aria-controls");
    const dialog = await screen.findByRole("dialog", {
      name: "About Merged PRs",
    });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(contentId).toBeTruthy();
    expect(dialog).toHaveAttribute("id", contentId);
    expect(dialog).toHaveTextContent("PRs found in local sessions");
  });
});
