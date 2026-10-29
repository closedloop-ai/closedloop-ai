import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  A11yTheme,
  assertContrastPair,
  ContrastThreshold,
} from "../../../../test/a11y/contrast";
import { themeToken } from "../../../../test/a11y/theme-tokens.node";

/**
 * ISS-12117 — the Session Timeline's own marker tokens, declared in
 * `styles-session-timeline.css` rather than the design system's `globals.css`
 * (which `theme-tokens.node.ts` reads), so this file reads them itself.
 *
 * Two things are pinned:
 * - each token is declared in BOTH theme blocks. Dropping the `.dark` block
 *   leaves dark mode painting the light values, a regression nothing else in
 *   jsdom would notice;
 * - each mark clears WCAG 2.2 SC 1.4.11's 3:1 against the surfaces it is drawn
 *   on: the strip's `--background`, and `--popover` for the hover card.
 */

const TIMELINE_CSS = readFileSync(
  path.resolve(import.meta.dirname, "../../../../styles-session-timeline.css"),
  "utf8"
).replace(/\/\*[\s\S]*?\*\//g, "");

const MARKER_TOKENS = [
  "--sd3-marker-steering",
  "--sd3-marker-delivery",
  "--sd3-marker-failure",
] as const;

const THEME_SELECTOR = {
  [A11yTheme.Light]: ":root",
  [A11yTheme.Dark]: ".dark",
} as const;

const SURFACES = ["--background", "--popover"] as const;
const OKLCH_VALUE = /^oklch\(/;

const CASES = [A11yTheme.Light, A11yTheme.Dark].flatMap((theme) =>
  MARKER_TOKENS.flatMap((token) =>
    SURFACES.map((surface) => ({ surface, theme, token }))
  )
);

describe("Session Timeline marker tokens (ISS-12117)", () => {
  it.each(
    [A11yTheme.Light, A11yTheme.Dark].flatMap((theme) =>
      MARKER_TOKENS.map((token) => ({ theme, token }))
    )
  )("declares $token in the $theme block", ({ theme, token }) => {
    expect(markerToken(theme, token)).toMatch(OKLCH_VALUE);
  });

  it("gives dark mode its own values, not the light ones", () => {
    for (const token of MARKER_TOKENS) {
      expect(markerToken(A11yTheme.Dark, token)).not.toBe(
        markerToken(A11yTheme.Light, token)
      );
    }
  });

  it.each(CASES)(
    "$token clears 3:1 on $surface in $theme",
    ({ surface, theme, token }) => {
      expect(() =>
        assertContrastPair({
          background: themeToken(theme, surface),
          foreground: markerToken(theme, token) ?? "",
          label: `${token} on ${surface} in ${theme}`,
          threshold: ContrastThreshold.NonText,
        })
      ).not.toThrow();
    }
  );
});

/** The value `token` is declared with in exactly `theme`'s selector block. */
function markerToken(theme: A11yTheme, token: string): string | undefined {
  for (const match of TIMELINE_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((match[1] ?? "").trim() !== THEME_SELECTOR[theme]) {
      continue;
    }
    const declaration = new RegExp(`${token}\\s*:\\s*([^;]+);`).exec(
      match[2] ?? ""
    );
    if (declaration) {
      return declaration[1]?.trim();
    }
  }
  return undefined;
}
