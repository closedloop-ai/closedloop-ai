import { expect } from "@playwright/test";
import {
  DEFAULT_DATE_RANGE,
  getStableUtcDateWindowForRange,
} from "../../../../../packages/app/shared/lib/format-utils";

/**
 * ISS-8066: the fixture PRECONDITION guard a date-seeded desktop e2e spec
 * carries, promoted out of `branches-cloud-owner-filter-metrics.spec.ts` (where
 * ISS-8063 first wrote it as a file-local `expectSeedInsideDefaultWindow`) so
 * the four specs that need it share ONE definition instead of four copies.
 *
 * What it is for. A spec that seeds a past-dated row and then asserts that row
 * renders is bounded by whatever date window the surface applies. When the seed
 * ages out of that window the list correctly renders its empty state and the
 * symptom is a 30s `getByText(...)` timeout that reads like a render regression
 * — the misdiagnosis ISS-8061 paid for once, and the latent class ISS-8063
 * swept. This turns that into a millisecond failure with a named cause.
 *
 * Why it reads the production helper. The bounds come from
 * `getStableUtcDateWindowForRange` — the SAME function `SessionsView` and
 * `branches-view` call — rather than being re-derived here, so a spec and the
 * surface it drives cannot disagree about the window. That helper's own
 * arithmetic is pinned by independently-written literals in
 * `packages/app/shared/lib/__tests__/format-utils.test.ts`, so this is not a
 * tautology: if the window arithmetic regresses, those literals fail, not this.
 *
 * What it must NOT be used for. This checks a fixture precondition ONLY — that
 * the seeded instant sits inside the window the app will apply. Every EXPECTED
 * OUTCOME a spec asserts stays an independently-written literal; deriving an
 * expectation from this same helper would make the assertion restate the code
 * under test and it could no longer fail.
 *
 * It passes by construction while the fixture stays relative to `Date.now()`,
 * and fires only when someone re-pins it to a literal — which is exactly the
 * change that arms the bomb.
 */
export function expectFixtureInsideDefaultDateWindow(
  fixtureIso: string,
  fixtureLabel: string
): void {
  const { startDate, endDate } =
    getStableUtcDateWindowForRange(DEFAULT_DATE_RANGE);
  const fixtureMs = Date.parse(fixtureIso);
  const insideWindow =
    startDate !== undefined &&
    endDate !== undefined &&
    Number.isFinite(fixtureMs) &&
    fixtureMs >= Date.parse(startDate) &&
    fixtureMs <= Date.parse(endDate);
  expect(
    insideWindow,
    `${fixtureLabel} (${fixtureIso}) falls outside the default "${DEFAULT_DATE_RANGE}" window (${startDate} – ${endDate}), so the surface filters every seeded row out before this spec's assertions are ever exercised. Keep the fixture relative to Date.now(); a pinned literal ages out and fails every PR from some future UTC midnight onward.`
  ).toBe(true);
}
