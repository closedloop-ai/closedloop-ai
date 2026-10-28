import { describe, expect, it } from "vitest";
import { toHex } from "../stories/foundations-v2/color-hex";

describe("toHex (Foundations colour readout)", () => {
  it("converts oklch to sRGB hex, matching the CSS Color 4 reference colours", () => {
    expect(toHex("oklch(1 0 0)")).toBe("#ffffff");
    expect(toHex("oklch(0 0 0)")).toBe("#000000");
    expect(toHex("oklch(0.628 0.2577 29.23)")).toBe("#ff0000");
    expect(toHex("oklch(0.452 0.313 264.05)")).toBe("#0000ff");
    expect(toHex("oklch(62.8% 0.2577 29.23deg)")).toBe("#ff0000");
  });

  it("keeps a translucent colour's alpha as an eight-digit hex", () => {
    expect(toHex("oklch(1 0 0 / 0.5)")).toBe("#ffffff80");
    expect(toHex("rgb(0 89 255 / 0.25)")).toBe("#0059ff40");
    expect(toHex("rgba(0, 0, 0, 50%)")).toBe("#00000080");
  });

  it("normalizes hex and rgb notations", () => {
    expect(toHex("#93C5FD")).toBe("#93c5fd");
    expect(toHex("#abc")).toBe("#aabbcc");
    expect(toHex("#112233ff")).toBe("#112233");
    expect(toHex("rgb(255, 0, 0)")).toBe("#ff0000");
  });

  it("clips a colour outside sRGB instead of overflowing a channel", () => {
    // Red and blue fall below 0 for this green, so both clip to 00.
    expect(toHex("oklch(0.7 0.4 150)")).toBe("#00d600");
  });

  it("returns anything it cannot convert unchanged", () => {
    expect(toHex("calc(1px + 2px)")).toBe("calc(1px + 2px)");
    expect(toHex("  linear-gradient(red, blue) ")).toBe(
      "linear-gradient(red, blue)"
    );
  });
});
