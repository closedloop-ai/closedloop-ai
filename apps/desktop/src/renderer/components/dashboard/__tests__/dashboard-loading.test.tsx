import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IngestProgress } from "../../../hooks/use-ingest-progress";
import { FirstLaunchImportBanner } from "../../first-launch-import-banner";
import { DashboardLoading } from "../dashboard-loading";

// The banner drives its visibility + import progress off the ingest/maintenance
// hooks; mock both so an in-flight import is reachable without a live runtime.
const hooks = vi.hoisted(() => ({
  useIngestProgress: vi.fn(),
  useMaintenanceProgress: vi.fn(),
}));
vi.mock("../../../hooks/use-ingest-progress", () => ({
  useIngestProgress: hooks.useIngestProgress,
  useMaintenanceProgress: hooks.useMaintenanceProgress,
}));

const OVERALL_PROGRESS_LABEL = /overall import progress/i;

function ingest(total: number, processed: number): IngestProgress {
  return {
    byHarness: total > 0 ? [{ harness: "codex", total, processed }] : [],
    total,
    processed,
    preparing: false,
    complete: false,
  };
}

afterEach(() => {
  hooks.useIngestProgress.mockReset();
  hooks.useMaintenanceProgress.mockReset();
});

describe("DashboardLoading", () => {
  it("shows the compute-insights phase driven by analyticsPct", () => {
    const { container } = render(<DashboardLoading analyticsPct={50} />);

    expect(screen.getByText("Computing insights…")).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
    // A single insights progress bar — the redundant import bars (overall +
    // per-harness) that the top FirstLaunchImportBanner already owns are gone.
    const bars = screen.getAllByRole("progressbar");
    expect(bars).toHaveLength(1);
    expect(
      screen.getByRole("progressbar", { name: "Insights progress" })
    ).toBeTruthy();

    const skeletonGrid = container.querySelector('[class~="xl:grid-cols-5"]');
    if (!skeletonGrid) {
      throw new Error("Dashboard loading skeleton grid was not rendered");
    }
    expect(skeletonGrid.classList.contains("grid-cols-1")).toBe(true);
    expect(skeletonGrid.classList.contains("lg:grid-cols-3")).toBe(true);
    expect(skeletonGrid.classList.contains("xl:grid-cols-5")).toBe(true);
    expect(skeletonGrid.classList.contains("grid-cols-2")).toBe(false);
  });

  it("hides the insights card and shows only the skeleton while an import is in flight", () => {
    // FEA-4139: the four dashboard reads can resolve to 100% mid-import, so
    // rendering the "Computing insights…" card during `importActive` would park a
    // full, never-resolving bar beside the still-counting import splash — the
    // exact double-progress this change removes. During the import the body is
    // just the calm skeleton; the top FirstLaunchImportBanner owns import
    // progress.
    const { container } = render(
      <DashboardLoading analyticsPct={100} importActive />
    );

    expect(screen.queryByText("Computing insights…")).toBeNull();
    expect(screen.queryAllByRole("progressbar")).toHaveLength(0);
    // The calm skeleton tiles remain.
    expect(container.querySelector('[class~="xl:grid-cols-5"]')).toBeTruthy();
  });

  it("keeps a single import surface when the banner and body render together mid-import", () => {
    // wongk: mount the real FirstLaunchImportBanner alongside the loading body
    // with an active ingest at 100% dashboard-read progress. The banner owns the
    // one import progress surface; the body must not grow a second one, so the
    // only import progressbar on screen is the banner's overall bar.
    hooks.useIngestProgress.mockReturnValue(ingest(7183, 612));
    hooks.useMaintenanceProgress.mockReturnValue(null);

    render(
      <>
        <FirstLaunchImportBanner />
        <DashboardLoading analyticsPct={100} importActive />
      </>
    );

    // The banner is the sole import surface.
    expect(screen.getByText("Importing your agent history")).toBeTruthy();
    expect(screen.getByText("612 / 7,183 transcripts")).toBeTruthy();
    // No second insights card / bar from the loading body.
    expect(screen.queryByText("Computing insights…")).toBeNull();
    expect(
      screen.queryByRole("progressbar", { name: "Insights progress" })
    ).toBeNull();
    // Exactly one overall import progressbar — the banner's.
    expect(
      screen.getAllByRole("progressbar", { name: OVERALL_PROGRESS_LABEL })
    ).toHaveLength(1);
  });
});
