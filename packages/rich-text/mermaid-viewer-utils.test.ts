import { describe, expect, it } from "vitest";
import {
  centerOnSvgPoint,
  computeFitTransform,
  cropSvgToBBox,
  encodeSvgToBase64,
  MAX_SCALE,
  MIN_SCALE,
  prepareSvg,
  type Transform,
  zoomAtPoint,
} from "./mermaid-viewer-utils";

const RE_RECT_WIDTH_100 = /<rect width="100"/;
const RE_MAX_WIDTH = /max-width:/;

describe("prepareSvg", () => {
  it("extracts dims from a viewBox and rewrites width/height", () => {
    const input =
      '<svg viewBox="0 0 100 200" width="100%" style="max-width: 100px;"><rect width="100" height="200"/></svg>';
    const { html, dims } = prepareSvg(input);
    expect(dims).toEqual({ width: 100, height: 200 });
    expect(html).toContain('width="100"');
    expect(html).toContain('height="200"');
    // Should not have stripped a descendant rect's width="100" — the replace
    // only rewrites the first occurrence, which is on the root <svg>.
    expect(html).toMatch(RE_RECT_WIDTH_100);
  });

  it("strips max-width declarations from style attributes", () => {
    const input =
      '<svg viewBox="0 0 50 50" style="max-width: 50px; color: red;"></svg>';
    const { html } = prepareSvg(input);
    expect(html).not.toMatch(RE_MAX_WIDTH);
    expect(html).toContain("color: red");
  });

  it("adds width/height attributes when missing", () => {
    const input = '<svg viewBox="0 0 300 400"></svg>';
    const { html, dims } = prepareSvg(input);
    expect(dims).toEqual({ width: 300, height: 400 });
    expect(html).toContain('width="300"');
    expect(html).toContain('height="400"');
  });

  it("handles comma-separated viewBox values", () => {
    const input = '<svg viewBox="0,0,80,60"></svg>';
    const { dims } = prepareSvg(input);
    expect(dims).toEqual({ width: 80, height: 60 });
  });

  it("handles viewBox with a non-zero origin", () => {
    const input = '<svg viewBox="10 20 300 400"></svg>';
    const { dims } = prepareSvg(input);
    // dims are viewBox width/height only, not origin.
    expect(dims).toEqual({ width: 300, height: 400 });
  });

  it("returns null dims when viewBox is missing", () => {
    const input = "<svg><rect/></svg>";
    const { html, dims } = prepareSvg(input);
    expect(dims).toBeNull();
    // Unmodified passthrough so something still renders.
    expect(html).toBe(input);
  });

  it("returns null dims when viewBox has fewer than 4 parts", () => {
    const input = '<svg viewBox="0 0 100"></svg>';
    const { dims } = prepareSvg(input);
    expect(dims).toBeNull();
  });

  it("returns null dims when viewBox has zero or negative dimensions", () => {
    expect(prepareSvg('<svg viewBox="0 0 0 100"></svg>').dims).toBeNull();
    expect(prepareSvg('<svg viewBox="0 0 100 -1"></svg>').dims).toBeNull();
  });
});

describe("cropSvgToBBox", () => {
  it("rewrites viewBox, width, and height to the given bbox", () => {
    const input =
      '<svg viewBox="0 0 1000 2000" width="1000" height="2000"></svg>';
    const result = cropSvgToBBox(input, {
      x: 50,
      y: 100,
      width: 400,
      height: 600,
    });
    expect(result).toContain('viewBox="50 100 400 600"');
    expect(result).toContain('width="400"');
    expect(result).toContain('height="600"');
  });
});

