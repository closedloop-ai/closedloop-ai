import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DASHBOARD_PAGE_TITLE } from "../dashboard-constants";
import { DashboardFallback } from "../dashboard-fallback";

// The fallback renders the real DashboardLoading, which polls runtime status via
// the shared ingest poller; stub it so the test doesn't depend on `desktopApi`.
vi.mock("../../../hooks/use-ingest-progress", () => ({
  useIngestProgress: () => null,
}));

describe("DashboardFallback", () => {
  it("renders the dashboard header and skeleton so the lazy-load frame matches the in-page loading treatment (FEA-2933)", () => {
    const { container } = render(<DashboardFallback />);

    // Same PageShell title FirstLaunchDashboard renders (shared constant, so the
    // two headers cannot silently diverge) — no blank first frame.
    expect(
      screen.getByRole("heading", { level: 1, name: DASHBOARD_PAGE_TITLE })
    ).toBeDefined();
    // The DashboardLoading skeleton (five KPI cards + a chart) is present, so the
    // transition to the real tiles is skeleton → values, not blank → skeleton.
    expect(screen.getByText("Computing insights…")).toBeDefined();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(6);
  });
});
