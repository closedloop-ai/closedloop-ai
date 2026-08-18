/**
 * ISS-5310 — Agents moved back into Labs behind a per-item flag nested inside
 * the ISS-5037 container gate.
 *
 * The nesting is the contract, so all FOUR combinations are asserted here rather
 * than the three that happen to be interesting: a suite that skips `Labs off +
 * Agents ON` would pass just as happily against an implementation that ORs the
 * two flags instead of ANDing them.
 *
 * Everything is located by NavId, never by index into `NAV_ENTRIES` — a reorder
 * must not silently re-point an assertion at a different destination.
 */
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY,
  DESKTOP_LABS_NAV_FEATURE_FLAG_KEY,
} from "../../../shared/feature-flags";
import { NavSection, navItemsForSection, navSectionFor } from "../nav-config";
import { NavId } from "../route-table";
import {
  LabsPageOutcome,
  resolveLabsPageOutcome,
  useDesktopNavGates,
} from "../use-nav-gates";

type GateCombination = {
  labsNavOn: boolean;
  agentsFlagOn: boolean;
  visible: boolean;
};

/**
 * The full truth table. Only `both on` shows Agents — the container gate wins
 * whenever it is closed, whatever the per-item flag says.
 */
const GATE_COMBINATIONS: readonly GateCombination[] = [
  { labsNavOn: false, agentsFlagOn: false, visible: false },
  { labsNavOn: false, agentsFlagOn: true, visible: false },
  { labsNavOn: true, agentsFlagOn: false, visible: false },
  { labsNavOn: true, agentsFlagOn: true, visible: true },
];

function flagWrapper(enabledFlags: readonly string[]) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
      >
        {children}
      </FeatureFlagAdapterProvider>
    );
  };
}

function enabledFlagsFor({ labsNavOn, agentsFlagOn }: GateCombination) {
  const flags: string[] = [];
  if (labsNavOn) {
    flags.push(DESKTOP_LABS_NAV_FEATURE_FLAG_KEY);
  }
  if (agentsFlagOn) {
    flags.push(DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY);
  }
  return flags;
}

describe("ISS-5310 Agents nav placement", () => {
  it("declares and DISPLAYS Agents under Labs", () => {
    // Two assertions on purpose. The declared section alone proves nothing:
    // FOCUS_MODE used to override it and display Agents under `main` no matter
    // what `section` said, so only `navSectionFor` proves the move landed.
    expect(navSectionFor(NavId.Agents)).toBe(NavSection.Labs);
    expect(navItemsForSection(NavSection.Labs).map((e) => e.id)).toContain(
      NavId.Agents
    );
    // …and it is no longer a top-level entry.
    expect(navItemsForSection(NavSection.Main).map((e) => e.id)).not.toContain(
      NavId.Agents
    );
  });

  it("leaves the other focus pages in the top-level group", () => {
    // Guards the blast radius of dropping Agents from FOCUSED_NAV_IDS: the edit
    // must move ONE entry, not collapse the focus group.
    const mainIds = navItemsForSection(NavSection.Main).map((e) => e.id);
    expect(mainIds).toContain(NavId.Dashboard);
    expect(mainIds).toContain(NavId.Sessions);
    expect(mainIds).toContain(NavId.Branches);
  });
});

describe("ISS-5310 Agents gate nesting — sidebar entry", () => {
  for (const combination of GATE_COMBINATIONS) {
    const { labsNavOn, agentsFlagOn, visible } = combination;
    it(`${visible ? "shows" : "hides"} the Agents nav entry with labsNav=${labsNavOn} agentsNav=${agentsFlagOn}`, () => {
      const { result } = renderHook(() => useDesktopNavGates(), {
        wrapper: flagWrapper(enabledFlagsFor(combination)),
      });

      expect(result.current.hiddenNavIds.includes(NavId.Agents)).toBe(!visible);
      // The flag the shell reads for the ROUTE decision must track the same
      // input, or the nav and the destination can disagree.
      expect(result.current.agentsFlagOn).toBe(agentsFlagOn);
      expect(result.current.labsNavOn).toBe(labsNavOn);
    });
  }

  it("never hides Sessions, whatever the Labs flags say", () => {
    // The gate must remove destinations, not reroute the nav. Without this a
    // regression that hid everything would satisfy every case above.
    for (const combination of GATE_COMBINATIONS) {
      const { result } = renderHook(() => useDesktopNavGates(), {
        wrapper: flagWrapper(enabledFlagsFor(combination)),
      });
      expect(result.current.hiddenNavIds).not.toContain(NavId.Sessions);
    }
  });
});

describe("ISS-5310 Agents gate nesting — the #/agents destination", () => {
  for (const combination of GATE_COMBINATIONS) {
    const { labsNavOn, agentsFlagOn, visible } = combination;
    it(`${visible ? "renders" : "withholds"} #/agents with labsNav=${labsNavOn} agentsNav=${agentsFlagOn}`, () => {
      const outcome = resolveLabsPageOutcome({
        active: true,
        desktopFlagsResolved: true,
        labsItemOn: agentsFlagOn,
        labsNavOn,
        pageId: NavId.Agents,
      });

      // Hidden resolves to the in-shell "turned off" panel that NAMES Agents —
      // not a 404, not a silent rewrite to Sessions. A bookmark still lands
      // somewhere that explains itself.
      expect(outcome).toBe(
        visible ? LabsPageOutcome.Render : LabsPageOutcome.Redirect
      );
    });
  }

  it("holds rather than closing while the flag snapshot has not landed", () => {
    // An unresolved default-OFF flag reads exactly like a user-disabled one;
    // committing to the closed panel here would tell an opted-in user their own
    // deep link is switched off, one frame before it opens.
    expect(
      resolveLabsPageOutcome({
        active: true,
        desktopFlagsResolved: false,
        labsItemOn: false,
        labsNavOn: true,
        pageId: NavId.Agents,
      })
    ).toBe(LabsPageOutcome.Hold);
  });

  it("drops a gated-off background mount rather than keeping a hidden copy alive", () => {
    expect(
      resolveLabsPageOutcome({
        active: false,
        desktopFlagsResolved: true,
        labsItemOn: false,
        labsNavOn: true,
        pageId: NavId.Agents,
      })
    ).toBe(LabsPageOutcome.Unmount);
  });

  it("ignores a per-item gate on a destination outside Labs", () => {
    // `labsItemOn` must not become a general-purpose page kill switch: it only
    // composes with the container gate, and only for Labs destinations.
    expect(
      resolveLabsPageOutcome({
        active: true,
        desktopFlagsResolved: true,
        labsItemOn: false,
        labsNavOn: false,
        pageId: NavId.Sessions,
      })
    ).toBe(LabsPageOutcome.Render);
  });

  it("defaults `labsItemOn` to open for the container-gated-only destinations", () => {
    // Insights has no per-item flag. Omitting the argument must not gate it off.
    expect(
      resolveLabsPageOutcome({
        active: true,
        desktopFlagsResolved: true,
        labsNavOn: true,
        pageId: NavId.Insights,
      })
    ).toBe(LabsPageOutcome.Render);
  });
});
