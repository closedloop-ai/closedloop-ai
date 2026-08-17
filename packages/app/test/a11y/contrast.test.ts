import { describe, expect, it } from "vitest";
import {
  assertContrastPair,
  ColorVisionDeficiency,
  ContrastThreshold,
  contrastRatio,
  parseCssColor,
  resolveCompositedBackground,
  simulateColorVisionDeficiency,
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

  it("parses the OKLab colors Chromium serializes for color-mix backgrounds", () => {
    // The exact computed value Chromium reports for `bg-card/95` (Tailwind's
    // opacity modifier compiles to `color-mix(in oklab, var(--card) 95%,
    // transparent)`), which is what the design system's `Section` card renders.
    const color = parseCssColor("oklab(0.989 0 0 / 0.95)");

    expect(color.alpha).toBeCloseTo(0.95, 5);
    expect(color.r).toBeCloseTo(251, 0);
    expect(color.g).toBeCloseTo(251, 0);
    expect(color.b).toBeCloseTo(251, 0);
  });

  it("resolves OKLab percentage and none components", () => {
    // 100% on the a/b axes is 0.4, not 1, and `none` resolves to 0.
    expect(parseCssColor("oklab(50% none none / none)")).toEqual(
      parseCssColor("oklab(0.5 0 0 / 0)")
    );
    expect(parseCssColor("oklab(0.5 25% -25%)")).toEqual(
      parseCssColor("oklab(0.5 0.1 -0.1)")
    );
  });

  it("parses the CIE lab() the production bundle serves theme tokens as", () => {
    // ISS-5365. `globals.css` authors `--card` as `oklch(0.989 0 0)`, but the
    // built stylesheet contains no `oklch()` at all: Lightning CSS downlevels
    // every token to a hex fallback plus a `lab()`. A browser reading a computed
    // token against `next build` therefore reports the CIE form, and a parser
    // that only knows OKLCH throws `Unsupported CSS color: lab(98.724 0 0)`
    // instead of measuring anything.
    //
    // The hex Lightning CSS emits ALONGSIDE its own `lab()` is the oracle here,
    // so this is the build's arithmetic, not a second copy of ours. Both are
    // the real `--card`, light theme then dark. `parseCssColor` keeps channels
    // unrounded, so these are compared to within a byte.
    const light = parseCssColor("lab(98.724% 0 0)");
    expect([light.r, light.g, light.b].map(Math.round)).toEqual([
      251, 251, 251,
    ]);
    expect(light.alpha).toBe(1);

    const dark = parseCssColor("lab(13.5333% .104085 -3.00337)");
    expect([dark.r, dark.g, dark.b].map(Math.round)).toEqual([33, 35, 39]);
  });

  it("reads the same card from either build pipeline's serialization", () => {
    // The whole point of supporting both: a dev server and Storybook serve the
    // authored `oklch()` while CI serves the downleveled `lab()`, and a spec
    // that measures a ratio has to get the same colour out of both or it is
    // green locally and red in CI for no product reason.
    const authored = parseCssColor("oklch(0.989 0 0)");
    const downleveled = parseCssColor("lab(98.724 0 0)");

    expect(downleveled.r).toBeCloseTo(authored.r, 0);
    expect(downleveled.g).toBeCloseTo(authored.g, 0);
    expect(downleveled.b).toBeCloseTo(authored.b, 0);
  });

  it("resolves CIE lab percentage, none and slash-alpha components", () => {
    // CIE Lab's references are not OKLab's: lightness 100% is 100 (not 1) and
    // the a/b axes run to 125 (not 0.4). Reusing OKLab's would paint a
    // near-white token as black.
    expect(parseCssColor("lab(100% 0 0)")).toEqual(
      parseCssColor("lab(100 0 0)")
    );
    expect(parseCssColor("lab(50 20% -20%)")).toEqual(
      parseCssColor("lab(50 25 -25)")
    );
    expect(parseCssColor("lab(100% 0 0/.14)").alpha).toBeCloseTo(0.14, 5);
    expect(parseCssColor("lab(50% none none / none)")).toEqual(
      parseCssColor("lab(50 0 0 / 0)")
    );
  });

  it("keeps oklab() out of the CIE lab() branch", () => {
    // Both patterns are anchored, and they disagree by two orders of magnitude
    // on what lightness `0.989` means — so a fall-through would be silent.
    expect(parseCssColor("oklab(0.989 0 0)")).not.toEqual(
      parseCssColor("lab(0.989 0 0)")
    );
    expect(parseCssColor("lab(0.989 0 0)").r).toBeLessThan(10);
  });

  it("composites an OKLab layer over an opaque background", () => {
    expect(
      resolveCompositedBackground(["oklab(0.989 0 0 / 0.5)", "rgb(0, 0, 0)"])
    ).toBe("rgb(126, 126, 126)");
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

/**
 * ISS-5362: the simulation itself, exercised against synthetic inputs whose
 * answer is known independently of any product palette. These assertions are
 * about how dichromatic vision works, not about the tokens we happen to ship,
 * so a palette change can never make them pass or fail.
 */
describe("colour-vision-deficiency simulation", () => {
  const RED = parseCssColor("#ff0000");
  const GREEN = parseCssColor("#00ff00");
  const BLUE = parseCssColor("#0000ff");
  const GREY = parseCssColor("#808080");
  const CHANNEL_TOLERANCE = 0.5;

  it("collapses red and green onto the one axis a dichromat still has", () => {
    // What "the hues merge" actually MEANS numerically: with the L or M cone
    // gone, both primaries land on the blue-yellow axis, where yellow is
    // red === green. Asserting that convergence — rather than a contrast
    // number — is what catches a transposed matrix or a simulation wired up to
    // the wrong cone, because a merely-desaturating stub would not produce it.
    for (const deficiency of Object.values(ColorVisionDeficiency)) {
      for (const primary of [RED, GREEN]) {
        const simulated = simulateColorVisionDeficiency(primary, deficiency);
        expect(simulated.r).toBeCloseTo(simulated.g, 0);
      }
    }
  });

  it("leaves the blue primary exactly where it found it", () => {
    // Neither dichromacy touches the S cone, so pure blue must round-trip
    // through the cone space unchanged. The other half of the contract: a stub
    // that pushed everything toward grey would pass the test above and fail
    // this one.
    for (const deficiency of Object.values(ColorVisionDeficiency)) {
      const simulated = simulateColorVisionDeficiency(BLUE, deficiency);

      expect(simulated.r).toBeCloseTo(0, CHANNEL_TOLERANCE);
      expect(simulated.g).toBeCloseTo(0, CHANNEL_TOLERANCE);
      expect(simulated.b).toBeCloseTo(255, CHANNEL_TOLERANCE);
    }
  });

  it("leaves an achromatic colour where it found it", () => {
    // Grey has no red-green content to lose, so this is the numerical sanity
    // check on the matrix pair: any error in either direction shifts it.
    for (const deficiency of Object.values(ColorVisionDeficiency)) {
      const simulated = simulateColorVisionDeficiency(GREY, deficiency);

      expect(simulated.r).toBeCloseTo(GREY.r, CHANNEL_TOLERANCE);
      expect(simulated.g).toBeCloseTo(GREY.g, CHANNEL_TOLERANCE);
      expect(simulated.b).toBeCloseTo(GREY.b, CHANNEL_TOLERANCE);
    }
  });

  it("shows why a contrast ratio alone cannot certify a palette", () => {
    // The trap this helper exists to expose. Protanopia darkens red hard, so
    // the WCAG ratio between red and green RISES — from 2.91:1 to 5.65:1 —
    // while the two hues are becoming indistinguishable. A palette "checked for
    // contrast" is therefore not checked for colour blindness, and a chart that
    // carries identity in hue needs a channel that is not hue at all.
    const typical = contrastRatio(RED, GREEN);
    const protanopic = contrastRatio(
      simulateColorVisionDeficiency(RED, ColorVisionDeficiency.Protanopia),
      simulateColorVisionDeficiency(GREEN, ColorVisionDeficiency.Protanopia)
    );

    expect(typical).toBeLessThan(ContrastThreshold.NonText);
    expect(protanopic).toBeGreaterThan(typical);
  });

  it("carries alpha through untouched", () => {
    // A deficiency changes which wavelengths resolve, not how much light gets
    // through, so a translucent colour must still composite over its background.
    const translucent = parseCssColor("rgba(255, 0, 0, 0.4)");

    expect(
      simulateColorVisionDeficiency(
        translucent,
        ColorVisionDeficiency.Deuteranopia
      ).alpha
    ).toBe(0.4);
  });
});
