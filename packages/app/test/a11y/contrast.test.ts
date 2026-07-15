import { describe, expect, it } from "vitest";
import {
  assertContrastPair,
  ContrastThreshold,
  contrastRatio,
  parseCssColor,
  resolveCompositedBackground,
} from "./contrast";

const SYNTHETIC_REGRESSION_ERROR_PATTERN =
  /synthetic regression contrast .* below WCAG threshold/;
const TRANSLUCENT_REGRESSION_ERROR_PATTERN =
  /translucent background regression contrast/;

describe("a11y contrast helper", () => {
  it("accepts readable foreground and background pairs", () => {
    expect(
      contrastRatio(parseCssColor("#111827"), parseCssColor("#ffffff"))
    ).toBeGreaterThanOrEqual(ContrastThreshold.NormalText);
    expect(() =>
      assertContrastPair({
        background: "rgb(255, 255, 255)",
        foreground: "rgb(17, 24, 39)",
        label: "readable text",
      })
    ).not.toThrow();
  });

  it("rejects the required synthetic low-contrast regression fixture", () => {
    expect(() =>
      assertContrastPair({
        background: "#ffffff",
        foreground: "#d1d5db",
        label: "synthetic regression",
      })
    ).toThrow(SYNTHETIC_REGRESSION_ERROR_PATTERN);
  });

  it("parses OKLCH colors emitted by modern browsers", () => {
    const color = parseCssColor("oklch(70% 0.1 120 / 50%)");

    expect(color.alpha).toBe(0.5);
    expect(color.r).toBeGreaterThanOrEqual(0);
    expect(color.r).toBeLessThanOrEqual(255);
    expect(color.g).toBeGreaterThanOrEqual(0);
    expect(color.g).toBeLessThanOrEqual(255);
    expect(color.b).toBeGreaterThanOrEqual(0);
    expect(color.b).toBeLessThanOrEqual(255);
  });

  it("parses modern space-separated RGB colors", () => {
    const color = parseCssColor("rgb(10 20 30 / 50%)");

    expect(color).toEqual({ alpha: 0.5, b: 30, g: 20, r: 10 });
  });

  it("composites translucent background layers before checking contrast", () => {
    const background = resolveCompositedBackground([
      "rgba(255, 255, 255, 0.8)",
      "rgb(0, 0, 0)",
    ]);

    expect(background).toBe("rgb(204, 204, 204)");
    expect(() =>
      assertContrastPair({
        background,
        foreground: "rgb(255, 255, 255)",
        label: "translucent background regression",
      })
    ).toThrow(TRANSLUCENT_REGRESSION_ERROR_PATTERN);
  });
});
