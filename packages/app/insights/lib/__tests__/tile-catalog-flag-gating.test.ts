/**
 * ISS-4463 / ISS-4779 closed-by-default policy: the spend-by-outcome tiles are
 * dark-launched, so they must be invisible on BOTH reachable entry points until
 * their flag is on — and must fail CLOSED under a caller that cannot resolve
 * flags at all.
 *
 * ISS-5335 adds the slice-legibility guards. The gate and the palette are two
 * halves of one contract here: retiring the flag ships whatever the colour map
 * currently paints, so the map is held to a measured contrast floor in the same
 * file that proves the gate.
 */

import { SpendOutcome } from "@closedloop-ai/loops-api/insights";
import { InsightsSection } from "@repo/api/src/types/insights";
import { INSIGHTS_SPEND_OUTCOME_FLAG_KEY } from "@repo/api/src/types/insights-spend-outcome-flag";
import { DONUT_SLICE_SEPARATOR_COLOR } from "@repo/design-system/components/ui/donut-chart";
import { DonutSliceTexture } from "@repo/design-system/components/ui/donut-slice-textures";
import { ACTIVITY_HEATMAP_EMPTY_LEVEL_COLOR } from "@repo/design-system/components/ui/primitives/activity-heatmap-colors";
import { describe, expect, it } from "vitest";
import {
  A11yTheme,
  assertContrastPair,
  ContrastThreshold,
  contrastRatio,
  parseCssColor,
} from "../../../test/a11y/contrast";
import {
  resolveThemeColor,
  themeToken,
} from "../../../test/a11y/theme-tokens.node";
import { spendByOutcomeFixture } from "../../components/insights-section-fixtures";
import {
  SPEND_OUTCOME_COLORS,
  SPEND_OUTCOME_TEXTURES,
} from "../spend-outcome-palette";
import {
  DEFAULT_DASHBOARD_TILE_IDS,
  getSectionTiles,
  getTile,
  INSIGHTS_TILES,
  isTileEnabled,
} from "../tile-catalog";

const SPEND_OUTCOME_TILE_IDS = [
  "chart:spendByOutcome",
  "chart:spendByOutcome:donut",
];

const A11Y_THEMES = [A11yTheme.Light, A11yTheme.Dark] as const;

const BELOW_CONTRAST_FLOOR_MESSAGE = /below WCAG threshold/;

/** A bare `var(--token)` reference — no `color-mix`, no literal, no fallback. */
const BARE_TOKEN_REFERENCE = /^var\(--[a-z0-9-]+\)$/;

const flagOff = () => false;
const flagOn = () => true;

describe("spend-by-outcome tile gating", () => {
  it("ships both spend-by-outcome tiles gated behind the shared flag key", () => {
    for (const id of SPEND_OUTCOME_TILE_IDS) {
      const tile = getTile(id);
      expect(tile?.featureFlag).toBe(INSIGHTS_SPEND_OUTCOME_FLAG_KEY);
      expect(tile?.section).toBe(InsightsSection.Agents);
      // Reads the same spend basis as the sibling "Spend by model" tile, so the
      // two reconcile on screen.
      expect(tile?.metricKey).toBe("cost");
    }
  });

  it("hides the tiles when the flag is off and shows them when it is on", () => {
    for (const id of SPEND_OUTCOME_TILE_IDS) {
      const tile = getTile(id);
      expect(tile).toBeDefined();
      if (!tile) {
        continue;
      }
      expect(isTileEnabled(tile, flagOff)).toBe(false);
      expect(isTileEnabled(tile, flagOn)).toBe(true);
    }
  });

  it("leaves every previously shipped tile ungated, so the flag changes nothing else", () => {
    const ungated = INSIGHTS_TILES.filter(
      (tile) => !SPEND_OUTCOME_TILE_IDS.includes(tile.id)
    );
    // The assertion is meaningful only if the catalog actually has other tiles.
    expect(ungated.length).toBeGreaterThan(0);
    for (const tile of ungated) {
      expect(tile.featureFlag).toBeUndefined();
      expect(isTileEnabled(tile, flagOff)).toBe(true);
    }
  });

  it("filters the gated tiles out of the Agents add-list when the flag is off", () => {
    const agentsTiles = getSectionTiles(InsightsSection.Agents);
    const offered = agentsTiles
      .filter((tile) => isTileEnabled(tile, flagOff))
      .map((tile) => tile.id);
    for (const id of SPEND_OUTCOME_TILE_IDS) {
      expect(offered).not.toContain(id);
    }

    const offeredWithFlag = agentsTiles
      .filter((tile) => isTileEnabled(tile, flagOn))
      .map((tile) => tile.id);
    for (const id of SPEND_OUTCOME_TILE_IDS) {
      expect(offeredWithFlag).toContain(id);
    }
  });

  it("keeps the gated tiles out of the default dashboard so no user sees them by default", () => {
    for (const id of SPEND_OUTCOME_TILE_IDS) {
      expect(DEFAULT_DASHBOARD_TILE_IDS).not.toContain(id);
    }
  });
});

