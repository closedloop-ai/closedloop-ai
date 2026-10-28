/**
 * ISS-8424: the RENDER half of the top-repo caption.
 *
 * `ai-impact-card.test.ts` next door pins `deriveAiImpact`, which returns a
 * metric object — it never mounts the card, so nothing asserted that the derived
 * caption actually reaches the DOM, or where. That gap matters twice here: the
 * caption is the one metric on this card whose empty state depends on the
 * producer's `tileAvailability` rather than on a KPI value, and the web e2e spec
 * (`e2e/dashboard-ai-impact-unmeasured-top-repo.spec.ts`) locates it by walking
 * from the label to the last `<p>` in the same `OverviewMetric` wrapper. This
 * pins that relationship in jsdom, where it costs milliseconds instead of a
 * containerized stack.
 */

import type { DeliveryInsightsResponse } from "@repo/api/src/types/insights";
import {
  InsightsSection,
  InsightsTileAvailabilityState,
} from "@repo/api/src/types/insights";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AiImpactCard } from "../ai-impact-card";

const EMPTY_SERIES = { series: [], points: [] };
const TOP_REPO_LABEL = "Top repo by output";
/** `OverviewMetric` renders label, value and detail as three sibling `<p>`s. */
const METRIC_PARAGRAPHS = 3;

function delivery(
  tileAvailability?: DeliveryInsightsResponse["tileAvailability"]
): DeliveryInsightsResponse {
  return {
    kpis: [],
    tileAvailability,
    charts: {
      prTrend: EMPTY_SERIES,
      // Empty in every case: the caption is only reachable with no repo
      // buckets, so `tileAvailability` is the only input that can move it.
      prByRepo: [],
      meanTimeToMerge: [],
      prByState: [],
      branchLifespan: [],
      branchesWithoutPr: [],
    },
  };
}

/**
 * The caption, reached exactly as the Playwright spec reaches it: the label's
 * own parent is the `OverviewMetric` wrapper, and the detail is its last `<p>`.
 * A layout change that broke this walk would break the e2e locator too, which is
 * the point of asserting it here.
 */
function topRepoDetail(): string {
  const wrapper = screen.getByText(TOP_REPO_LABEL).parentElement;
  if (!wrapper) {
    throw new Error("Top repo metric label has no wrapper element");
  }
  // Array, not the live NodeList: jsdom's NodeList has no `.at()`.
  const paragraphs = Array.from(wrapper.querySelectorAll("p"));
  // Three: label, value, detail. Checked so a fourth `<p>` fails loudly here
  // rather than silently moving what "last" means for the e2e locator.
  if (paragraphs.length !== METRIC_PARAGRAPHS) {
    throw new Error(
      `Expected ${METRIC_PARAGRAPHS} paragraphs in the metric wrapper, found ${paragraphs.length}`
    );
  }
  return paragraphs.at(-1)?.textContent ?? "";
}

describe("AiImpactCard top-repo caption (ISS-8424)", () => {
  it("renders the not-measured caption when the producer reports prByRepo unavailable", () => {
    render(
      <AiImpactCard
        sections={{
          [InsightsSection.Delivery]: delivery({
            "chart:prByRepo": InsightsTileAvailabilityState.Unavailable,
          }),
        }}
      />
    );

    expect(topRepoDetail()).toBe("Not measured yet");
  });

  it("renders the genuine-zero caption when the producer reports it available", () => {
    render(
      <AiImpactCard
        sections={{
          [InsightsSection.Delivery]: delivery({
            "chart:prByRepo": InsightsTileAvailabilityState.Available,
          }),
        }}
      />
    );

    expect(topRepoDetail()).toBe("No merged PRs yet");
  });
});
