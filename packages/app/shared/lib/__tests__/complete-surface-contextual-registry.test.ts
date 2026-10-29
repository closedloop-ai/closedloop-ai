/**
 * ISS-9395 — the contextual half of the inventory, checked against a
 * hand-written table.
 *
 * The MASTERED count is deliberately zero. All three detail families read as
 * mastered off PRD-730's "already shared, cataloged masters" sentence until
 * whitlockk's review of #6741 checked the hosts: web Session detail owns Refresh
 * and the comments rail outside the shared body, desktop Branch detail can
 * return a workspace-only state without mounting BranchDetailPage at all, and
 * Agent detail's two hosts fill different slots with different sections. Pinning
 * the count at zero means a re-promotion has to be argued rather than typed.
 *
 * The other point this suite defends is the UNDECIDED count. Two contextual routes
 * exist that PRD-730's scope inventory neither includes nor excludes, and the
 * tempting thing to do with each was to call it intentionally excluded and move
 * on. Pinning the number here means silently reclassifying one — or quietly
 * dropping it — turns this red instead of shrinking the program's scope with
 * nobody noticing.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTEXTUAL_ROUTE_FAMILY_IDS,
  CONTEXTUAL_SURFACE_REGISTRY,
  ContextualRouteFamilyId,
  undecidedContextualFamilies,
} from "../complete-surface-contextual-registry";
import { SurfaceMastery } from "../complete-surface-registry";
import { ShellNavigationSurface } from "../shell-navigation-contract";
import {
  countOfMastery,
  exportedNames,
  hostPathsOfEntry,
  ownerOfEntry,
} from "./complete-surface-test-support";

const REPO_ROOT = path.join(process.cwd(), "..", "..");

/** Every contextual family and its classification, written out one by one. */
const EXPECTED_MASTERY = {
  [ContextualRouteFamilyId.SessionDetail]: SurfaceMastery.Partial,
  [ContextualRouteFamilyId.BranchDetail]: SurfaceMastery.Partial,
  [ContextualRouteFamilyId.AgentDetail]: SurfaceMastery.Partial,
  [ContextualRouteFamilyId.PrdDetail]: SurfaceMastery.SingleHost,
  [ContextualRouteFamilyId.ImplementationPlanDetail]: SurfaceMastery.SingleHost,
  [ContextualRouteFamilyId.IssueDetail]: SurfaceMastery.SingleHost,
  [ContextualRouteFamilyId.DocumentDetail]: SurfaceMastery.SingleHost,
  [ContextualRouteFamilyId.Search]: SurfaceMastery.Partial,
  [ContextualRouteFamilyId.ProjectContext]: SurfaceMastery.Partial,
  [ContextualRouteFamilyId.TeamContext]: SurfaceMastery.Partial,
  [ContextualRouteFamilyId.UserContext]: SurfaceMastery.SingleHost,
  [ContextualRouteFamilyId.JudgesMetricDetail]: SurfaceMastery.Undecided,
  [ContextualRouteFamilyId.InShellNotFound]: SurfaceMastery.Undecided,
} as const satisfies Record<ContextualRouteFamilyId, SurfaceMastery>;

/**
 * ISS-9395 AC5 — counted by hand off the table above.
 *
 * ISS-9414 moved Search from single-host to partial: both shells now HAVE a
 * mount of `SearchSurfaceV2` (behind a default-off key, as that entry's `gap`
 * records), so the family is reachable on both and the counts shift by one in
 * each direction. The in-scope total is unchanged — a reclassification inside
 * the scope inventory, not an addition to it.
 */
const EXPECTED_FAMILY_COUNT = 13;
const EXPECTED_IN_SCOPE = 11;
const EXPECTED_MASTERED = 0;
const EXPECTED_PARTIAL = 6;
const EXPECTED_SINGLE_HOST = 5;
const EXPECTED_UNDECIDED = 2;

