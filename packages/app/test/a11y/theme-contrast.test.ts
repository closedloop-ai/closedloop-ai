import { describe, expect, it } from "vitest";
import { A11yTheme, contrastRatio, parseCssColor } from "./contrast";
import {
  CONTRAST_PAIRS,
  Enforcement,
  measureTheme,
} from "./theme-contrast-pairs.node";
import { themeToken } from "./theme-tokens.node";

/**
 * ISS-5541 part 1, the rest of the sweep — SC 1.4.3 (text) alongside SC 1.4.11
 * (non-text), in both themes, over the shared vocabulary the Agents screens are
 * built from. The two Agents status dots on `--card` are measured by
 * `agents/lib/__tests__/agents-status-colour-contrast.test.ts` and deliberately
 * not repeated here.
 *
 * The ticket's premise — that no contrast claim was trustworthy because the
 * converters mis-parsed `oklch()`/`lab()` — is stale: ISS-5365's parser in
 * `./contrast.ts` handles all three forms and is pinned by `contrast.test.ts`.
 * So this file adds pairs and a baseline, not a second converter.
 *
 * WHAT THE FAILING BASELINE MEANS. Every entry below is a real, shipped pair
 * that does not clear its floor, recorded with the ratio it measures. It is
 * ESCALATED on ISS-5541, not accepted and not fixed here: moving a shared
 * semantic token is a design decision about what these states look like across
 * the product. Pinning them cuts both ways — a regression that breaks a passing
 * pair turns this red, and so does a token fix, which forces the entry out of
 * the list. The dimension cannot quietly go unmeasured again in either
 * direction.
 */

const EXPECTED_PAIR_COUNT = 120;
const RATIO_TOLERANCE = 0.05;
const BUTTON_FOCUS_RING_ID = /^button \w+ focus ring on /;
const BADGE_FOCUS_RING_ID = /^badge \w+ focus ring on /;
const INVALID_FOCUS_RING_ID = /^invalid focus ring on /;
const HAND_ROLLED_FOCUS_RECIPE_ID =
  /^(chip recipe|focus-within frame) focus ring on /;

/** Light-theme pairs that do NOT clear their floor, with the measured ratio. */
const LIGHT_REQUIRED_FAILURES: Readonly<Record<string, number>> = {
  "badge destructive text": 4.06,
  "alert destructive title": 3.91,
  "alert destructive description": 3.55,
  "badge error text": 3.33,
  "badge success text": 2.82,
  "badge info text": 3.32,
  // The two below entered the list on 2026-08-24, when #5867 applied the
  // Style Lab export to `:root` — `--link` oklch(0.47 0.214 267) → #93c5fd and
  // `--ai`/`--ai-foreground` → #5b21b6/#ddd6fe. That PR's own body records the
  // link risk at "1.75:1"; this sweep reads the shipped token and gets 1.74,
  // which is the sweep doing the job it was written for. Escalated on ISS-5541
  // with the rest, not accepted here. "badge ai text" (1.13) left the list on
  // 2026-10-21: ISS-12850 set the light `--ai-foreground` to #5b21b6 (Nerys).
  "link on background": 1.74,
  "link on card": 1.74,
  "alert error title": 3.33,
  "alert error description": 3.06,
  "agents active dot at pulse trough on background": 1.99,
  "agents active dot at pulse trough on card": 1.99,
  "agents new dot at pulse trough on background": 1.64,
  "agents new dot at pulse trough on card": 1.64,
  "input border on background": 1.21,
  "input border on card": 1.21,
  // PRD-722's inline edit save and validation message reads `--destructive`,
  // the token the alert and badge entries above already fail on; the token
  // fix is ISS-12770.
  "inline edit feedback on background": 3.92,
};

const LIGHT_INFORMATIONAL_FAILURES: Readonly<Record<string, number>> = {
  "success dot in pill": 2.82,
};

