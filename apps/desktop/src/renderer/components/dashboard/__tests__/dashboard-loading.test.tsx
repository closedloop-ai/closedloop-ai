import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IngestProgress } from "../../../hooks/use-ingest-progress";
import { progressFillWidth } from "../../__tests__/progress-bar-test-helpers";
import { DashboardLoading } from "../dashboard-loading";

// The loading treatment's phase is driven entirely by the ingest hook; mock it
// so both the import phase and the compute phase are reachable without a live
// runtime.
const hooks = vi.hoisted(() => ({ useIngestProgress: vi.fn() }));
vi.mock("../../../hooks/use-ingest-progress", () => ({
  useIngestProgress: hooks.useIngestProgress,
}));

// Module-scoped so the matchers aren't recompiled per assertion (useTopLevelRegex).
const AGGREGATE_LABEL = /45% · 612 \/ 1,357/;
const NEAR_COMPLETE_LABEL = /99% · 999 \/ 1,000/;
const ZERO_IMPORT_LABEL = /0% · 0 \/ 10/;

function ingest(byHarness: IngestProgress["byHarness"]): IngestProgress {
  const processed = byHarness.reduce((sum, h) => sum + h.processed, 0);
  const total = byHarness.reduce((sum, h) => sum + h.total, 0);
  return { byHarness, total, processed, preparing: false, complete: false };
}

afterEach(() => {
  hooks.useIngestProgress.mockReset();
});

describe("DashboardLoading", () => {
  it("shows an aggregate percentage and overall determinate bar while importing", () => {
    hooks.useIngestProgress.mockReturnValue(
      ingest([
        { harness: "claude", total: 1000, processed: 400 },
        { harness: "codex", total: 357, processed: 212 },
      ])
    );

    render(<DashboardLoading analyticsPct={0} />);

    // FEA-2936: one bounded figure for the whole import (612 / 1,357 ≈ 45%).
    expect(screen.getByText(AGGREGATE_LABEL)).toBeTruthy();
    // An overall aggregate bar plus one per-harness bar each — the first is the
    // aggregate, carrying the exact overall percentage.
    const bars = screen.getAllByRole("progressbar");
    const aggregatePct = (612 / 1357) * 100;
    expect(bars).toHaveLength(3);
    expect(
      screen.getByRole("progressbar", { name: "Overall import progress" })
    ).toBeTruthy();
    expect(bars[0].getAttribute("aria-valuenow")).toBe(aggregatePct.toString());
    expect(progressFillWidth(bars[0])).toBe(`${aggregatePct}%`);
    expect(bars[1].getAttribute("aria-valuenow")).toBe("40");
    expect(progressFillWidth(bars[1])).toBe("40%");
  });

  it("never reads 100% while the import is still in flight", () => {
    // 999 / 1,000 → 99.9%; floored to 99 so the figure stays honest while the
    // skeletons are still shown (round would misleadingly display 100%).
    hooks.useIngestProgress.mockReturnValue(
      ingest([{ harness: "claude", total: 1000, processed: 999 }])
    );

    render(<DashboardLoading analyticsPct={0} />);

    expect(screen.getByText(NEAR_COMPLETE_LABEL)).toBeTruthy();
  });

  it("renders zero import progress with empty aggregate and harness fills", () => {
    hooks.useIngestProgress.mockReturnValue(
      ingest([{ harness: "claude", total: 10, processed: 0 }])
    );

    render(<DashboardLoading analyticsPct={0} />);

    expect(screen.getByText(ZERO_IMPORT_LABEL)).toBeTruthy();
    expect(screen.getByText("0 / 10")).toBeTruthy();
    const bars = screen.getAllByRole("progressbar");
    expect(bars).toHaveLength(2);
    expect(
      screen.getByRole("progressbar", { name: "Overall import progress" })
    ).toBeTruthy();
    expect(
      screen.getByRole("progressbar", {
        name: "Claude Code import progress",
      })
    ).toBeTruthy();
    expect(bars[0].getAttribute("aria-valuenow")).toBe("0");
    expect(progressFillWidth(bars[0])).toBe("0%");
    expect(bars[1].getAttribute("aria-valuenow")).toBe("0");
    expect(progressFillWidth(bars[1])).toBe("0%");
  });

  it("clamps per-harness processed counts above total", () => {
    hooks.useIngestProgress.mockReturnValue(
      ingest([
        { harness: "claude", total: 10, processed: 12 },
        { harness: "codex", total: 10, processed: 0 },
      ])
    );

    render(<DashboardLoading analyticsPct={0} />);

    expect(screen.getByText("60% · 12 / 20")).toBeTruthy();
    expect(screen.getByText("10 / 10")).toBeTruthy();
    expect(screen.queryByText("12 / 10")).toBeNull();
    const bars = screen.getAllByRole("progressbar");
    expect(bars[1].getAttribute("aria-valuenow")).toBe("100");
    expect(progressFillWidth(bars[1])).toBe("100%");
  });

  it("floors negative import counts at zero", () => {
    hooks.useIngestProgress.mockReturnValue(
      ingest([{ harness: "claude", total: 10, processed: -2 }])
    );

    render(<DashboardLoading analyticsPct={0} />);

    expect(screen.getByText(ZERO_IMPORT_LABEL)).toBeTruthy();
    expect(screen.queryByText("-2 / 10")).toBeNull();
  });

  it("shows a numeric percentage while computing insights", () => {
    // total === 0 → not ingesting → the compute phase renders.
    hooks.useIngestProgress.mockReturnValue(null);

    const { container } = render(<DashboardLoading analyticsPct={50} />);

    expect(screen.getByText("Computing insights…")).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
    const skeletonGrid = container.querySelector('[class~="xl:grid-cols-5"]');
    if (!skeletonGrid) {
      throw new Error("Dashboard loading skeleton grid was not rendered");
    }
    expect(skeletonGrid.classList.contains("grid-cols-1")).toBe(true);
    expect(skeletonGrid.classList.contains("lg:grid-cols-3")).toBe(true);
    expect(skeletonGrid.classList.contains("xl:grid-cols-5")).toBe(true);
    expect(skeletonGrid.classList.contains("grid-cols-2")).toBe(false);
  });
});
