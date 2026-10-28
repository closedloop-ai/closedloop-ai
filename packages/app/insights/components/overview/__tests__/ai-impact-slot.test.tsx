/**
 * ISS-10486: what the AI Impact slot draws when ONE of the two sections it reads
 * has not answered.
 *
 * The operator's ruling, 2026-09-19: a failed section costs its own TILES, never
 * the card. Two of the four metrics divide Delivery by Delivery, so on an Agents
 * failure every one of their operands is present and sibling values render
 * beside them — withholding the card there deletes two computable capabilities.
 * The two that genuinely lose an operand render the no-value glyph, and the one
 * whose SOLE operand is gone must not caption that as a completed lookup.
 *
 * Driven through `AiImpactSlot` rather than the whole dashboard because the
 * shell's fixtures carry no KPIs at all: the load-bearing half of the ruling is
 * that the surviving tiles show their REAL values, and that needs operands. The
 * shell wiring — that a failure reaches this slot and a pending read reaches its
 * placeholder — is pinned next door in the degradation suite.
 */

import type {
  AgentsInsightsResponse,
  DeliveryInsightsResponse,
} from "@repo/api/src/types/insights";
import { InsightsSection } from "@repo/api/src/types/insights";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AiImpactVolumeVocabulary } from "../ai-impact-card";
import { AiImpactSlot } from "../ai-impact-slot";

const EMPTY_SERIES = { series: [], points: [] };
const NO_VALUE = "—";

/** $1,200 of estimated cost over 4 merged PRs, and one repo with 9 of them. */
const DELIVERY: DeliveryInsightsResponse = {
  kpis: [
    { key: "cost", label: "Estimated cost", value: 1200, format: "currency" },
    { key: "mergedCount", label: "PRs shipped", value: 4, format: "number" },
    { key: "mergedKloc", label: "Merged volume", value: 2, format: "number" },
  ] as DeliveryInsightsResponse["kpis"],
  charts: {
    prTrend: EMPTY_SERIES,
    prByRepo: [{ key: "closedloop-ai", label: "closedloop-ai", value: 9 }],
    meanTimeToMerge: [],
    prByState: [],
    branchLifespan: [],
    branchesWithoutPr: [],
  },
};

const AGENTS = {
  kpis: [{ key: "tokens", label: "Tokens", value: 5000, format: "number" }],
  charts: {
    modelUsageOverTime: EMPTY_SERIES,
    modelBreakdown: [{ key: "claude-opus", label: "claude-opus", value: 30 }],
  },
} as unknown as AgentsInsightsResponse;

const ALL_READ = {
  [InsightsSection.Delivery]: false,
  [InsightsSection.Utilization]: false,
  [InsightsSection.Agents]: false,
} as const;

function renderSlot(overrides: {
  sections?: Record<string, unknown>;
  sectionLoading?: Record<InsightsSection, boolean>;
  sectionFailed?: Record<InsightsSection, boolean>;
}) {
  return render(
    <AiImpactSlot
      sectionFailed={overrides.sectionFailed ?? ALL_READ}
      sectionLoading={overrides.sectionLoading ?? ALL_READ}
      sectionStale={ALL_READ}
      sections={
        overrides.sections ?? {
          [InsightsSection.Delivery]: DELIVERY,
          [InsightsSection.Agents]: AGENTS,
        }
      }
    />
  );
}

/**
 * The metric's own three `<p>`s — label, value, caption — reached from the label
 * exactly as `ai-impact-card-render.test.tsx` and the Playwright specs reach
 * them, so a `getByText` on a value cannot match a neighbour's.
 */
function metric(label: string): { value: string; detail: string } {
  const wrapper = screen.getByText(label).parentElement;
  if (!wrapper) {
    throw new Error(`Metric ${label} has no wrapper element`);
  }
  const paragraphs = Array.from(wrapper.querySelectorAll("p"));
  return {
    value: paragraphs[1]?.textContent ?? "",
    detail: paragraphs.at(-1)?.textContent ?? "",
  };
}