const DARK_REQUIRED_FAILURES: Readonly<Record<string, number>> = {
  "badge error text": 3.52,
  "alert destructive title": 3.89,
  "alert destructive description": 3.36,
  "badge info text": 2.89,
  "badge accent text": 2.74,
  "alert error title": 3.52,
  "alert error description": 3.09,
  "agents active dot at pulse trough on background": 1.59,
  "agents active dot at pulse trough on card": 1.57,
  "agents new dot at pulse trough on background": 2.19,
  "agents new dot at pulse trough on card": 2.16,
  "input border on background": 1.25,
  "input border on card": 1.24,
  "inline edit feedback on background": 4.07,
};

const DARK_INFORMATIONAL_FAILURES: Readonly<Record<string, number>> = {
  "info dot in pill": 2.89,
  "accent dot in pill": 2.74,
};

const THEME_BASELINES = [
  {
    theme: A11yTheme.Light,
    required: LIGHT_REQUIRED_FAILURES,
    informational: LIGHT_INFORMATIONAL_FAILURES,
  },
  {
    theme: A11yTheme.Dark,
    required: DARK_REQUIRED_FAILURES,
    informational: DARK_INFORMATIONAL_FAILURES,
  },
] as const;

function failingIds(
  theme: A11yTheme,
  enforcement: Enforcement
): readonly string[] {
  return measureTheme(theme, CONTRAST_PAIRS)
    .filter(
      (measurement) =>
        !measurement.passes && measurement.enforcement === enforcement
    )
    .map((measurement) => measurement.id)
    .sort();
}

