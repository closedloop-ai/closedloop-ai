import type { KpiStat } from "@repo/api/src/types/insights";
import { KpiFormat } from "@repo/api/src/types/insights";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { KPI_NO_VALUE } from "@repo/app/shared/lib/format-utils";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { KpiMetricTile } from "../kpi-stat-tile";

/**
 * ISS-9749 wiring the Insights KPI stat tile onto ISS-9730's gate.
 *
 * Every case runs through the REAL `FeatureFlagAdapterProvider`, and the shapes
 * that must SURVIVE the hide are asserted with the gate ON — a suite that only
 * checked the hidden tile could not distinguish "hides the right state" from
 * "hides everything that isn't a number".
 */
const TILE_ID = "kpi:merged";
const CATALOG_TITLE = "Merged PRs";
const PRODUCER_LABEL = "PRs merged";
const CONNECT_GITHUB = "Connect GitHub";
/** The tile's own overlay control, a SIBLING of the card rather than a child. */
const OVERLAY_CONTROL = "Metric details";

describe("KpiMetricTile under metric-card-hide-unavailable", () => {
  /**
   * The gate-off half of the contract: the shipped tile, unchanged. Without it
   * every negative assertion below would also pass on a tile that stopped
   * rendering for some unrelated reason.
   */
  it("renders the dash and the whole tile when the gate is off", () => {
    renderTile({ hide: false, kpi: makeKpi({ value: null }) });

    expect(screen.getByText(CATALOG_TITLE)).toBeInTheDocument();
    expect(screen.queryByText(PRODUCER_LABEL)).not.toBeInTheDocument();
    expect(screen.getByText(KPI_NO_VALUE)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: OVERLAY_CONTROL })
    ).toBeInTheDocument();
  });

  /**
   * The label AND the overlay, not just the dash: the tile renders its
   * pin/info/drag cluster beside the card rather than inside it, so hiding only
   * the `MetricCard` would leave a control floating over nothing.
   */
  it("renders nothing at all for a settled-absent value when the gate is on", () => {
    const { container } = renderTile({
      hide: true,
      kpi: makeKpi({ value: null }),
    });

    expect(screen.queryByText(CATALOG_TITLE)).not.toBeInTheDocument();
    expect(screen.queryByText(KPI_NO_VALUE)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: OVERLAY_CONTROL })
    ).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  /**
   * A real zero is a fact about the population, not an absence. This is the case
   * that fails if the hide is ever keyed off falsiness rather than off the
   * nullish/non-finite guard the formatter applies.
   */
  it("keeps a real zero with the gate on", () => {
    renderTile({ hide: true, kpi: makeKpi({ value: 0 }) });

    expect(screen.getByText(CATALOG_TITLE)).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.queryByText(KPI_NO_VALUE)).not.toBeInTheDocument();
  });

  /**
   * The case only the desktop reaches: a NaN sentinel survives Electron IPC
   * intact, where `KpiStat.value`'s `number | null` type no longer constrains
   * anything. Corrupt input is NOT a settled successful absence — the dash this
   * tile paints is the reader's only evidence the metric arrived malformed, so
   * the tile stays on screen (codex review on #6914).
   */
  it("keeps a non-finite value visible, unlike a null one", () => {
    renderTile({ hide: true, kpi: makeKpi({ value: Number.NaN }) });

    expect(screen.getByText(CATALOG_TITLE)).toBeInTheDocument();
  });

  it("keeps an infinite value visible too", () => {
    renderTile({
      hide: true,
      kpi: makeKpi({ value: Number.POSITIVE_INFINITY }),
    });

    expect(screen.getByText(CATALOG_TITLE)).toBeInTheDocument();
  });

  /**
   * ISS-7866's card, which ISS-9749 keeps: a gated KPI's absence carries an ASK
   * the reader can act on, and hiding it would delete both the affordance and
   * the metric's name. Asserted with a KPI whose value is ALSO absent, so the
   * case cannot pass merely because there was a number to state.
   */
  it("keeps a gated tile whose ask the reader can act on", () => {
    renderTile({
      availabilityDetail: <button type="button">{CONNECT_GITHUB}</button>,
      hide: true,
      kpi: makeKpi({ value: null }),
    });

    expect(screen.getByText(CATALOG_TITLE)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: CONNECT_GITHUB })
    ).toBeInTheDocument();
  });

  /**
   * The same ask with no KPI behind it at all — the signed-out shape, where the
   * catalog title is the only name the card has.
   */
  it("keeps a gated tile that has no KPI at all", () => {
    renderTile({
      availabilityDetail: <button type="button">{CONNECT_GITHUB}</button>,
      hide: true,
      kpi: undefined,
    });

    expect(screen.getByText(CATALOG_TITLE)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: CONNECT_GITHUB })
    ).toBeInTheDocument();
  });
});

function makeKpi(overrides: Partial<KpiStat> = {}): KpiStat {
  return {
    deltaPct: null,
    format: KpiFormat.Number,
    key: "merged",
    label: PRODUCER_LABEL,
    sub: "pull requests",
    value: 128,
    ...overrides,
  };
}

function renderTile({
  hide,
  kpi,
  availabilityDetail,
}: {
  hide: boolean;
  kpi: KpiStat | undefined;
  availabilityDetail?: ReactNode;
}) {
  const enabledFlags = hide
    ? [METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY]
    : [];
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      <KpiMetricTile
        availabilityDetail={availabilityDetail}
        kpi={kpi}
        pinned={false}
        polarity={MetricPolarity.HigherIsBetter}
        tileId={TILE_ID}
        title={CATALOG_TITLE}
      />
    </FeatureFlagAdapterProvider>
  );
}
