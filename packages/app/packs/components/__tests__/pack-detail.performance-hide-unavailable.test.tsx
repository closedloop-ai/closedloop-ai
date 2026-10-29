import { LOC_PER_DOLLAR_LABEL } from "@repo/api/src/utils/loc-per-dollar";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { KPI_NO_VALUE } from "@repo/app/shared/lib/format-utils";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PackPerformance, PackView } from "../../lib/pack-view";
import { mockPackViews } from "../../lib/pack-view-mock";
import { createPacksContext, PacksMode } from "../../lib/packs-context";
import { PackDetail } from "../pack-detail";

/**
 * ISS-9749 wiring the Packs Performance tiles onto ISS-9730's gate.
 *
 * The tiles route their values through `dashOr` / `formatLocPerDollar`, which
 * return a pre-formatted dash STRING — so the classification has to be taken
 * from the RAW nullable field, and the cases that must survive the gate are the
 * ones a value-string classification would get wrong: a real `0`, a `+0%`, and
 * a capped-but-real merged-PR floor.
 */

const CONTEXT = createPacksContext(PacksMode.WebAdmin);
const BASE_PACK = mockPackViews[0];
const SUCCESS_RATE = "Success rate";
const TOKEN_EFFICIENCY = "Token efficiency";
const INVOCATIONS = "Invocations";
const SESSIONS = "Sessions";
const MERGED_PRS = "Merged PRs";
const ALL_LABELS = [
  LOC_PER_DOLLAR_LABEL,
  SUCCESS_RATE,
  TOKEN_EFFICIENCY,
  INVOCATIONS,
  SESSIONS,
  MERGED_PRS,
];
const BASELINE_BLURB = /compare to a baseline of org sessions/i;

