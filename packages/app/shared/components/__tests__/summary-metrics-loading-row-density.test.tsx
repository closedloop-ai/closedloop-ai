import { CardDensity } from "@repo/design-system/components/ui/card-density";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SummaryMetricsLoadingRow } from "../summary-metrics-loading-row";
import { restoreGridTier, stubGridTier } from "./summary-card-grid-tier-stub";
import {
  restoreTrackStub,
  stubTrackGap,
  stubTrackWidth,
  type TrackStubDescriptors,
} from "./summary-card-track-stub";

/**
 * ISS-10540 (operator ruling, Tamsin, 2026-09-21): the loading strip both
 * listing hosts render PINS the Compact density tier, the same pin the settled
 * strips carry, so the skeleton-to-cards swap does not change rhythm mid-load.
 * The pin is only observable at a track where the measured tier would resolve
 * Comfortable — five cards fit roomy at 5 × 260 + 4 × 16 = 1364px — so the case
 * stands the row there; an unmeasured jsdom row folds to Compact on its own and
 * would pass with the prop deleted.
 */
const FIVE_CARD_COMFORTABLE_TRACK = 1364;

const CARDS = [
  { key: "a", label: "Alpha" },
  { key: "b", label: "Beta" },
  { key: "c", label: "Gamma" },
] as const;

let gridTier: PropertyDescriptor | undefined;
let trackStub: TrackStubDescriptors | undefined;

beforeEach(() => {
  gridTier = stubGridTier(true);
  trackStub = stubTrackGap();
  stubTrackWidth(FIVE_CARD_COMFORTABLE_TRACK);
});

afterEach(() => {
  if (trackStub) {
    restoreTrackStub(trackStub);
    trackStub = undefined;
  }
  restoreGridTier(gridTier);
  gridTier = undefined;
});

describe("SummaryMetricsLoadingRow (ISS-10540 — pinned density)", () => {
  it("pins the row Compact at a track where the measurement resolves Comfortable", () => {
    const { container } = render(
      <SummaryMetricsLoadingRow
        cardClassName="min-w-0"
        cards={CARDS}
        loadingDetail="Loading"
      />
    );

    const row = container
      .querySelector('[data-slot="card"]')
      ?.closest<HTMLElement>("[data-density]");
    expect(row).not.toBeNull();
    expect(row?.dataset.density).toBe(CardDensity.Compact);
  });
});