// ISS-5280 (review) / ISS-5335: the donut's slice colours, which are independent
// of whether the tiles are currently gated — when the flag does open, every
// bucket has to read as a category rather than as a hole in the ring.
describe("spend-by-outcome slice colours", () => {
  // A SURFACE token sits at roughly the card's own background value, so a slice
  // painted with one disappears into the card. This is the specific regression
  // that was caught in review: `var(--muted)` on the not-recorded bucket.
  const SURFACE_TOKENS = ["var(--muted)", "var(--card)", "var(--background)"];

  it("never paints an outcome slice with a surface token", () => {
    for (const color of Object.values(SPEND_OUTCOME_COLORS)) {
      expect(SURFACE_TOKENS).not.toContain(color);
    }
  });

  // ISS-5335, the assertion that actually bites. The denylist above is
  // satisfied by ANY token that is not one of three names — `var(--chart-4)` at
  // 1.31:1 passed it, which is how the largest bucket in a typical org shipped
  // as pale yellow on near-white. This measures each slice against the card it
  // is painted on, in both themes, and holds it to the WCAG 1.4.11 non-text
  // floor. A donut slice is the datum, not a decoration beside it: its arc
  // length is what encodes the value, so a slice the reader cannot resolve
  // against the card is a number they cannot get, whatever the legend says.
  it.each(
    A11Y_THEMES
  )("clears the non-text contrast floor against the card in %s", (theme) => {
    const card = themeToken(theme, "--card");
    for (const [outcome, color] of Object.entries(SPEND_OUTCOME_COLORS)) {
      assertContrastPair({
        background: card,
        foreground: resolveThemeColor(theme, color),
        label: `spend-outcome "${outcome}" slice on --card in ${theme}`,
        threshold: ContrastThreshold.NonText,
      });
    }
  });

  // Proves the floor above is not vacuous. Every entry is a value this exact
  // map has really carried, each of which the denylist test passed; the floor
  // must reject all of them, or it would go green for any token substituted in.
  const FAILED_FLOOR_HISTORICALLY = [
    // The original not-recorded bucket: a surface tint, 1.10:1 / 1.12:1.
    { color: "var(--muted)", theme: A11yTheme.Light },
    { color: "var(--muted)", theme: A11yTheme.Dark },
    // The first pass at fixing it — a real improvement, still under the floor.
    {
      color: "color-mix(in oklab, var(--muted-foreground) 45%, transparent)",
      theme: A11yTheme.Light,
    },
    {
      color: "color-mix(in oklab, var(--muted-foreground) 45%, transparent)",
      theme: A11yTheme.Dark,
    },
    // The original ended-clean bucket: palest token in the light palette.
    { color: "var(--chart-4)", theme: A11yTheme.Light },
    // The token ISS-5335 originally proposed for ended-clean. Better than
    // chart-4 and still only ~three quarters of the floor, so it is recorded
    // here as rejected rather than quietly shipped.
    { color: "var(--chart-3)", theme: A11yTheme.Light },
  ];

  it.each(
    FAILED_FLOOR_HISTORICALLY
  )("rejects $color as a slice colour in $theme", ({ color, theme }) => {
    expect(() =>
      assertContrastPair({
        background: themeToken(theme, "--card"),
        foreground: resolveThemeColor(theme, color),
        label: `${color} in ${theme}`,
        threshold: ContrastThreshold.NonText,
      })
    ).toThrow(BELOW_CONTRAST_FLOOR_MESSAGE);
  });

  // The cross-card collision: on one dashboard `--muted` is the heatmap's "no
  // activity" cell, so reusing it for a spend bucket makes one grey mean both
  // "zero" and "money". Asserted against the heatmap's own export rather than a
  // copy of the string, so the two stay tied together. Scope, honestly: this
  // compares token NAMES, so it follows a rename of the heatmap's cell but not a
  // swap to a different token. The contrast floor above is what actually stops
  // `--muted` (1.10:1) coming back; this is the belt to that pair of braces.
  it("never reuses the activity heatmap's empty-cell colour", () => {
    for (const color of Object.values(SPEND_OUTCOME_COLORS)) {
      expect(color).not.toBe(ACTIVITY_HEATMAP_EMPTY_LEVEL_COLOR);
    }
  });

  // Two greys separated only by weight is the "adjacent slices paint as one
  // continuous block" failure `shared/lib/non-work-phase-colors.ts` documents,
  // and the previous map had exactly that — still-running on the full
  // `--muted-foreground` and not-recorded on a 45% mix of it — sitting next to
  // each other in render order. Moving still-running to `--info` left one grey;
  // this pins that, so the pair cannot quietly come back.
  it("keeps exactly one bucket in the muted-foreground family", () => {
    const greys = Object.values(SPEND_OUTCOME_COLORS).filter((color) =>
      color.includes("--muted-foreground")
    );
    expect(greys).toHaveLength(1);
  });

  it("keeps not-recorded distinguishable from still-running", () => {
    // The two buckets a reader most needs to tell apart: one is spend we know
    // is still in flight, the other is spend whose outcome was never recorded.
    expect(SPEND_OUTCOME_COLORS[SpendOutcome.Unknown]).not.toBe(
      SPEND_OUTCOME_COLORS[SpendOutcome.Running]
    );
  });

  it("gives every outcome bucket its own colour", () => {
    const colors = Object.values(SPEND_OUTCOME_COLORS);
    expect(new Set(colors).size).toBe(colors.length);
  });

  // ISS-5335 (review): the map's own argument is that these are EXISTING theme
  // tokens, so both themes are handled by the token layer. A `color-mix(...)` is
  // a hand-mixed value, not a token — it makes that claim false and hides a
  // magic number in a colour map. The not-recorded bucket carried one for two
  // revisions (45%, then 80%); it is now the plain token, and this stops another
  // one being introduced without the docblock being revisited.
  it("paints every bucket with a bare theme token, never a hand-mixed value", () => {
    for (const [outcome, color] of Object.entries(SPEND_OUTCOME_COLORS)) {
      expect(
        color,
        `spend-outcome "${outcome}" must be a bare var(--token)`
      ).toMatch(BARE_TOKEN_REFERENCE);
    }
  });
});