describe("AiImpactSlot under a failed section", () => {
  it("still renders the two metrics an Agents failure takes no operand from", () => {
    // The regression this ticket would otherwise ship: at merge-base the gate
    // was loading-only over [Delivery, Utilization], so this card rendered
    // through an Agents failure on `main` and a `Ready`-only gate stopped it.
    // Both values are pinned as literals — a `toHaveTextContent` substring or a
    // value re-derived from `deriveAiImpact` would agree with the very
    // suppression this case exists to catch.
    renderSlot({
      sections: { [InsightsSection.Delivery]: DELIVERY },
      sectionFailed: { ...ALL_READ, [InsightsSection.Agents]: true },
    });

    expect(metric("Cost per merged PR").value).toBe("$300");
    expect(metric("Top repo by output").value).toBe("closedloop-ai");
    expect(metric("Top repo by output").detail).toBe("9 merged PRs");
  });

  it("renders no value for the metric whose numerator the failure took", () => {
    renderSlot({
      sections: { [InsightsSection.Delivery]: DELIVERY },
      sectionFailed: { ...ALL_READ, [InsightsSection.Agents]: true },
    });

    const tokens = metric(AiImpactVolumeVocabulary.Kloc.label);
    expect(tokens.value).toBe(NO_VALUE);
    // The caption is the FORMULA, which asserts nothing about the population —
    // already honest over a failed read, and deliberately unchanged. Read off the
    // vocabulary rather than re-typed: `no-rendered-kloc-volume-label` gates that
    // spelling as ISS-8184 debt, and this case is not the place to re-add it.
    expect(tokens.detail).toBe(AiImpactVolumeVocabulary.Kloc.detail);
  });

  it("does not report a measured zero for the model tile the failure emptied", () => {
    renderSlot({
      sections: { [InsightsSection.Delivery]: DELIVERY },
      sectionFailed: { ...ALL_READ, [InsightsSection.Agents]: true },
    });

    const topModel = metric("Top model by cost");
    expect(topModel.value).toBe(NO_VALUE);
    expect(topModel.detail).toBe("Not measured yet");
  });

  it("keeps the measured-zero caption when Agents answers and simply has none", () => {
    // The counterfactual half: a card that said not-measured whenever the model
    // breakdown was empty would pass the case above and lie to every org that
    // genuinely has no model cost in the window.
    renderSlot({
      sections: {
        [InsightsSection.Delivery]: DELIVERY,
        [InsightsSection.Agents]: { ...AGENTS, charts: { modelBreakdown: [] } },
      },
    });

    expect(metric("Top model by cost").detail).toBe("No model cost yet");
  });

  it("does not report a measured zero for the repo tile a DELIVERY failure emptied", () => {
    // The contract is per section, so the fixture drives the other key too: a
    // slot that keyed the caption off "any section failed" would pass every
    // case above and still mis-caption this one.
    renderSlot({
      sections: { [InsightsSection.Agents]: AGENTS },
      sectionFailed: { ...ALL_READ, [InsightsSection.Delivery]: true },
    });

    expect(metric("Top repo by output").detail).toBe("Not measured yet");
    // ...while the tile whose operand survived that failure still renders.
    expect(metric("Top model by cost").value).toBe("claude-opus");
  });
});

describe("AiImpactSlot while a section is in flight", () => {
  it("draws a placeholder rather than withholding the slot", () => {
    // LOADING IS NOT FAILED. A `Ready`-only gate drew nothing at all here, so a
    // dashboard whose other rows had settled simply had a hole where this card
    // sits, and in-flight read exactly like arrived-without-this.
    const { container } = renderSlot({
      sections: { [InsightsSection.Delivery]: DELIVERY },
      sectionLoading: { ...ALL_READ, [InsightsSection.Agents]: true },
    });

    expect(
      container.querySelector('[data-slot="skeleton"]')
    ).toBeInTheDocument();
    expect(screen.queryByText("AI Impact")).not.toBeInTheDocument();
  });

  it("draws the card, not the placeholder, once both sections have answered", () => {
    const { container } = renderSlot({});

    expect(screen.getByText("AI Impact")).toBeInTheDocument();
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
  });
});
