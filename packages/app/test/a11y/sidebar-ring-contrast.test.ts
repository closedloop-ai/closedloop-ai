/**
 * ISS-10057 — the sidebar's own focus ring, the sibling ISS-9063 left behind.
 *
 * WHY ITS OWN TABLE. `theme-contrast-pairs.node.ts` models the two CONTENT
 * surfaces, `--background` and `--card`. The sidebar paints a separate palette
 * and `--sidebar-ring` is the only token drawn on it, so none of the three
 * surfaces below appear in that table. Everything else here is that harness's:
 * the pair type, the parser, the stylesheet reader and the arithmetic.
 *
 * WHAT IS BEING MEASURED. All six call sites — five in `sidebar.tsx`, one in
 * `sidebar-collapsible-section.tsx` — draw `ring-sidebar-ring` with
 * `focus-visible:ring-2` and no opacity modifier, so the token meets the
 * surface at full strength and there is nothing to composite. Nothing HERE can
 * hold that premise: `sidebar.tsx` pulls in a hook subpath this Node lane
 * cannot resolve, so the assertion lives where the component renders, in
 * `design-system/__tests__/sidebar.test.tsx`. An opacity modifier added at a
 * call site reds that case, not this one.
 */

import { describe, expect, it } from "vitest";
import {
  A11yTheme,
  contrastRatio,
  parseCssColor,
  RETIRED_LIGHT_SIDEBAR_RING,
} from "./contrast";
import {
  type ContrastPair,
  Enforcement,
  measurePair,
  WcagCriterion,
} from "./theme-contrast-pairs.node";
import { resolveThemeColor } from "./theme-tokens.node";

/**
 * WCAG 1.4.11's floor for a non-text indicator, written out rather than read
 * from `ContrastThreshold` so the acceptance bar this file enforces shares
 * nothing with the code that computes the ratios.
 */
const NON_TEXT_MINIMUM_RATIO = 3;

const SIDEBAR = "design-system/components/ui/sidebar.tsx";

function sidebarRingOn(id: string, surface: string): ContrastPair {
  return {
    id,
    criterion: WcagCriterion.NonText,
    enforcement: Enforcement.Required,
    surface: [surface],
    foreground: "var(--sidebar-ring)",
    source: SIDEBAR,
  };
}

/**
 * The three surfaces a sidebar focus ring is actually drawn against: the panel
 * itself, the fill a hovered / active / open menu item takes, and the
 * `outline` menu-button variant's `bg-background`.
 */
const SIDEBAR_RING_PAIRS: readonly ContrastPair[] = [
  sidebarRingOn("sidebar focus ring on the sidebar panel", "var(--sidebar)"),
  sidebarRingOn(
    "sidebar focus ring on a hovered or active item",
    "var(--sidebar-accent)"
  ),
  sidebarRingOn(
    "sidebar focus ring on an outline menu button",
    "var(--background)"
  ),
];

const THEMES = [A11yTheme.Light, A11yTheme.Dark] as const;

describe("sidebar focus ring contrast", () => {
  it.each(THEMES)(
    "clears WCAG 1.4.11 on every %s-theme sidebar surface",
    (theme) => {
      const measurements = SIDEBAR_RING_PAIRS.map((pair) =>
        measurePair(pair, theme)
      );
      // Guards a table that silently empties rather than a floor that holds.
      expect(measurements).toHaveLength(3);
      for (const measurement of measurements) {
        expect(measurement.ratio, measurement.id).toBeGreaterThanOrEqual(
          NON_TEXT_MINIMUM_RATIO
        );
      }
    }
  );

  it("reads the retired light-theme grey as a failure on the same path", () => {
    // The control. If `resolveThemeColor` ever resolved a token to its own
    // surface, or the floor stopped biting, the case above would still pass —
    // this one would not.
    const retired = parseCssColor(RETIRED_LIGHT_SIDEBAR_RING);
    const failing = SIDEBAR_RING_PAIRS.filter(
      (pair) =>
        contrastRatio(
          retired,
          parseCssColor(resolveThemeColor(A11yTheme.Light, pair.surface[0]))
        ) < NON_TEXT_MINIMUM_RATIO
    );
    expect(failing.map((pair) => pair.id)).toEqual(
      SIDEBAR_RING_PAIRS.map((pair) => pair.id)
    );
  });
});