describe("Packs Performance tiles under metric-card-hide-unavailable", () => {
  /**
   * The gate-off half of the contract: six tiles, every one of them showing the
   * shipped dash. Without it, every negative assertion below could pass on a tab
   * that stopped rendering for an unrelated reason.
   */
  it("renders all six tiles with their dashes when the gate is off", () => {
    renderPerformanceTab({ hide: false, performance: allAbsent() });

    for (const label of ALL_LABELS) {
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(tileValue(label)).toBe(KPI_NO_VALUE);
    }
  });

  it("retires only the tile whose own field is absent", () => {
    renderPerformanceTab({
      hide: true,
      performance: { ...basePerformance(), successRate: null },
    });

    expect(screen.queryByText(SUCCESS_RATE)).not.toBeInTheDocument();
    expect(screen.getByText(LOC_PER_DOLLAR_LABEL)).toBeInTheDocument();
    expect(screen.getByText(TOKEN_EFFICIENCY)).toBeInTheDocument();
    expect(screen.getByText(INVOCATIONS)).toBeInTheDocument();
    expect(screen.getByText(SESSIONS)).toBeInTheDocument();
    expect(screen.getByText(MERGED_PRS)).toBeInTheDocument();
  });

  /**
   * The cases that must fail if anyone classifies off the rendered string or off
   * falsiness. Every one of these is a measured fact about the cohort: no
   * session reached a merged PR, the pack was never invoked in this window, it
   * used exactly as many tokens as the baseline.
   */
  it("keeps a 0% success rate with its zero on screen", () => {
    renderPerformanceTab({
      hide: true,
      performance: { ...basePerformance(), successRate: 0 },
    });

    expect(tileValue(SUCCESS_RATE)).toBe("0%");
  });

  it("keeps a zero invocation count", () => {
    renderPerformanceTab({
      hide: true,
      performance: { ...basePerformance(), invocations: 0 },
    });

    expect(tileValue(INVOCATIONS)).toBe("0");
  });

  it("keeps a zero session count", () => {
    renderPerformanceTab({
      hide: true,
      performance: { ...basePerformance(), sessions: 0 },
    });

    expect(tileValue(SESSIONS)).toBe("0");
  });

  it("keeps a token-efficiency delta of exactly parity", () => {
    renderPerformanceTab({
      hide: true,
      performance: { ...basePerformance(), tokenEfficiencyDelta: 0 },
    });

    expect(tileValue(TOKEN_EFFICIENCY)).toBe("+0%");
  });

  it("keeps a zero LOC per dollar", () => {
    renderPerformanceTab({
      hide: true,
      performance: { ...basePerformance(), locPerDollar: 0 },
    });

    expect(screen.getByText(LOC_PER_DOLLAR_LABEL)).toBeInTheDocument();
    expect(tileValue(LOC_PER_DOLLAR_LABEL)).toBe("0.00");
  });

  it("keeps a zero merged-PR count", () => {
    renderPerformanceTab({
      hide: true,
      performance: { ...basePerformance(), mergedPrs: 0 },
    });

    expect(tileValue(MERGED_PRS)).toBe("0");
  });

  /**
   * ISS-6462's floor is a REAL value taken over a capped sample, not an absence,
   * so the gate must not touch it — and the `+` has to survive with it, or the
   * tile goes back to claiming an exact count.
   */
  it("keeps a capped merged-PR floor, marker and all", () => {
    renderPerformanceTab({
      hide: true,
      performance: {
        ...basePerformance(),
        mergedPrs: 996,
        mergedPrsTruncated: true,
      },
    });

    expect(tileValue(MERGED_PRS)).toBe("996+");
  });

  it("retires the merged-PR tile when no count arrived at all", () => {
    renderPerformanceTab({
      hide: true,
      performance: { ...basePerformance(), mergedPrs: null },
    });

    expect(screen.queryByText(MERGED_PRS)).not.toBeInTheDocument();
    expect(screen.getByText(SESSIONS)).toBeInTheDocument();
  });

  /**
   * ISS-9730 acceptance 3. A pack whose every performance field is absent
   * keeps today's grid rather than collapsing to a bare gap.
   */
  it("keeps the whole tile grid when every tile would be retired", () => {
    renderPerformanceTab({ hide: true, performance: allAbsent() });

    for (const label of ALL_LABELS) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText(BASELINE_BLURB)).toBeInTheDocument();
    expect(performancePanel().querySelector("div.grid")).not.toBeNull();
  });
});

function renderPerformanceTab({
  hide,
  performance,
}: {
  hide: boolean;
  performance: PackPerformance;
}): void {
  const nav = createMemoryNavigation({
    initialPath: "/packs/code?tab=performance",
    orgSlug: "org-test",
  });
  const pack: PackView = { ...BASE_PACK, performance };
  const enabledFlags = hide
    ? [METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY]
    : [];
  render(
    <NavigationProvider adapter={nav.adapter}>
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
      >
        <PackDetail context={CONTEXT} pack={pack} />
      </FeatureFlagAdapterProvider>
    </NavigationProvider>
  );
}

/** The fixture's performance block, every field computed. */
function basePerformance(): PackPerformance {
  const performance = BASE_PACK.performance;
  if (!performance) {
    throw new Error("fixture pack must carry a performance block");
  }
  return { ...performance };
}

/** The same block with all six tiles' own fields absent. */
function allAbsent(): PackPerformance {
  return {
    ...basePerformance(),
    invocations: null,
    locPerDollar: null,
    mergedPrs: null,
    sessions: null,
    successRate: null,
    tokenEfficiencyDelta: null,
  };
}

function performancePanel(): HTMLElement {
  return screen.getByRole("tabpanel");
}

/** The headline figure of the tile carrying `label`. */
function tileValue(label: string): string {
  const card = screen.getByText(label).closest("[data-slot='card']");
  if (!card) {
    throw new Error(`the ${label} label is not inside a card`);
  }
  const title = card.querySelector("[data-slot='card-title']");
  if (!title) {
    throw new Error(`the ${label} card rendered no value`);
  }
  return title.textContent?.trim() ?? "";
}
