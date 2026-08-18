import { describe, expect, it } from "vitest";
import {
  authPageAppearance,
  githubFirstAuthPageAppearance,
} from "../components/appearance";
import { HEX_COLOR_PATTERN } from "./appearance-token-patterns";

// Provider-scoped Clerk element keys that the GitHub-first variant targets.
// Hoisted to top-level so the assertions read as a contract and Biome does not
// flag repeated inline literals.
const GITHUB_BUTTON_KEY = "socialButtonsBlockButton__github";
const GITHUB_ICON_KEY = "socialButtonsProviderIcon__github";
const GOOGLE_BUTTON_KEY = "socialButtonsBlockButton__google";
const FORM_BUTTON_PRIMARY_KEY = "formButtonPrimary";
const PRIMARY_TOKEN = "var(--primary)";
const SECONDARY_TOKEN = "var(--secondary)";

/**
 * Reads a nested element style off an appearance object as a plain record so
 * the tests can assert on individual CSS-token values without fighting Clerk's
 * broad `Elements` union type.
 */
function elementStyle(
  appearance: typeof authPageAppearance,
  key: string
): Record<string, unknown> {
  const elements = appearance.elements as Record<string, unknown>;
  return (elements[key] ?? {}) as Record<string, unknown>;
}

describe("auth page appearance", () => {
  describe("authPageAppearance (shared base overrides)", () => {
    it("keeps the email submit button as the filled primary", () => {
      expect(elementStyle(authPageAppearance, FORM_BUTTON_PRIMARY_KEY)).toEqual(
        expect.objectContaining({ background: PRIMARY_TOKEN })
      );
    });

    it("does not emphasize any individual social provider", () => {
      const elements = authPageAppearance.elements as Record<string, unknown>;
      expect(elements[GITHUB_BUTTON_KEY]).toBeUndefined();
      expect(elements[GOOGLE_BUTTON_KEY]).toBeUndefined();
    });
  });

  describe("githubFirstAuthPageAppearance (default appearance)", () => {
    it("promotes the GitHub social button to the filled primary", () => {
      expect(
        elementStyle(githubFirstAuthPageAppearance, GITHUB_BUTTON_KEY)
      ).toEqual(expect.objectContaining({ background: PRIMARY_TOKEN }));
    });

    it("inverts the GitHub provider icon so it reads on the filled button", () => {
      expect(
        elementStyle(githubFirstAuthPageAppearance, GITHUB_ICON_KEY)
      ).toEqual(expect.objectContaining({ filter: expect.any(String) }));
    });

    it("de-emphasizes Google to an outline button using border/background tokens", () => {
      const google = elementStyle(
        githubFirstAuthPageAppearance,
        GOOGLE_BUTTON_KEY
      );
      expect(google).toEqual(
        expect.objectContaining({
          background: "var(--background)",
          borderColor: "var(--border)",
        })
      );
      expect(google.background).not.toBe(PRIMARY_TOKEN);
    });

    it("demotes the email/password submit from primary to secondary", () => {
      expect(
        elementStyle(githubFirstAuthPageAppearance, FORM_BUTTON_PRIMARY_KEY)
      ).toEqual(expect.objectContaining({ background: SECONDARY_TOKEN }));
    });

    it("preserves the shared base overrides (logo hidden, no card shadow)", () => {
      expect(githubFirstAuthPageAppearance.options).toEqual(
        authPageAppearance.options
      );
      const elements = githubFirstAuthPageAppearance.elements as Record<
        string,
        unknown
      >;
      expect(elements.headerSubtitle).toBe("hidden");
    });

    it("only reuses themeable CSS custom properties, never hard-coded hex", () => {
      const serialized = JSON.stringify(githubFirstAuthPageAppearance.elements);
      expect(serialized).not.toMatch(HEX_COLOR_PATTERN);
    });
  });

  describe("default appearance contract (FEA-4059)", () => {
    it("makes GitHub-first distinct from the shared base overrides", () => {
      // The base still carries the filled email primary; the default rendered
      // appearance must diverge from it so the GitHub-first hierarchy is live
      // rather than parked behind the wound-down flag.
      expect(githubFirstAuthPageAppearance).not.toBe(authPageAppearance);
      expect(
        elementStyle(githubFirstAuthPageAppearance, FORM_BUTTON_PRIMARY_KEY)
          .background
      ).not.toBe(
        elementStyle(authPageAppearance, FORM_BUTTON_PRIMARY_KEY).background
      );
    });
  });
});
