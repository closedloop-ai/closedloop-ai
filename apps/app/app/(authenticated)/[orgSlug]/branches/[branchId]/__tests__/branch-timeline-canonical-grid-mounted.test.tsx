import {
  BranchTimelineMountHarness,
  CANONICAL_GRID_TIMEZONE,
  LOCAL_HALF_DAY_CLOCK_LABELS,
  makeCanonicalGridBranchDetail,
  SESSIONS_TIMELINE_TAB,
  selectTwelveHourScale,
  timelineBarClockLabels,
} from "@repo/app/branches/__tests__/branch-timeline-mount-harness";
import { BranchDetailPage } from "@repo/app/branches/components/branch-detail-page";
import { render } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * ISS-8771 — the WEB adapter, with the REAL Branch timeline mounted
 * (#6566 review, whitlockk).
 *
 * The sibling `page.test.tsx` mocks `BranchDetailPage` to a stand-in, so every
 * existing assertion this suite makes about the timeline is really an assertion
 * about a prop the page passed. This one deliberately does NOT import that
 * harness — the stand-in is registered by the module declaring it, so not
 * importing it is what makes the timeline real here.
 *
 * Its desktop twin lives at `apps/desktop/src/renderer/components/branches/
 * __tests__/branch-timeline-canonical-grid.test.tsx` and drives the same shared
 * harness, so the two shells cannot expect different columns.
 */

const originalTimezone = process.env.TZ;

beforeAll(() => {
  process.env.TZ = CANONICAL_GRID_TIMEZONE;
});

afterAll(() => {
  if (originalTimezone === undefined) {
    Reflect.deleteProperty(process.env, "TZ");
    return;
  }
  process.env.TZ = originalTimezone;
});

describe("web Branch timeline renders the canonical 12h grid", () => {
  it("starts every 12h bar on the viewer's local half-day", async () => {
    const detail = makeCanonicalGridBranchDetail();
    const { container } = render(
      <BranchTimelineMountHarness>
        <BranchDetailPage
          backHref="/branches"
          branchId={detail.id}
          detail={detail}
          initialTab={SESSIONS_TIMELINE_TAB}
          isError={false}
          isLoading={false}
        />
      </BranchTimelineMountHarness>
    );

    await selectTwelveHourScale();
    const clockLabels = timelineBarClockLabels(container);

    // More than one bar, or "every bar is on the half-day" is satisfied by a
    // single column that never had anywhere to drift to.
    expect(clockLabels.length).toBeGreaterThan(1);
    for (const clock of clockLabels) {
      // On the epoch grid these read 5:30am/5:30pm in +05:30, under labels that
      // claim the local half-day.
      expect(LOCAL_HALF_DAY_CLOCK_LABELS).toContain(clock);
    }
  });
});
