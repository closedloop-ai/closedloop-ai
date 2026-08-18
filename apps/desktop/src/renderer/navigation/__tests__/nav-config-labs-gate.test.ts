/**
 * ISS-5037 — the desktop Labs container gate, at the nav-model level.
 *
 * `App.tsx` hides every id `navItemsForSection(NavSection.Labs)` returns and
 * resolves each page through {@link resolveLabsPageOutcome}. These cases pin the
 * two halves of that contract:
 *
 *   1. the hidden set is the DISPLAYED Labs set, so FOCUS_MODE-folded pages
 *      (Packs declares `section: artifacts` but displays under Labs) are covered
 *      too — a half-hidden section is still a visible section;
 *   2. a Labs destination stops rendering when the gate is off, and "closed" and
 *      "not resolved yet" produce DIFFERENT outcomes — collapsing them is the
 *      bug the outcome enum exists to prevent.
 */
import { describe, expect, it } from "vitest";
import { NavSection, navItemsForSection, navSectionFor } from "../nav-config";
import { NavId } from "../route-table";
import { LabsPageOutcome, resolveLabsPageOutcome } from "../use-nav-gates";

describe("ISS-5037 Labs container gate — nav model", () => {
  it("treats every DISPLAYED Labs id as gated, including FOCUS_MODE-folded pages", () => {
    const labsIds = navItemsForSection(NavSection.Labs).map(
      (entry) => entry.id
    );

    // Guard against a vacuous pass if the section were ever empty.
    expect(labsIds.length).toBeGreaterThan(0);
    // Insights declares `section: labs`; Packs declares `section: artifacts` and
    // is FOCUS_MODE-folded into Labs. Both must be in the gated set.
    expect(labsIds).toContain(NavId.Insights);
    expect(labsIds).toContain(NavId.Packs);
    for (const id of labsIds) {
      expect(navSectionFor(id)).toBe(NavSection.Labs);
    }
  });

  it("stops rendering every Labs destination once the gate resolves closed", () => {
    for (const entry of navItemsForSection(NavSection.Labs)) {
      expect(
        resolveLabsPageOutcome({
          active: true,
          desktopFlagsResolved: true,
          labsNavOn: false,
          pageId: entry.id,
        })
      ).toBe(LabsPageOutcome.Redirect);
    }
  });

  it("drops a gated-off background mount rather than keeping a hidden copy alive", () => {
    expect(
      resolveLabsPageOutcome({
        active: false,
        desktopFlagsResolved: true,
        labsNavOn: false,
        pageId: NavId.Packs,
      })
    ).toBe(LabsPageOutcome.Unmount);
  });

  it("holds, rather than closing, while the flag snapshot has not landed", () => {
    // The startup race: an unresolved default-OFF flag reads exactly like a
    // user-disabled one, and committing to the closed surface on that reading
    // would tell an opted-in user their own deep link is switched off.
    expect(
      resolveLabsPageOutcome({
        active: true,
        desktopFlagsResolved: false,
        labsNavOn: false,
        pageId: NavId.Insights,
      })
    ).toBe(LabsPageOutcome.Hold);
  });

  it("renders a Labs destination normally once the gate is on", () => {
    for (const pageId of [NavId.Insights, NavId.Packs]) {
      expect(
        resolveLabsPageOutcome({
          active: true,
          desktopFlagsResolved: true,
          labsNavOn: true,
          pageId,
        })
      ).toBe(LabsPageOutcome.Render);
    }
  });

  it("never gates a non-Labs destination, gate off or on", () => {
    // Sessions is the default; Approvals proves a non-default, FOCUS_MODE-exempt
    // section is untouched too — the gate must remove ONE section, not reroute
    // the nav.
    for (const pageId of [NavId.Sessions, NavId.Branches, NavId.Approvals]) {
      for (const labsNavOn of [false, true]) {
        expect(
          resolveLabsPageOutcome({
            active: true,
            desktopFlagsResolved: true,
            labsNavOn,
            pageId,
          })
        ).toBe(LabsPageOutcome.Render);
      }
    }
  });
});
