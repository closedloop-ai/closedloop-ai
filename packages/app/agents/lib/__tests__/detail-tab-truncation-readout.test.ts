/**
 * ISS-5520 — a bounded-table caption may not print a server page cap where the
 * population belongs, and may not claim an ordering its slice does not have.
 *
 * ISS-5464 already made the three agent-component detail captions honest and
 * routed all of them through {@link detailTabTruncationReadout}, which is the
 * single string emitter for the Sessions, Branches and Evidence tabs. The
 * emitter itself had no direct coverage, and the guard above it is uneven.
 * Re-appending "(most recent)" to the emitter — the exact string ISS-5520 was
 * filed against — was MEASURED against both tab suites before this file existed:
 *
 * - `__tests__/detail-sessions-tab-truncation-total.test.tsx` FAILED (4 cases).
 *   It passes `getByText` a plain string, and Testing Library matches a string
 *   argument against the node's whole normalized text, so a suffix breaks it.
 * - `__tests__/detail-tabs-bounded-render.test.tsx` stayed GREEN. Its captions
 *   go through `getByText(new RegExp(...))`, and a regex matcher is a substring
 *   `test()` unless anchored — so an appended claim slips past it on Branches.
 *
 * The e2e spec (`e2e/agent-detail-sessions-truncation.spec.ts`) is a substring
 * match too. So on two of the three tabs the claim could come back unnoticed.
 * Pinning the shared emitter covers all three at once, with exact equality.
 *
 * On the ordering claim specifically: the rows behind these captions are NOT
 * the recency head of the population. `resolveDetailSessionTabs` takes
 * `[...invCountBySession.keys()].slice(0, MAX_DETAIL_SESSION_IN_IDS)` from an
 * unordered group-by, so above that bound the delivered rows are the recency
 * head of an ARBITRARY subset, and desktop's local reader additionally drops ids
 * it cannot hydrate. The caption may therefore state how many rows it shows and
 * out of how many exist, and nothing about WHICH ones.
 */

import { describe, expect, it } from "vitest";
import {
  DetailTabUnit,
  detailTabTruncationReadout,
} from "../detail-tab-truncation-readout";

/**
 * The observed ISS-5520 strings ("(most recent)" on Sessions, "(most recently
 * active)" on Branches) plus the near-synonyms a future edit would reach for.
 * Ultracite `useTopLevelRegex`: matchers live at module scope.
 */
const RE_ORDERING_CLAIM = /most recent|recently active|newest|latest|oldest/i;

/** The `tool::bash` population from the ISS-5520 report. */
const TRUE_SESSION_COUNT = 7247;
/** The rendered page size — what the reader can actually count on screen. */
const RENDERED = 50;

describe("detailTabTruncationReadout — population, not page cap (ISS-5520)", () => {
  it("prints the true population when it far exceeds the server page cap", () => {
    // The reported defect: the caption read "Showing 50 of 1,000 sessions"
    // beside a Sessions card reading 7,247, silently accounting for 6,247
    // sessions. Exact equality (not a substring match) is what makes this
    // assertion able to fail on an appended ordering claim.
    expect(
      detailTabTruncationReadout({
        isTotalPartial: false,
        rendered: RENDERED,
        total: TRUE_SESSION_COUNT,
        unit: DetailTabUnit.Sessions,
      })
    ).toBe("Showing 50 of 7,247 sessions");
  });

  it("marks a floor total with '+' rather than stating it as the population", () => {
    // The Branches tab has no uncapped count to fall back on, so its total is
    // always a floor. "813" alone would assert a population the payload cannot
    // support; "813+" is the honest form.
    expect(
      detailTabTruncationReadout({
        isTotalPartial: true,
        rendered: RENDERED,
        total: 813,
        unit: DetailTabUnit.Branches,
      })
    ).toBe("Showing 50 of 813+ branches");
  });

  it("says nothing when the population fits and nothing was truncated", () => {
    // The other regime. A caption here would imply a truncation that is not
    // happening — the same class of lie, one field over. Asserting only the
    // truncated regime would pass on a build that always truncates.
    expect(
      detailTabTruncationReadout({
        isTotalPartial: false,
        rendered: 12,
        total: 12,
        unit: DetailTabUnit.Sessions,
      })
    ).toBeNull();
  });

  it("still discloses a floor equal to the rendered count", () => {
    // "Showing 50 of 50+ sessions" is the disclosure that there may be more.
    // Silence here would imply completeness.
    expect(
      detailTabTruncationReadout({
        isTotalPartial: true,
        rendered: RENDERED,
        total: RENDERED,
        unit: DetailTabUnit.Sessions,
      })
    ).toBe("Showing 50 of 50+ sessions");
  });

  it("discloses that same floor for Branches, whose total is always one", () => {
    // The Branches tab is the caller that actually reaches this boundary in
    // production — it has no uncapped count to read, so every total it passes is
    // a floor. Pinning it only for Sessions left the real caller's shape
    // unverified.
    expect(
      detailTabTruncationReadout({
        isTotalPartial: true,
        rendered: RENDERED,
        total: RENDERED,
        unit: DetailTabUnit.Branches,
      })
    ).toBe("Showing 50 of 50+ branches");
  });

  it("uses the singular noun for a population of exactly one", () => {
    // The `total === 1 && !isTotalPartial` arm. A regression that always reached
    // for the plural would print "of 1 sessions" — reachable on any of the three
    // tabs the moment a component has a single session, branch or invocation and
    // the table renders none of them.
    expect(
      detailTabTruncationReadout({
        isTotalPartial: false,
        rendered: 0,
        total: 1,
        unit: DetailTabUnit.Sessions,
      })
    ).toBe("Showing 0 of 1 session");
  });

  it("keeps the plural for a floor of one, which is not a count of one", () => {
    // "1+" means "at least one", so the noun cannot agree with the literal 1 —
    // this is why the singular arm is guarded on `!isTotalPartial`.
    expect(
      detailTabTruncationReadout({
        isTotalPartial: true,
        rendered: 0,
        total: 1,
        unit: DetailTabUnit.Branches,
      })
    ).toBe("Showing 0 of 1+ branches");
  });

  it("claims no ordering, for any unit, in either regime", () => {
    // The generalised guard: whatever the caller asks for, the emitted sentence
    // describes a COUNT and never a selection rule.
    for (const unit of Object.values(DetailTabUnit)) {
      for (const isTotalPartial of [true, false]) {
        const caption = detailTabTruncationReadout({
          isTotalPartial,
          rendered: RENDERED,
          total: TRUE_SESSION_COUNT,
          unit,
        });

        expect(caption).not.toBeNull();
        expect(caption).not.toMatch(RE_ORDERING_CLAIM);
      }
    }
  });
});
