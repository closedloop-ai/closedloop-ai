/**
 * ISS-5037 — the desktop Labs container gate, at the nav-model level.
 *
 * `App.tsx` hides every id `navItemsForSection(NavSection.Labs)` returns and
 * resolves each page through {@link resolveLabsPageOutcome}. These cases pin the
 * two halves of that contract:
 *
 *   1. the hidden set is the DISPLAYED Labs set, so FOCUS_MODE-folded pages are
 *      covered too — a half-hidden section is still a visible section;
 *   2. a Labs destination stops rendering when the gate is off, and "closed" and
 *      "not resolved yet" produce DIFFERENT outcomes — collapsing them is the
 *      bug the outcome enum exists to prevent.
 */
import {
  SHELL_DESKTOP_LABS_NAV_GATE_KEY,
  SHELL_NAVIGATION_ITEMS,
  ShellNavigationGateKind,
  type ShellNavigationRouteId,
  ShellNavigationSurface,
} from "@repo/app/shared/lib/shell-navigation-contract";
import { describe, expect, it } from "vitest";
import { DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY } from "../../../shared/desktop-docs-help-flag";
import { DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY } from "../../../shared/feature-flags";
import {
  NAV_ENTRIES,
  NavSection,
  navItemsForSection,
  navSectionFor,
} from "../nav-config";
import { DESKTOP_SHELL_ROUTE_NAV_IDS, NavId } from "../route-table";
import {
  LabsPageOutcome,
  resolveLabsItemGate,
  resolveLabsPageOutcome,
} from "../use-nav-gates";