/**
 * ISS-5335 (review): the ring's BOUNDARIES, which the per-slice floor above says
 * nothing about. A slice can clear 3:1 against the card and still be
 * indistinguishable from the slice it touches.
 *
 * This exists to pin the reason the fix is a SEPARATOR rather than a reordering.
 * The reviewer's premise, re-measured here rather than taken on trust: every
 * pair in this map is below the non-text floor against every other pair, in both
 * themes. Four slices give four boundaries, and a rotation only permutes which
 * unreadable pair sits at which boundary — so no order helps while the pairwise
 * maximum is under the floor. If a future palette ever DID separate pairwise,
 * this test fails loudly and the ordering argument becomes live again.
 */
describe("spend-by-outcome slice adjacency", () => {
  function sliceRgb(theme: A11yTheme, color: string) {
    return parseCssColor(resolveThemeColor(theme, color));
  }

  it.each(
    A11Y_THEMES
  )("cannot separate any slice pair by colour alone in %s", (theme) => {
    const colors = Object.values(SPEND_OUTCOME_COLORS);
    const pairRatios: number[] = [];
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) {
        pairRatios.push(
          contrastRatio(sliceRgb(theme, colors[i]), sliceRgb(theme, colors[j]))
        );
      }
    }

    // Six pairs for four buckets — the whole adjacency space, not a sample.
    expect(pairRatios).toHaveLength(6);
    expect(Math.max(...pairRatios)).toBeLessThan(ContrastThreshold.NonText);
  });

  // ...which is why the donut draws a separator, and why THIS token: the ring is
  // painted on the card, so the separator is the one colour every slice is
  // already measured against by the floor above. Both sides of every boundary
  // therefore clear 3:1 against the line between them by construction.
  it("separates slices with the token every slice already clears", () => {
    expect(DONUT_SLICE_SEPARATOR_COLOR).toBe("var(--card)");

    for (const theme of A11Y_THEMES) {
      for (const [outcome, color] of Object.entries(SPEND_OUTCOME_COLORS)) {
        assertContrastPair({
          background: resolveThemeColor(theme, DONUT_SLICE_SEPARATOR_COLOR),
          foreground: resolveThemeColor(theme, color),
          label: `spend-outcome "${outcome}" against the slice separator in ${theme}`,
          threshold: ContrastThreshold.NonText,
        });
      }
    }
  });
});