describe("contextual surface registry", () => {
  it("classifies every family as the hand-written table says", () => {
    for (const [family, expected] of Object.entries(EXPECTED_MASTERY)) {
      expect(
        CONTEXTUAL_SURFACE_REGISTRY[family as ContextualRouteFamilyId].mastery,
        `family "${family}"`
      ).toBe(expected);
    }
  });

  it("covers exactly the registered family ids", () => {
    expect(Object.keys(CONTEXTUAL_SURFACE_REGISTRY)).toHaveLength(
      EXPECTED_FAMILY_COUNT
    );
    expect(Object.values(ContextualRouteFamilyId).sort()).toEqual(
      Object.keys(CONTEXTUAL_SURFACE_REGISTRY).sort()
    );
  });

  it("reports the classification totals ISS-9415 consumes", () => {
    expect(
      countOfMastery(
        Object.values(CONTEXTUAL_SURFACE_REGISTRY),
        SurfaceMastery.Mastered
      )
    ).toBe(EXPECTED_MASTERED);
    expect(
      countOfMastery(
        Object.values(CONTEXTUAL_SURFACE_REGISTRY),
        SurfaceMastery.Partial
      )
    ).toBe(EXPECTED_PARTIAL);
    expect(
      countOfMastery(
        Object.values(CONTEXTUAL_SURFACE_REGISTRY),
        SurfaceMastery.SingleHost
      )
    ).toBe(EXPECTED_SINGLE_HOST);
    expect(
      countOfMastery(
        Object.values(CONTEXTUAL_SURFACE_REGISTRY),
        SurfaceMastery.Undecided
      )
    ).toBe(EXPECTED_UNDECIDED);
    // Read off the REGISTRY, not off the two constants above. Asserting
    // `EXPECTED_MASTERED + EXPECTED_SINGLE_HOST === EXPECTED_IN_SCOPE` compared
    // three hand-written literals to each other and could not fail on any
    // reclassification, which is the one thing it was meant to catch.
    expect(
      CONTEXTUAL_ROUTE_FAMILY_IDS.length - undecidedContextualFamilies().length
    ).toBe(EXPECTED_IN_SCOPE);
  });

  /**
   * The escalation list, by name. Adding a third undecided family is fine and
   * expected; silently RESOLVING one to excluded without a human is not, and
   * that is what this pins.
   */
  it("escalates exactly the two families PRD-730 never ruled on", () => {
    expect([...undecidedContextualFamilies()].sort()).toEqual([
      ContextualRouteFamilyId.InShellNotFound,
      ContextualRouteFamilyId.JudgesMetricDetail,
    ]);
  });

  /**
   * The three detail families were classified `Mastered` on the strength of
   * PRD-730's scope sentence until whitlockk's review of #6741 checked the hosts
   * and found each pair diverging outside the contract's host seams. `gap` is
   * where that divergence is named, so a silent re-promotion — or a demotion
   * with nothing recorded — has to fail here.
   */
  it("gives every partial family a non-empty gap", () => {
    for (const family of Object.values(ContextualRouteFamilyId)) {
      const entry = CONTEXTUAL_SURFACE_REGISTRY[family];
      if (entry.mastery !== SurfaceMastery.Partial) {
        continue;
      }
      expect(entry.gap.length, family).toBeGreaterThan(0);
    }
  });

  it("gives every undecided family a non-empty escalation", () => {
    for (const family of undecidedContextualFamilies()) {
      const entry = CONTEXTUAL_SURFACE_REGISTRY[family];
      if (entry.mastery !== SurfaceMastery.Undecided) {
        continue;
      }
      expect(entry.escalation.length, family).toBeGreaterThan(0);
    }
  });

  /**
   * Every single-host contextual family is web-only — Desktop hosts no
   * contextual route outside the three Mastered detail families. A desktop-only
   * contextual family appearing here would be a real inventory change, not a
   * typo, so it should fail until someone classifies it.
   */
  it("puts every single-host contextual family on web", () => {
    for (const family of Object.values(ContextualRouteFamilyId)) {
      const entry = CONTEXTUAL_SURFACE_REGISTRY[family];
      if (entry.mastery !== SurfaceMastery.SingleHost) {
        continue;
      }
      expect(entry.host, family).toBe(ShellNavigationSurface.Web);
    }
  });

  /**
   * The shell suite checks its owners resolve; this one did not, so a renamed
   * DocumentEditorScaffold or AgentSessionDetailView would have gone unnoticed
   * on exactly the families whose owner is shared by four entries.
   */
  it("names an owner module that exists and exports that component", () => {
    for (const family of Object.values(ContextualRouteFamilyId)) {
      const owner = ownerOfEntry(CONTEXTUAL_SURFACE_REGISTRY[family]);
      if (owner === undefined) {
        continue;
      }
      const absolute = path.join(REPO_ROOT, owner.module);
      expect(existsSync(absolute), `${family}: ${owner.module}`).toBe(true);
      expect(exportedNames(absolute), `${family}: ${owner.module}`).toContain(
        owner.exportName
      );
    }
  });

  it("names host paths that exist on disk", () => {
    for (const family of Object.values(ContextualRouteFamilyId)) {
      for (const host of hostPathsOfEntry(
        CONTEXTUAL_SURFACE_REGISTRY[family]
      )) {
        expect(
          existsSync(path.join(REPO_ROOT, host)),
          `${family}: ${host}`
        ).toBe(true);
      }
    }
  });
});
