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
import { getStatusColor } from "../../components/detail/agent-tree-utils";
import { STATUS_DOT_TONE } from "../component-meta";

/**
 * ISS-5541 part 1 — the colour-contrast pass the 2026-08-08 Agents sweep could
 * not do.
 *
 * The ticket's premise was that no contrast claim was trustworthy because the
 * converters used mis-parsed the `oklch()` / `lab()` tokens. That premise is now
 * STALE: ISS-5365 landed an OKLCH/OKLAB/LAB-aware parser in
 * `packages/app/test/a11y/contrast.ts`, and `theme-tokens.node.ts` reads the
 * declared values straight out of `globals.css` rather than from a hand-copied
 * table. This file is that pass, run against the Agents surface's own colour
 * maps, in BOTH themes, and kept in CI so the surface cannot silently go
 * unmeasured again.
 *
 * WHAT IS MEASURED. The status dot is the case the ticket called out: at
 * `size-1.5` with `role="img"` and no adjacent text it is the SOLE carrier of
 * the state, so WCAG 2.2 SC 1.4.11 Non-text Contrast (Level AA) applies at
 * 3:1 against the surface it sits on.
 *
 * WHAT IS NOT CLAIMED. One pair measured BELOW the floor today. It is
 * pinned in {@link BELOW_FLOOR_TODAY} with its measured ratio rather than
 * quietly excluded, because moving a shared semantic colour token is a design
 * decision about what these states look like everywhere in the product, not an
 * accessibility lane's call — that is escalated on ISS-5541, not decided here.
 * Pinning them means a token fix turns this file red and forces the entry to
 * move up into the passing set, so the debt cannot be forgotten either way.
 */

/** The failure `assertContrastPair` raises, matched so a pin cannot pass on an
 * unrelated throw. */
const BELOW_CONTRAST_FLOOR_MESSAGE = /below WCAG threshold/;

const THEMES = [A11yTheme.Light, A11yTheme.Dark] as const;

/** The surface an Agents status dot is painted on: a table row inside a card. */
const DOT_SURFACE = "--card";

describe("Agents status dots (WCAG 2.2 SC 1.4.11)", () => {
  it.each([
    { tone: "new", theme: A11yTheme.Light },
    { tone: "new", theme: A11yTheme.Dark },
    { tone: "active", theme: A11yTheme.Light },
  ] as const)(
    "clears the non-text floor for the $tone dot in $theme",
    ({ tone, theme }) => {
      assertContrastPair({
        background: themeToken(theme, DOT_SURFACE),
        foreground: resolveThemeColor(theme, STATUS_DOT_TONE[tone]),
        label: `"${tone}" status dot on ${DOT_SURFACE} in ${theme}`,
        threshold: ContrastThreshold.NonText,
      });
    }
  );

  /**
   * Measured 2026-08-23 against `globals.css`. Each entry is a real, shipped
   * pair that does NOT clear SC 1.4.11, recorded with the ratio it measured.
   * Escalated on ISS-5541: the remedy is a token change, and which colour these
   * states carry across the product is a design decision.
   */
  const BELOW_FLOOR_TODAY = [
    // `--primary` (oklch(0.542 0.214 266)) on the dark `--card`. The same token
    // ISS-4793 already split `--link` out of for the text case, for this reason.
    { tone: "active", theme: A11yTheme.Dark, measured: 2.98 },
  ] as const;

  it.each(BELOW_FLOOR_TODAY)(
    "records the $tone dot in $theme as still below the floor at ~$measured:1",
    ({ tone, theme, measured }) => {
      expect(
        contrastRatio(
          parseCssColor(resolveThemeColor(theme, STATUS_DOT_TONE[tone])),
          parseCssColor(themeToken(theme, DOT_SURFACE))
        )
      ).toBeCloseTo(measured, 1);
      expect(() =>
        assertContrastPair({
          background: themeToken(theme, DOT_SURFACE),
          foreground: resolveThemeColor(theme, STATUS_DOT_TONE[tone]),
          label: `"${tone}" status dot on ${DOT_SURFACE} in ${theme}`,
          threshold: ContrastThreshold.NonText,
        })
      ).toThrow(BELOW_CONTRAST_FLOOR_MESSAGE);
    }
  );

  it("keeps the two dot tones distinguishable from each other, not only from the card", () => {
    // The two dots mean different things ("invoked in the last hour" vs
    // "discovered in the last 7 days") and carry no text, so hue is the whole
    // message. A reader who cannot tell them apart reads one signal, not two —
    // and that is what SC 1.4.1 warns about when meaning rides on colour alone.
    for (const theme of THEMES) {
      expect(
        contrastRatio(
          parseCssColor(resolveThemeColor(theme, STATUS_DOT_TONE.active)),
          parseCssColor(resolveThemeColor(theme, STATUS_DOT_TONE.new))
        )
      ).toBeGreaterThan(1.2);
    }
  });
});

/**
 * ISS-5541, the structural finding the ratio table exposes: these markers are
 * painted from the raw Tailwind palette rather than from a theme token, so a
 * SINGLE value has to serve a near-white card and a near-black one. Nothing in
 * the token system can fix them; the fix is to move them onto tokens.
 */
describe("Agent tree status markers are theme-invariant", () => {
  const MARKER_STATUSES = [
    "completed",
    "failed",
    "running",
    "awaiting_input",
    "unknown-status",
  ];

  it("paints every marker from a palette class that cannot track the theme", () => {
    // Asserted through the production entry point rather than by reading the
    // source: the point is what a status RESOLVES to, and a status the switch
    // does not name falls through to the same fixed grey as the rest.
    const painted = MARKER_STATUSES.map((status) => getStatusColor(status));

    expect(painted.every((cls) => cls.startsWith("bg-"))).toBe(true);
    // No marker reads a CSS custom property, so none of them differs between
    // light and dark. This is the finding, stated as a check so that moving one
    // onto a token trips it and the fix gets the contrast assertion it needs.
    expect(painted.filter((cls) => cls.includes("var(--"))).toEqual([]);
    expect(new Set(painted).size).toBeGreaterThan(1);
  });
});