describe("theme contrast measurement", () => {
  it("rests on a luminance implementation that reproduces a published ratio", () => {
    // Every ratio pinned below is only as good as `contrast.ts`'s luminance. Two
    // independently published anchors, so a change there cannot silently shift
    // this whole baseline: #767676 is the canonical smallest grey clearing SC
    // 1.4.3 on white, and black-on-white is the definitional maximum.
    expect(
      contrastRatio(parseCssColor("#767676"), parseCssColor("#ffffff"))
    ).toBeCloseTo(4.54, 2);
    expect(
      contrastRatio(parseCssColor("#000000"), parseCssColor("#ffffff"))
    ).toBeCloseTo(21, 5);
  });

  it("reads both theme blocks out of the stylesheet", () => {
    // Independent literals: if the parser ever reads nothing, or reads `:root`
    // for both themes, these stop matching rather than degrading into a silent
    // pass over an empty token table.
    expect(themeToken(A11yTheme.Light, "--background")).toBe(
      "oklch(0.989 0 0)"
    );
    expect(themeToken(A11yTheme.Dark, "--background")).toBe(
      "oklch(0.24 0.005 270)"
    );
  });

  it.each(THEME_BASELINES)("measures every $theme-theme pair", ({ theme }) => {
    const measurements = measureTheme(theme, CONTRAST_PAIRS);
    // Guards the vacuous run: a table that lost its entries would find no
    // failures and pass.
    expect(measurements).toHaveLength(EXPECTED_PAIR_COUNT);
    for (const measurement of measurements) {
      expect(Number.isFinite(measurement.ratio)).toBe(true);
      expect(measurement.ratio).toBeGreaterThanOrEqual(1);
    }
  });

  it.each(THEME_BASELINES)(
    "reports exactly the recorded $theme-theme conformance failures",
    ({ theme, required }) => {
      expect(failingIds(theme, Enforcement.Required)).toEqual(
        Object.keys(required).sort()
      );
    }
  );

  it.each(THEME_BASELINES)(
    "reports exactly the recorded $theme-theme informational failures",
    ({ theme, informational }) => {
      // Kept a separate bucket so a NEW conformance failure can never be
      // absorbed into the softer list, and vice versa.
      expect(failingIds(theme, Enforcement.Informational)).toEqual(
        Object.keys(informational).sort()
      );
    }
  );

  it.each(THEME_BASELINES)(
    "holds each recorded $theme-theme failure at its measured ratio",
    ({ theme, required, informational }) => {
      const measurements = measureTheme(theme, CONTRAST_PAIRS);
      for (const [id, expected] of Object.entries({
        ...required,
        ...informational,
      })) {
        const measurement = measurements.find((entry) => entry.id === id);
        expect(measurement, `no pair named "${id}"`).toBeDefined();
        // A token edit that makes a known failure WORSE must not pass silently
        // just because the pair was already on the list.
        expect(measurement?.ratio).toBeGreaterThan(expected - RATIO_TOLERANCE);
        expect(measurement?.ratio).toBeLessThan(expected + RATIO_TOLERANCE);
      }
    }
  );

  it.each(THEME_BASELINES)(
    "gives every DS Button variant a $theme-theme focus ring of at least 3:1",
    ({ theme }) => {
      // ISS-9063. Asserted directly rather than only through the failure list
      // above, so the acceptance bar is legible on its own. The floor is WCAG
      // 1.4.11's 3:1, written as a literal so it shares nothing with the harness.
      const rings = measureTheme(theme, CONTRAST_PAIRS).filter((measurement) =>
        BUTTON_FOCUS_RING_ID.test(measurement.id)
      );
      // Seven variants on three surfaces; guards a filter that matches nothing.
      expect(rings).toHaveLength(21);
      for (const ring of rings) {
        expect(ring.ratio, ring.id).toBeGreaterThanOrEqual(3);
      }
    }
  );

  it.each(THEME_BASELINES)(
    "gives every DS Badge variant a $theme-theme focus ring of at least 3:1",
    ({ theme }) => {
      // ISS-9063 review. Badge is focusable through `asChild` and carried the
      // same `ring-destructive/20` override this ticket removed from Button, so
      // the Button-only sweep above reported green over a broken sibling. Its
      // own case, at the same 3:1 literal.
      const rings = measureTheme(theme, CONTRAST_PAIRS).filter((measurement) =>
        BADGE_FOCUS_RING_ID.test(measurement.id)
      );
      // Twelve variants on three surfaces; guards a filter that matches nothing.
      expect(rings).toHaveLength(36);
      for (const ring of rings) {
        expect(ring.ratio, ring.id).toBeGreaterThanOrEqual(3);
      }
    }
  );

  it.each(THEME_BASELINES)(
    "gives a focused invalid field a $theme-theme ring of at least 3:1",
    ({ theme }) => {
      // ISS-9063 review. `aria-invalid:ring-destructive/20` used to win over
      // `focus-visible:ring-ring` on this state, so the focus indicator was the
      // 20% halo. Pinned as its own case because the Button sweep above cannot
      // reach it: the state is composed, not a Button variant.
      const rings = measureTheme(theme, CONTRAST_PAIRS).filter((measurement) =>
        INVALID_FOCUS_RING_ID.test(measurement.id)
      );
      expect(rings).toHaveLength(2);
      for (const ring of rings) {
        expect(ring.ratio, ring.id).toBeGreaterThanOrEqual(3);
      }
    }
  );

  it.each(THEME_BASELINES)(
    "gives the shared hand-rolled focus recipes a $theme-theme focus ring of at least 3:1",
    ({ theme }) => {
      // ISS-11058. The recipes the swept `packages/app` and `apps/app` sites
      // compose instead of restating `ring-ring/50`, which measured 2.16:1.
      const rings = measureTheme(theme, CONTRAST_PAIRS).filter((measurement) =>
        HAND_ROLLED_FOCUS_RECIPE_ID.test(measurement.id)
      );
      // Two recipes on three surfaces; guards a filter that matches nothing.
      expect(rings).toHaveLength(6);
      for (const ring of rings) {
        expect(ring.ratio, ring.id).toBeGreaterThanOrEqual(3);
      }
    }
  );

  it("finds different failures in the two themes", () => {
    // Cheap proof the dark pass is not the light pass repeated.
    expect(Object.keys(LIGHT_REQUIRED_FAILURES).sort()).not.toEqual(
      Object.keys(DARK_REQUIRED_FAILURES).sort()
    );
  });
});
