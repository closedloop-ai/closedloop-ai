import {
  DASHBOARD_PAGE_DESCRIPTION,
  DASHBOARD_PAGE_TITLE,
} from "@repo/app/insights/lib/dashboard-header-copy";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DashboardFallback } from "../dashboard-fallback";

describe("DashboardFallback", () => {
  it("renders the dashboard header and skeleton so the lazy-load frame matches the in-page loading treatment (FEA-2933)", () => {
    const { container } = render(<DashboardFallback />);

    // Same PageShell title and description FirstLaunchDashboard renders
    // (shared constants, so the two headers cannot silently diverge) — no blank
    // first frame and no header text change across the lazy-chunk boundary.
    expect(
      screen.getByRole("heading", { level: 1, name: DASHBOARD_PAGE_TITLE })
    ).toBeDefined();
    expect(screen.getByText(DASHBOARD_PAGE_DESCRIPTION)).toBeDefined();
    // The DashboardLoading skeleton (five KPI cards + a chart) is present, so the
    // transition to the real tiles is skeleton → values, not blank → skeleton.
    // ISS-10492 retired the "Preparing dashboard…" progress card that used to sit
    // above it; the skeleton is what keeps this frame from being blank.
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(6);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});
