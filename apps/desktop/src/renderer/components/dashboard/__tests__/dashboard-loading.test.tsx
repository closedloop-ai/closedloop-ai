import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DashboardLoading } from "../dashboard-loading";

/**
 * ISS-10492: the "Preparing dashboard…" card and its percentage were a SECOND
 * progress surface and are gone — the ambient analysis bar at the top of the
 * shell is the only one. What this file still pins is the half that survived:
 * the route renders the shape of what is coming rather than going blank, and it
 * grows no progress reporting of its own.
 */
describe("DashboardLoading", () => {
  it("renders the skeleton grid so the route is never blank while reads resolve", () => {
    const { container } = render(<DashboardLoading />);

    const skeletonGrid = container.querySelector('[class~="xl:grid-cols-5"]');
    if (!skeletonGrid) {
      throw new Error("Dashboard loading skeleton grid was not rendered");
    }
    expect(skeletonGrid.classList.contains("grid-cols-1")).toBe(true);
    expect(skeletonGrid.classList.contains("lg:grid-cols-3")).toBe(true);
    expect(skeletonGrid.classList.contains("xl:grid-cols-5")).toBe(true);
    expect(skeletonGrid.classList.contains("grid-cols-2")).toBe(false);
  });

  it("renders no progress surface of its own", () => {
    render(<DashboardLoading />);

    expect(screen.queryAllByRole("progressbar")).toHaveLength(0);
    expect(screen.queryByText("Preparing dashboard…")).toBeNull();
  });
});
