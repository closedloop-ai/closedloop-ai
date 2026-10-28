import { badgeVariants } from "@repo/design-system/components/ui/badge";
import { describe, expect, it } from "vitest";
import {
  ColorProperty,
  requiredUtilityColor,
  UtilityPrefix,
  utilityColor,
} from "./tailwind-color-utility.node";

const MISSING_COLOR_PATTERN = /No bg- colour/;
const AMBIGUOUS_PATTERN = /Ambiguous/;

/**
 * The reader that keeps the contrast sweep bound to the shipped class maps
 * (ISS-5541 review follow-up). Its whole job is to be wrong LOUDLY: a utility it
 * cannot read must throw, because a skipped fill silently measures the bare
 * surface and reports a pass the product never earned.
 */
describe("tailwind colour utility", () => {
  it("compiles an opacity modifier to a premultiplied mix", () => {
    expect(utilityColor("bg-success/12", ColorProperty.Background)).toBe(
      "color-mix(in oklab, var(--success) 12%, transparent)"
    );
  });

  it("reads a bare token as a plain reference", () => {
    expect(utilityColor("bg-primary", ColorProperty.Background)).toBe(
      "var(--primary)"
    );
  });

  it("skips a non-colour utility from the same family", () => {
    // `text-xs` must not resolve into a nonexistent `--xs`, which would throw
    // from the token table and take the whole sweep down.
    expect(utilityColor("text-xs text-destructive", ColorProperty.Text)).toBe(
      "var(--destructive)"
    );
  });

  it("ignores a conditionally-prefixed utility", () => {
    // The hover fill is a different percentage; reading it would measure a
    // surface the resting badge never shows.
    expect(
      utilityColor(
        "bg-destructive/12 [a&]:hover:bg-destructive/18",
        ColorProperty.Background
      )
    ).toBe("color-mix(in oklab, var(--destructive) 12%, transparent)");
  });

  it("reads a dark override only under the dark prefix", () => {
    const classes = "bg-destructive dark:bg-destructive/60";
    expect(utilityColor(classes, ColorProperty.Background)).toBe(
      "var(--destructive)"
    );
    expect(
      utilityColor(classes, ColorProperty.Background, UtilityPrefix.Dark)
    ).toBe("color-mix(in oklab, var(--destructive) 60%, transparent)");
  });

  it("reads the alert description tone", () => {
    expect(
      utilityColor(
        "text-info-foreground *:data-[slot=alert-description]:text-info-foreground/90",
        ColorProperty.Text,
        UtilityPrefix.AlertDescription
      )
    ).toBe("color-mix(in oklab, var(--info-foreground) 90%, transparent)");
  });

  it("reads a bare colour keyword", () => {
    expect(utilityColor("text-white", ColorProperty.Text)).toBe("#ffffff");
  });

  it("reports an absent family as undefined, not a colour", () => {
    expect(
      utilityColor("text-foreground", ColorProperty.Background)
    ).toBeUndefined();
  });

  it("throws when a required colour is absent", () => {
    expect(() =>
      requiredUtilityColor("text-foreground", ColorProperty.Background)
    ).toThrow(MISSING_COLOR_PATTERN);
  });

  it("throws rather than pick between two colours", () => {
    expect(() =>
      utilityColor("bg-success bg-destructive", ColorProperty.Background)
    ).toThrow(AMBIGUOUS_PATTERN);
  });

  it("reads the shipped badge class map, not a transcription of it", () => {
    // The production symbol, so this fails if `error` stops being a tinted
    // destructive pill at all.
    const classes = badgeVariants({ variant: "error" });
    expect(utilityColor(classes, ColorProperty.Text)).toBe(
      "var(--destructive)"
    );
    expect(utilityColor(classes, ColorProperty.Background)).toBe(
      "color-mix(in oklab, var(--destructive) 12%, transparent)"
    );
  });
});
