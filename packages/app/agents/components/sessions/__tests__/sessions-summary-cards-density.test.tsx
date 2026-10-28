import {
  restoreGridTier,
  stubGridTier,
} from "@repo/app/shared/components/__tests__/summary-card-grid-tier-stub";
import {
  restoreTrackStub,
  stubTrackGap,
  stubTrackWidth,
  type TrackStubDescriptors,
} from "@repo/app/shared/components/__tests__/summary-card-track-stub";
import { CardDensity } from "@repo/design-system/components/ui/card-density";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFullyPopulatedSessionsUsageFixture } from "../session-list-fixtures";
import { SessionsSummaryCards } from "../sessions-summary-cards";

/**
 * ISS-10540 (operator ruling, Tamsin, 2026-09-21): the Sessions listing strip
 * PINS the Compact density tier, so it and the Branches strip read at one
 * vertical rhythm. The pin is only observable at a track where the measured
 * tier would resolve Comfortable — five cards fit roomy at 5 × 260 + 4 × 16 =
 * 1364px — so the case stands the row there; an unmeasured jsdom row folds to
 * Compact on its own and would pass with the prop deleted.
 *
 * Its own file: `sessions-summary-cards.test.tsx` sits at the 1,000-line
 * ceiling.
 */
const FIVE_CARD_COMFORTABLE_TRACK = 1364;

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

describe("SessionsSummaryCards (ISS-10540 — pinned density)", () => {
  it("pins the row Compact at a track where the measurement resolves Comfortable", () => {
    const { container } = render(
      <SessionsSummaryCards
        isLoading={false}
        usage={createFullyPopulatedSessionsUsageFixture()}
      />
    );

    const row = container
      .querySelector('[data-slot="card"]')
      ?.closest<HTMLElement>("[data-density]");
    expect(row).not.toBeNull();
    expect(row?.dataset.density).toBe(CardDensity.Compact);
  });
});
