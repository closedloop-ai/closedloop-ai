/**
 * ISS-10414 (review thread) — the AI Impact card is not a dashboard ROW, so the
 * row-level staleness disclosure never reached it, and it is the one widget on
 * the page that DIVIDES one section by another: cost and merged PRs come from
 * Delivery, tokens and model cost share from Agents. The sections do not land
 * together, so a half-settled dashboard makes every ratio here span two
 * cohorts — this range's cost over last range's tokens — with nothing on screen
 * saying so.
 *
 * The fix is disclosure, not suppression: the numbers stay drawn (they are the
 * only answer available) and the chip names which selection they belong to.
 */
import type { InsightsSection } from "@repo/api/src/types/insights";
import {
  InsightsSection as InsightsSectionValues,
  KpiFormat,
} from "@repo/api/src/types/insights";
import type { InsightsSectionData } from "@repo/app/insights/components/tile-content";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AiImpactCard, isAiImpactStale } from "../ai-impact-card";
import {
  MIXED_SELECTION_DESCRIPTION,
  ROW_UPDATING_DESCRIPTION,
  ROW_UPDATING_LABEL,
} from "../dashboard-refreshing";

const ALL_CURRENT: Record<InsightsSection, boolean> = {
  [InsightsSectionValues.Delivery]: false,
  [InsightsSectionValues.Utilization]: false,
  [InsightsSectionValues.Agents]: false,
};

/** Real cost and token values, so the card renders a ratio rather than "—". */
const SECTIONS: InsightsSectionData = {
  [InsightsSectionValues.Delivery]: {
    kpis: [
      {
        key: "cost",
        label: "Cost",
        value: 400,
        format: KpiFormat.Currency,
        deltaPct: null,
        sub: "",
      },
      {
        key: "mergedCount",
        label: "PRs shipped",
        value: 8,
        format: KpiFormat.Number,
        deltaPct: null,
        sub: "",
      },
    ],
    charts: {
      branchesWithoutPr: [],
      branchLifespan: [],
      meanTimeToMerge: [],
      prByRepo: [],
      prByState: [],
      prTrend: { series: [], points: [] },
    },
  },
  [InsightsSectionValues.Agents]: {
    kpis: [
      {
        key: "tokens",
        label: "Tokens",
        value: 1000,
        format: KpiFormat.Tokens,
        deltaPct: null,
        sub: "",
      },
    ],
    charts: {
      modelBreakdown: [],
      modelUsageOverTime: { series: [], points: [] },
    },
  },
};

describe("isAiImpactStale", () => {
  it("is false while both of the card's sections answer for the selected key", () => {
    expect(isAiImpactStale(ALL_CURRENT)).toBe(false);
  });

  it("is true when EITHER section is still serving the previous key", () => {
    // Both halves, separately: the card's ratios cross the pair, so a stale
    // numerator and a stale denominator are each enough on their own. A helper
    // that only consulted one of them would pass a single-key fixture.
    expect(
      isAiImpactStale({
        ...ALL_CURRENT,
        [InsightsSectionValues.Delivery]: true,
      })
    ).toBe(true);
    expect(
      isAiImpactStale({ ...ALL_CURRENT, [InsightsSectionValues.Agents]: true })
    ).toBe(true);
  });

  it("ignores a section the card does not read", () => {
    // Utilization feeds the heatmap, never this card. Marking it would paint a
    // disclosure over numbers that are current — the FEA-4020 noise complaint.
    expect(
      isAiImpactStale({
        ...ALL_CURRENT,
        [InsightsSectionValues.Utilization]: true,
      })
    ).toBe(false);
  });
});

describe("AiImpactCard stale disclosure", () => {
  it("renders no disclosure while the card's sections are current", () => {
    render(<AiImpactCard sections={SECTIONS} />);

    expect(screen.queryByText(ROW_UPDATING_LABEL)).not.toBeInTheDocument();
    // The positive control on the same render: the card IS on screen, so the
    // absence above is the disclosure's and not an empty page.
    expect(screen.getByText("AI Impact")).toBeInTheDocument();
  });

  it("discloses the previous-key payload, inside the card that relocates on expand", async () => {
    render(<AiImpactCard sections={SECTIONS} stale />);

    const chip = await screen.findByTitle(MIXED_SELECTION_DESCRIPTION);
    expect(chip).toBeInTheDocument();
    const card = chip.closest('[data-slot="card"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("AI Impact");
  });

  it("names the MIX rather than claiming the whole card is the previous range", async () => {
    // Review thread, 2026-09-17: in the case this exists for — Delivery landed,
    // Agents did not — cost and PRs shipped ARE the new selection. The row
    // sentence would assert all four metrics are the previous one, which is a
    // different wrong claim in the same family as the one being fixed, and it
    // matters most here because the two ratios span the pair.
    render(<AiImpactCard sections={SECTIONS} stale />);

    expect(
      await screen.findByText(MIXED_SELECTION_DESCRIPTION)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(ROW_UPDATING_DESCRIPTION)
    ).not.toBeInTheDocument();
  });

  it("keeps every derived metric drawn beneath the disclosure", async () => {
    // Suppressing the ratios because their operands span two cohorts would
    // delete the card rather than caveat it. The values stay; the chip says
    // which selection they belong to.
    render(<AiImpactCard sections={SECTIONS} stale />);
    await screen.findByText(ROW_UPDATING_LABEL);

    expect(screen.getByText("Cost per merged PR")).toBeInTheDocument();
    expect(screen.getByText("Tokens per KLOC")).toBeInTheDocument();
  });
});