// ISS-5335: `EditingPinnedSpendOutcomeTile` is the one story that renders the
// real semantic map, so it is the surface where a human would SEE an illegible
// slice. It could not do that job while not-recorded sat at ~2% of the total —
// at that share an invisible slice reads as a rounding artifact, which is
// exactly why `var(--muted)` survived review. These assertions keep the fixture
// load-bearing rather than decorative.
describe("spend-by-outcome story fixture", () => {
  const MIN_UNKNOWN_SHARE = 0.2;

  it("gives not-recorded a share large enough for a bad slice to be obvious", () => {
    const total = spendByOutcomeFixture.reduce(
      (sum, bucket) => sum + bucket.value,
      0
    );
    const unknown = spendByOutcomeFixture.find(
      (bucket) => bucket.key === SpendOutcome.Unknown
    );

    expect(unknown).toBeDefined();
    expect(total).toBeGreaterThan(0);
    expect(unknown!.value / total).toBeGreaterThanOrEqual(MIN_UNKNOWN_SHARE);
  });

  it("ranks not-recorded among the two largest buckets", () => {
    const byValueDesc = [...spendByOutcomeFixture].sort(
      (a, b) => b.value - a.value
    );
    expect(byValueDesc.slice(0, 2).map((bucket) => bucket.key)).toContain(
      SpendOutcome.Unknown
    );
  });

  it("still covers every outcome the colour map paints", () => {
    const fixtureKeys = spendByOutcomeFixture.map((bucket) => bucket.key);
    for (const outcome of Object.keys(SPEND_OUTCOME_COLORS)) {
      expect(fixtureKeys).toContain(outcome);
    }
  });
});

/**
 * ISS-5362: the ring's REDUNDANT, non-colour identity channel.
 *
 * `SPEND_OUTCOME_COLORS` is a semantic palette, so it cannot be re-picked for
 * colour-vision separation without giving up the meaning it carries — measured
 * under simulated protanopia and deuteranopia, all six pairs of the four
 * buckets sit between 1.02:1 and 2.37:1 in both themes, every one below the
 * WCAG 1.4.11 3:1 non-text floor. Textures are what makes a slice identifiable
 * anyway, so these assertions are the contract that keeps them doing that job.
 *
 * Deliberately NOT asserted here: that the colours alone fail a CVD floor.
 * Pinning that would turn a future palette improvement into a red test, and the
 * point of a redundant channel is that it holds whatever the palette does.
 */
describe("spend-by-outcome slice textures", () => {
  it("gives every outcome bucket a texture", () => {
    // Exhaustive over the vocabulary, not over the map's own keys — a bucket
    // added to `SpendOutcome` without a texture would otherwise fall back to a
    // solid slice and silently rejoin the colour-only channel.
    for (const outcome of Object.values(SpendOutcome)) {
      expect(SPEND_OUTCOME_TEXTURES[outcome]).toBeDefined();
    }
  });

  it("gives every outcome bucket a DISTINCT texture", () => {
    // The whole contract in one line: two buckets sharing a texture are back to
    // being separated by hue alone, which is the defect.
    const textures = Object.values(SPEND_OUTCOME_TEXTURES);
    expect(new Set(textures).size).toBe(textures.length);
  });

  it("leaves exactly one bucket solid, and makes it the usually-dominant one", () => {
    // A ring where every slice is hatched is noise. `Clean` is typically the
    // largest slice, so it is the one that stays flat — and being the only flat
    // slice is itself an identity, distinct from all three textured ones.
    const solid = Object.entries(SPEND_OUTCOME_TEXTURES).filter(
      ([, texture]) => texture === DonutSliceTexture.Solid
    );

    expect(solid).toEqual([[SpendOutcome.Clean, DonutSliceTexture.Solid]]);
  });

  it("wires the textures onto the donut tile that renders the ring", () => {
    // Production wiring: without this the map is a constant nothing reads, and
    // deleting the descriptor field would leave every other test above green.
    expect(getTile("chart:spendByOutcome:donut")?.textureByKey).toBe(
      SPEND_OUTCOME_TEXTURES
    );
  });

  it("does not texture the category-bar tile", () => {
    // Bars are laid out along an axis and separated by whitespace, so they do
    // not depend on hue to be told apart. Texture there would be noise with no
    // accessibility gain, and the two tiles are allowed to differ because the
    // marks differ.
    expect(getTile("chart:spendByOutcome")?.textureByKey).toBeUndefined();
  });
});