describe("computeFitTransform", () => {
  it("centers the diagram and applies an 8% margin when it fits both axes", () => {
    // 100×100 diagram in 1000×800 container. fitScale = min(10, 8, 1) * 0.92 = 0.92
    // Centered: x = (1000 - 100*0.92) / 2 = 454, y = (800 - 100*0.92) / 2 = 354
    const t = computeFitTransform({ width: 100, height: 100 }, 1000, 800);
    expect(t.scale).toBeCloseTo(0.92);
    expect(t.x).toBeCloseTo(454);
    expect(t.y).toBeCloseTo(354);
  });

  it("never upscales past native (cap scale at 1 * 0.92)", () => {
    // 50×50 diagram in 1000×1000 → fitScale would be 1000/50 = 20 but capped.
    const t = computeFitTransform({ width: 50, height: 50 }, 1000, 1000);
    expect(t.scale).toBeCloseTo(0.92);
  });

  it("falls back to fit-to-width for very tall diagrams", () => {
    // 100×10000 tall diagram in 800×400 container.
    //   scaleX = 8, scaleY = 0.04, fitScale = 0.04 * 0.92 = 0.0368 (< 0.15)
    //   fallback: widthFit = min(scaleX, 1) * 0.92 = 0.92, y anchored at 16.
    const t = computeFitTransform({ width: 100, height: 10_000 }, 800, 400);
    expect(t.scale).toBeCloseTo(0.92);
    expect(t.x).toBeCloseTo((800 - 100 * 0.92) / 2);
    expect(t.y).toBe(16);
  });

  it("fits to height when height is the limiting axis (but within threshold)", () => {
    // 100×300 in 400×200. scaleX=4, scaleY=0.667, fitScale=0.667*0.92=0.613.
    const t = computeFitTransform({ width: 100, height: 300 }, 400, 200);
    expect(t.scale).toBeCloseTo(0.613, 2);
  });
});

describe("zoomAtPoint", () => {
  const current: Transform = { scale: 1, x: 0, y: 0 };

  it("clamps scale to [MIN_SCALE, MAX_SCALE]", () => {
    expect(zoomAtPoint(current, 0.01, 0, 0).scale).toBe(MIN_SCALE);
    expect(zoomAtPoint(current, 100, 0, 0).scale).toBe(MAX_SCALE);
    expect(zoomAtPoint(current, 2, 0, 0).scale).toBe(2);
  });

  it("keeps the given point fixed on screen (fixed-point identity)", () => {
    // Start with an identity transform; zoom to 2× around (100, 50).
    // The SVG coord under (100, 50) before zoom is (100, 50). After zoom it
    // must still be (100, 50) in screen space → new translate = (-100, -50).
    const zoomed = zoomAtPoint(current, 2, 100, 50);
    const svgXBefore = (100 - current.x) / current.scale;
    const svgYBefore = (50 - current.y) / current.scale;
    const svgXAfter = (100 - zoomed.x) / zoomed.scale;
    const svgYAfter = (50 - zoomed.y) / zoomed.scale;
    expect(svgXAfter).toBeCloseTo(svgXBefore);
    expect(svgYAfter).toBeCloseTo(svgYBefore);
  });

  it("preserves the fixed-point identity for a non-identity starting transform", () => {
    const start: Transform = { scale: 1.5, x: 40, y: -20 };
    const cx = 200;
    const cy = 120;
    const svgXBefore = (cx - start.x) / start.scale;
    const svgYBefore = (cy - start.y) / start.scale;
    const zoomed = zoomAtPoint(start, 3, cx, cy);
    const svgXAfter = (cx - zoomed.x) / zoomed.scale;
    const svgYAfter = (cy - zoomed.y) / zoomed.scale;
    expect(svgXAfter).toBeCloseTo(svgXBefore);
    expect(svgYAfter).toBeCloseTo(svgYBefore);
  });
});

describe("centerOnSvgPoint", () => {
  it("produces a translation that puts (svgX, svgY) at the container center", () => {
    const current: Transform = { scale: 2, x: 0, y: 0 };
    const result = centerOnSvgPoint(current, 50, 25, 400, 200);
    // container center = (200, 100). With scale 2, the SVG point (50, 25)
    // lands at (x + 50*2, y + 25*2) = (x + 100, y + 50). For that to equal
    // (200, 100): x=100, y=50.
    expect(result.x).toBe(100);
    expect(result.y).toBe(50);
    expect(result.scale).toBe(2);
  });
});

describe("encodeSvgToBase64", () => {
  it("round-trips ASCII", () => {
    const input = '<svg viewBox="0 0 10 10"></svg>';
    const decoded = atob(encodeSvgToBase64(input));
    expect(decoded).toBe(input);
  });

  it("round-trips UTF-8 with non-Latin-1 characters", () => {
    // Arrow, emoji, CJK — things `btoa` alone can't handle.
    const input = "<svg>→ 🙂 你好</svg>";
    // Decode the base64 back to bytes, then UTF-8 decode.
    const binary = atob(encodeSvgToBase64(input));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    expect(new TextDecoder().decode(bytes)).toBe(input);
  });
});
