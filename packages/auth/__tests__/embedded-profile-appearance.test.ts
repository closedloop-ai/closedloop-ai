import { describe, expect, it } from "vitest";
import {
  embeddedOrganizationProfileAppearance,
  embeddedProfileAppearance,
} from "../components/appearance";
import {
  collectAppearanceStrings,
  HEX_COLOR_PATTERN,
  RAW_PIXEL_PATTERN,
} from "./appearance-token-patterns";

// FEA-3965: the Settings Profile/Organization tabs embed Clerk's <UserProfile> /
// <OrganizationProfile>. These configs theme that embedded UI onto the
// design-system tokens so the Clerk seam disappears. The embed renders through
// @clerk/nextjs (clerk-js / Emotion) with cssLayerName unset, so the overrides
// are Clerk style objects backed by DS CSS vars — the shape that actually wins
// over Clerk's own rules. The tests assert the token-only contract (no
// hard-coded hex, no raw px outside the `1px solid var(--border)` border idiom)
// and the shared/derived shape so a future edit that reintroduces off-token
// values or drops the slug-hide fails here rather than in production.

// Element keys whose values carry the design-system chrome the VQA flagged: the
// card wrapper, the inner Account/Profile/Security navigation rail, and the
// form controls inside the embed.
const DESIGN_SYSTEM_CHROME_ELEMENT_KEYS = [
  "card",
  "cardBox",
  "navbar",
  "navbarButton",
  "navbarButton__active",
  "navbarButtonIcon",
  "formButtonPrimary",
  "formFieldInput",
  "profileSectionPrimaryButton",
  "badge",
  "membersPageInviteButton",
] as const;

// A hairline border (`1px solid var(--token)`), the focus-ring box-shadow
// (`0 0 0 3px color-mix(... var(--ring) ...)`), and the pill radius (`9999px`,
// what DS `rounded-full` compiles to) are the intentional raw-pixel idioms —
// structural widths/radii that mirror the DS Input + Badge recipes, not
// hard-coded colors or sizes. Everything else must resolve to a DS token.
const RAW_PIXEL_IDIOM_PATTERNS = [
  /^1px solid var\(--[\w-]+\)$/,
  /^0 0 0 3px color-mix\(in oklab, var\(--ring\) \d+%, transparent\)$/,
  /^9999px$/,
];

function elementStyle(
  appearance: typeof embeddedProfileAppearance,
  key: string
): Record<string, unknown> {
  const elements = appearance.elements as Record<string, unknown>;
  return (elements[key] ?? {}) as Record<string, unknown>;
}

describe("embedded Clerk profile appearance (FEA-3965)", () => {
  it("themes the embedded UserProfile chrome with design-system token style objects", () => {
    const elements = embeddedProfileAppearance.elements as Record<
      string,
      unknown
    >;
    // Every chrome key the VQA called out is styled — not left to Clerk defaults.
    for (const key of DESIGN_SYSTEM_CHROME_ELEMENT_KEYS) {
      expect(elements[key], `missing appearance for "${key}"`).toBeDefined();
    }
    // The inner navigation rail (the "second navigation") reads as part of the
    // app: DS border + foreground text, with an active treatment mirroring our
    // TabsTrigger.
    expect(elementStyle(embeddedProfileAppearance, "navbar")).toEqual(
      expect.objectContaining({ borderRight: "1px solid var(--border)" })
    );
    expect(elementStyle(embeddedProfileAppearance, "navbarButton")).toEqual(
      expect.objectContaining({ color: "var(--foreground)" })
    );
    expect(
      elementStyle(embeddedProfileAppearance, "navbarButton__active")
    ).toEqual(expect.objectContaining({ background: "var(--muted)" }));
    // The Clerk card chrome is flattened so it does not stack a second card
    // language on top of the DS Card wrapper.
    expect(elementStyle(embeddedProfileAppearance, "cardBox")).toEqual(
      expect.objectContaining({ boxShadow: "none", border: "none" })
    );
  });

  it("matches the DS Input recipe on the embedded form fields, focus ring included", () => {
    const input = elementStyle(embeddedProfileAppearance, "formFieldInput");
    expect(input).toEqual(
      expect.objectContaining({
        background: "var(--input)",
        borderColor: "var(--input-border)",
      })
    );
    // The focus treatment matches DS `focus-visible:border-ring` + ring.
    expect(input["&:focus"]).toEqual(
      expect.objectContaining({ borderColor: "var(--ring)" })
    );
  });

  it("keeps a single filled primary: profile-section actions are demoted, form submit and invite stay primary", () => {
    // The small profile-section actions are quiet (transparent), not a column
    // of filled primary buttons.
    expect(
      elementStyle(embeddedProfileAppearance, "profileSectionPrimaryButton")
    ).toEqual(expect.objectContaining({ background: "transparent" }));
    // Clerk's form submit and the members invite remain the filled primary.
    expect(
      elementStyle(embeddedProfileAppearance, "formButtonPrimary")
    ).toEqual(expect.objectContaining({ background: "var(--primary)" }));
    expect(
      elementStyle(embeddedProfileAppearance, "membersPageInviteButton")
    ).toEqual(expect.objectContaining({ background: "var(--primary)" }));
  });

  it("styles the badge as the DS muted pill (radius + muted fill + border)", () => {
    const badge = elementStyle(embeddedProfileAppearance, "badge");
    expect(badge).toEqual(
      expect.objectContaining({
        color: "var(--muted-foreground)",
        borderColor: "var(--border)",
        borderRadius: "9999px",
        fontSize: "0.75rem",
      })
    );
  });

  it("uses only design-system tokens — no hard-coded hex colors or raw pixels", () => {
    for (const appearance of [
      embeddedProfileAppearance,
      embeddedOrganizationProfileAppearance,
    ]) {
      // Walks strings nested inside object-valued rules too, so a
      // `backgroundColor: "#fff"` or `width: "12px"` buried in a style object
      // cannot slip past the token-only check.
      const values = collectAppearanceStrings(appearance.elements);
      for (const value of values) {
        expect(
          HEX_COLOR_PATTERN.test(value),
          `hard-coded hex color in "${value}"`
        ).toBe(false);
        // Raw pixels are forbidden except the intentional structural idioms
        // (hairline border, focus ring, pill radius) that mirror the DS recipes.
        if (RAW_PIXEL_IDIOM_PATTERNS.some((pattern) => pattern.test(value))) {
          continue;
        }
        expect(
          RAW_PIXEL_PATTERN.test(value),
          `raw pixel value in "${value}"`
        ).toBe(false);
      }
    }
  });

  it("derives the OrganizationProfile appearance from the shared config and hides the native slug field", () => {
    const orgElements =
      embeddedOrganizationProfileAppearance.elements as Record<string, unknown>;
    const profileElements = embeddedProfileAppearance.elements as Record<
      string,
      unknown
    >;
    // SSOT: the org variant extends the shared embedded appearance rather than
    // re-deriving a parallel theme.
    for (const key of DESIGN_SYSTEM_CHROME_ELEMENT_KEYS) {
      expect(orgElements[key]).toEqual(profileElements[key]);
    }
    // We manage the org slug through our own editor, so Clerk's native slug
    // field stays hidden.
    expect(orgElements.formField__slug).toEqual({ display: "none" });
    expect(orgElements.formFieldLabel__slug).toEqual({ display: "none" });
  });
});