describe("ISS-5037 Labs container gate — nav model", () => {
  it("treats every DISPLAYED Labs id as gated, including FOCUS_MODE-folded pages", () => {
    const labsIds = navItemsForSection(NavSection.Labs).map(
      (entry) => entry.id
    );

    // Guard against a vacuous pass if the section were ever empty.
    expect(labsIds.length).toBeGreaterThan(0);
    // Insights declares `section: labs`; Approvals is a page the 2026-09-03
    // Gateway fold moved in. Both must be in the gated set. (Packs used to be
    // the folded example here — it declared `section: artifacts` and displayed
    // under Labs; the 2026-09-04 Artifacts fix moved its DECLARATION to `labs`,
    // so it no longer demonstrates the fold.)
    expect(labsIds).toContain(NavId.Insights);
    expect(labsIds).toContain(NavId.Approvals);
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
    // Sessions is the default; Settings proves the one remaining
    // FOCUS_MODE-exempt section (`account`) is untouched too — the gate must
    // remove ONE section, not reroute the nav.
    //
    // ISS-8759 (desktop mirror) took Approvals out of this list, and that is a
    // BEHAVIOR change rather than a weakened case: Approvals used to be the
    // exempt-section example precisely because `gateway` was exempt, and the
    // operator's 2026-09-03 direction folded that section into Labs. It is now
    // a gated Labs destination, asserted as one in the case below.
    for (const pageId of [NavId.Sessions, NavId.Branches, NavId.Settings]) {
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

  it("keeps every rendered Desktop nav entry represented in the shared shell reachability map", () => {
    const mappedNavIds = new Set(
      Object.values(DESKTOP_SHELL_ROUTE_NAV_IDS).filter(isMappedNavId)
    );

    for (const entry of NAV_ENTRIES) {
      expect(mappedNavIds.has(entry.id)).toBe(true);
    }
  });

  it("declares the Desktop Labs container gate for every displayed Labs route", () => {
    const itemByRouteId = new Map(
      SHELL_NAVIGATION_ITEMS.filter((item) => item.routeId).map((item) => [
        item.routeId,
        item,
      ])
    );

    for (const entry of navItemsForSection(NavSection.Labs)) {
      const routeId = shellRouteIdForDesktopNavId(entry.id);
      if (routeId === null) {
        throw new Error(
          `Missing shell route id for Desktop nav id ${entry.id}`
        );
      }
      expect(
        itemByRouteId.get(routeId)?.gates?.[ShellNavigationSurface.Desktop]
      ).toContainEqual({
        kind: ShellNavigationGateKind.DesktopLabsContainer,
        key: SHELL_DESKTOP_LABS_NAV_GATE_KEY,
      });
    }
  });
});

function isMappedNavId(navId: NavId | null): navId is NavId {
  return navId !== null;
}

function shellRouteIdForDesktopNavId(
  navId: NavId
): ShellNavigationRouteId | null {
  const routeIds = Object.entries(DESKTOP_SHELL_ROUTE_NAV_IDS)
    .filter(([, mappedNavId]) => mappedNavId === navId)
    .map(([routeId]) => routeId);

  if (routeIds.length > 1) {
    throw new Error(
      `Multiple shell route ids mapped to Desktop nav id ${navId}`
    );
  }
  return (routeIds[0] as ShellNavigationRouteId | undefined) ?? null;
}

/**
 * ISS-9715 / ISS-9731 — the per-item Labs gates, at the nav-model level.
 *
 * `resolveLabsPageOutcome` takes `labsItemOn` as a VALUE, so a destination with
 * its own gate is only as gated as the caller remembers to make it. Audit was
 * not: `#/audit` resolved with the default `true`, and the page-level switch
 * substituted the Sessions list under an "Audit Bot" breadcrumb. ISS-9715 fixed
 * Audit by NAMING it, which left Routines and Help — two more declared gates —
 * still unresolved. These cases pin the contract-derived pairing that replaced
 * it: every gate the shared contract declares for desktop is resolved by nav id,
 * and the container gate still wins over an open per-item one.
 */
describe("ISS-9715 / ISS-9731 per-item Labs gates", () => {
  /**
   * Every surface the shared contract declares a desktop per-item gate for,
   * with its flag key. Written out rather than derived from the same map the
   * resolver reads — a fixture derived from the thing under test cannot fail
   * when that thing drops a member, which is the exact regression ISS-9731 is
   * about.
   */
  const PER_ITEM_SURFACES = [
    { pageId: NavId.Agents, key: DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY },
    { pageId: NavId.Help, key: DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY },
  ] as const;

  /** Every per-item key open EXCEPT `closed` — so reading the wrong one passes true and fails. */
  function gatesWithout(closed: string): Record<string, boolean> {
    const gates: Record<string, boolean> = {};
    for (const surface of PER_ITEM_SURFACES) {
      gates[surface.key] = surface.key !== closed;
    }
    return gates;
  }

  it("resolves a per-item gate for every declared surface", () => {
    for (const { pageId, key } of PER_ITEM_SURFACES) {
      expect(
        resolveLabsItemGate({ labsItemGates: gatesWithout(key), pageId })
      ).toBe(false);
    }
  });

  it("withdraws a per-item Labs destination whose own gate is off", () => {
    for (const { pageId, key } of PER_ITEM_SURFACES) {
      expect(
        resolveLabsPageOutcome({
          active: true,
          desktopFlagsResolved: true,
          labsItemOn: resolveLabsItemGate({
            labsItemGates: gatesWithout(key),
            pageId,
          }),
          labsNavOn: true,
          pageId,
        })
      ).toBe(LabsPageOutcome.Redirect);
    }
  });

  it("opens a per-item Labs destination once its gate and the container are on", () => {
    const allOpen = gatesWithout("none-of-them");
    for (const { pageId } of PER_ITEM_SURFACES) {
      expect(resolveLabsItemGate({ labsItemGates: allOpen, pageId })).toBe(
        true
      );
      expect(
        resolveLabsPageOutcome({
          active: true,
          desktopFlagsResolved: true,
          labsItemOn: resolveLabsItemGate({ labsItemGates: allOpen, pageId }),
          labsNavOn: true,
          pageId,
        })
      ).toBe(LabsPageOutcome.Render);
    }
  });

  it("treats a DECLARED gate with no resolved value as closed, never open", () => {
    // The SSOT hole ISS-9731 closed: a fifth surface declared in the contract
    // but unread by the hook must withdraw visibly, not resolve open by default
    // the way the old `default: return true` did.
    for (const { pageId } of PER_ITEM_SURFACES) {
      expect(resolveLabsItemGate({ labsItemGates: {}, pageId })).toBe(false);
    }
  });

  // NOT asserted here: container-off with a per-item gate on. That composition
  // is `resolveLabsPageOutcome`'s, not this resolver's, and it is already proven
  // for every Labs id by "stops rendering every Labs destination once the gate
  // resolves closed" above and for Agents by `agents-labs-gate.test.tsx`.

  it("answers a not-yet-rolled-out surface with Blank, which is NOT Unmount", () => {
    // ISS-9731 (visual QA on this PR): both render nothing, but they answer
    // different questions — Unmount means "you are not on this page", Blank
    // means "you are, and this surface's panel is not rolled out yet". The enum
    // exists because collapsing two states into one value is the bug.
    const outcome = resolveLabsPageOutcome({
      active: true,
      closedItemOutcome: LabsPageOutcome.Blank,
      desktopFlagsResolved: true,
      labsItemOn: false,
      labsNavOn: true,
      pageId: NavId.Help,
    });

    expect(outcome).toBe(LabsPageOutcome.Blank);
    expect(outcome).not.toBe(LabsPageOutcome.Unmount);
  });

  it("leaves container-gated-only Labs destinations open with every per-item gate off", () => {
    // Insights, Packs and Plans carry no per-item gate. Closing them here would
    // withdraw the section rather than the one destination whose gate is off.
    for (const pageId of [NavId.Insights, NavId.Packs, NavId.Plans]) {
      expect(resolveLabsItemGate({ labsItemGates: {}, pageId })).toBe(true);
    }
  });
});
