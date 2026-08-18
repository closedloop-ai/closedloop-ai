/**
 * ISS-5362 (#4514 review): mark-against-slice, the one contrast the whole
 * non-colour channel lives on.
 *
 * Everything else about the ring was measured — the slices against the card,
 * the slices against each other under simulated dichromacy — but the marks
 * themselves never were, and a texture whose marks cannot be seen on the slice
 * they are drawn on is not a channel. It is a slightly-off flat colour that
 * review will read as working.
 *
 * That failure mode is real and directional: `Unknown` is deliberately the
 * faintest bucket, so the DEFAULT card-coloured mark is invisible on precisely
 * the slice the docstrings say most needs a second channel. So this asserts the
 * floor for every shipped mark/slice pair, in both themes, against the palette
 * strings the product actually ships rather than a restated copy of them.
 */

import { SpendOutcome } from "@closedloop-ai/loops-api/insights";
import {
  DONUT_SLICE_TEXTURE_MARK_COLOR,
  isTexturedSlice,
} from "@repo/design-system/components/ui/donut-slice-textures";
import { describe, expect, it } from "vitest";
import {
  A11yTheme,
  ContrastThreshold,
  compositeColorOver,
  contrastRatio,
  resolveThemeColor,
} from "../../../test/a11y/contrast";
import {
  SPEND_OUTCOME_COLORS,
  SPEND_OUTCOME_TEXTURE_MARK_COLORS,
  SPEND_OUTCOME_TEXTURES,
} from "../spend-outcome-palette";

const CARD = "var(--card)";

/**
 * The colour a reader actually sees for one slice: its own value composited
 * over the card, because the faint bucket is authored at partial alpha and a
 * ratio against the unflattened value would be a ratio against nothing on
 * screen.
 */
function renderedSlice(theme: A11yTheme, outcome: SpendOutcome) {
  return compositeColorOver(
    resolveThemeColor(theme, SPEND_OUTCOME_COLORS[outcome]),
    resolveThemeColor(theme, CARD)
  );
}

function markColorFor(outcome: SpendOutcome) {
  return (
    SPEND_OUTCOME_TEXTURE_MARK_COLORS[outcome] ?? DONUT_SLICE_TEXTURE_MARK_COLOR
  );
}

const TEXTURED_OUTCOMES = Object.values(SpendOutcome).filter((outcome) =>
  isTexturedSlice(SPEND_OUTCOME_TEXTURES[outcome])
);

describe("spend-by-outcome texture marks (ISS-5362)", () => {
  it("has a textured bucket to check in the first place", () => {
    // Guards the loops below: if the texture map were ever emptied, every
    // `for` here would pass vacuously and this file would stop testing anything.
    expect(TEXTURED_OUTCOMES.length).toBeGreaterThan(0);
    expect(TEXTURED_OUTCOMES).not.toContain(SpendOutcome.Clean);
  });

  it("keeps every mark legible on the slice it is drawn on, in both themes", () => {
    for (const theme of Object.values(A11yTheme)) {
      for (const outcome of TEXTURED_OUTCOMES) {
        const ratio = contrastRatio(
          resolveThemeColor(theme, markColorFor(outcome)),
          renderedSlice(theme, outcome)
        );

        expect(
          ratio,
          `${theme} ${outcome} mark ${markColorFor(outcome)} on its slice`
        ).toBeGreaterThanOrEqual(ContrastThreshold.NonText);
      }
    }
  });

  it("overrides the mark colour exactly where the default would be invisible", () => {
    // Not "Unknown is overridden" — WHY it is. The default is card-coloured, so
    // a slice's own contrast against the card IS its default mark's contrast.
    // A bucket that clears the floor against the card must keep the default (a
    // gratuitous dark mark would read as a fifth colour); one that does not
    // must override it. This is the rule, so a future palette change moves the
    // override to the right bucket instead of leaving it stranded on this one.
    for (const outcome of TEXTURED_OUTCOMES) {
      for (const theme of Object.values(A11yTheme)) {
        const clearsCardOnItsOwn =
          contrastRatio(
            resolveThemeColor(theme, DONUT_SLICE_TEXTURE_MARK_COLOR),
            renderedSlice(theme, outcome)
          ) >= ContrastThreshold.NonText;

        if (!clearsCardOnItsOwn) {
          expect(
            SPEND_OUTCOME_TEXTURE_MARK_COLORS[outcome],
            `${theme} ${outcome} cannot carry card-coloured marks`
          ).toBeDefined();
        }
      }
    }
  });

  it("adds no override where the default already clears the floor", () => {
    // The other half of the rule above, and the half that keeps the map honest
    // now that it is EMPTY. The rule test passes vacuously on an empty map, so
    // this pins WHY it is empty: every textured bucket clears the floor on the
    // default card mark, so any entry here would be a gratuitous dark mark —
    // which reads as a fifth colour on a channel whose whole point is that it
    // adds none. Before ISS-5335 the faint `Unknown` slice genuinely needed an
    // override; at full `--muted-foreground` it is the highest-contrast slice
    // on the ring and the override inverted (see the palette docstring).
    for (const outcome of TEXTURED_OUTCOMES) {
      for (const theme of Object.values(A11yTheme)) {
        expect(
          contrastRatio(
            resolveThemeColor(theme, DONUT_SLICE_TEXTURE_MARK_COLOR),
            renderedSlice(theme, outcome)
          ),
          `${theme} ${outcome} default card mark on its slice`
        ).toBeGreaterThanOrEqual(ContrastThreshold.NonText);
      }

      expect(
        SPEND_OUTCOME_TEXTURE_MARK_COLORS[outcome],
        `${outcome} clears the floor on the default, so it must not override it`
      ).toBeUndefined();
    }
  });

  it("draws every mark in an ACHROMATIC token, so the channel adds no fifth hue", () => {
    // A texture is redundancy for a reader who cannot use hue. A mark that
    // introduced one would be a fifth category colour wearing a pattern.
    for (const theme of Object.values(A11yTheme)) {
      for (const outcome of TEXTURED_OUTCOMES) {
        const { r, g, b } = resolveThemeColor(theme, markColorFor(outcome));
        const spread = Math.max(r, g, b) - Math.min(r, g, b);

        expect(
          spread,
          `${theme} ${outcome} mark ${markColorFor(outcome)} is not neutral`
        ).toBeLessThanOrEqual(NEUTRAL_CHANNEL_SPREAD);
      }
    }
  });
});

/**
 * How far apart the R/G/B channels may sit and still read as neutral. The dark
 * theme's neutrals carry a deliberate 0.002-chroma cast, so an exact match
 * would fail on a token that is achromatic in every sense that matters.
 */
const NEUTRAL_CHANNEL_SPREAD = 6;
