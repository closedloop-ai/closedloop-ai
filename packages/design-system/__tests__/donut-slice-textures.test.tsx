import {
  DONUT_SLICE_TEXTURE_MARK_COLOR,
  DonutSliceTexture,
  DonutSliceTextureDefs,
  diagonalPitchPx,
  donutSliceMarkColor,
  donutSliceTextureBackground,
  donutSliceTextureId,
  isTexturedSlice,
  LEGEND_SWATCH_TILE_PX,
  ownValue,
  TEXTURE_TILE_PX,
} from "@closedloop-ai/design-system/components/ui/donut-slice-textures";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Pins current behavior of the donut-slice texture module: which textures are
 * "textured" vs a plain fill, the pattern-id encoding, the CSS background
 * derivation for the legend/tooltip swatch, own-key safety for server-keyed
 * maps, and the `<defs>` render for the SVG arcs. Read-only characterization
 * — never change `donut-slice-textures.tsx` to make one of these pass.
 */

afterEach(cleanup);

describe("isTexturedSlice", () => {
  it("is false for undefined", () => {
    expect(isTexturedSlice(undefined)).toBe(false);
  });

  it("is false for Solid", () => {
    expect(isTexturedSlice(DonutSliceTexture.Solid)).toBe(false);
  });

  it.each([
    DonutSliceTexture.Diagonal,
    DonutSliceTexture.Dots,
    DonutSliceTexture.Crosshatch,
  ])("is true for %s", (texture) => {
    expect(isTexturedSlice(texture)).toBe(true);
  });
});

describe("donutSliceTextureId", () => {
  it("is stable for the same inputs", () => {
    expect(donutSliceTextureId("r0", "spend")).toBe(
      donutSliceTextureId("r0", "spend")
    );
  });

  it("differs for different slice keys", () => {
    expect(donutSliceTextureId("r0", "a")).not.toBe(
      donutSliceTextureId("r0", "b")
    );
  });

  it("encodes unsafe characters so collision-prone keys stay distinct", () => {
    const withSlash = donutSliceTextureId("r0", "not/recorded");
    const withoutSlash = donutSliceTextureId("r0", "notrecorded");
    expect(withSlash).not.toBe(withoutSlash);
    expect(withSlash).not.toContain("/");
  });

  it("encodes React useId-style punctuation (colons, guillemets)", () => {
    const id = donutSliceTextureId(":r0:", "spend");
    expect(id).not.toContain(":");
    expect(id.startsWith("donut-texture-")).toBe(true);
  });
});

describe("donutSliceTextureBackground", () => {
  it("is undefined for Solid", () => {
    expect(
      donutSliceTextureBackground(DonutSliceTexture.Solid, "red")
    ).toBeUndefined();
  });

  it("is undefined for an undefined texture", () => {
    expect(donutSliceTextureBackground(undefined, "red")).toBeUndefined();
  });

  it.each([
    DonutSliceTexture.Diagonal,
    DonutSliceTexture.Dots,
    DonutSliceTexture.Crosshatch,
  ])("returns CSS backgroundImage/backgroundSize for %s", (texture) => {
    const style = donutSliceTextureBackground(texture, "red");
    expect(style).toBeDefined();
    expect(style?.backgroundImage).toEqual(expect.stringContaining("gradient"));
    expect(style?.backgroundSize).toBe(
      `${TEXTURE_TILE_PX}px ${TEXTURE_TILE_PX}px`
    );
  });

  it("respects a tilePx override", () => {
    const style = donutSliceTextureBackground(DonutSliceTexture.Dots, "red", {
      tilePx: LEGEND_SWATCH_TILE_PX,
    });
    expect(style?.backgroundSize).toBe(
      `${LEGEND_SWATCH_TILE_PX}px ${LEGEND_SWATCH_TILE_PX}px`
    );
  });

  it("respects a markColor override", () => {
    const style = donutSliceTextureBackground(DonutSliceTexture.Dots, "red", {
      markColor: "var(--custom-mark)",
    });
    expect(style?.backgroundImage).toEqual(
      expect.stringContaining("var(--custom-mark)")
    );
  });

  it("defaults the mark color to the card token", () => {
    const style = donutSliceTextureBackground(DonutSliceTexture.Dots, "red");
    expect(style?.backgroundImage).toEqual(
      expect.stringContaining(DONUT_SLICE_TEXTURE_MARK_COLOR)
    );
  });
});

describe("donutSliceMarkColor", () => {
  it("returns the card token when no override map is given", () => {
    expect(donutSliceMarkColor(undefined, "spend")).toBe(
      DONUT_SLICE_TEXTURE_MARK_COLOR
    );
  });

  it("returns the card token when the slice has no entry", () => {
    expect(donutSliceMarkColor({ other: "var(--x)" }, "spend")).toBe(
      DONUT_SLICE_TEXTURE_MARK_COLOR
    );
  });

  it("returns the override when present", () => {
    expect(donutSliceMarkColor({ spend: "var(--dark-mark)" }, "spend")).toBe(
      "var(--dark-mark)"
    );
  });
});

describe("ownValue", () => {
  it("returns the value for an own key", () => {
    expect(ownValue({ spend: "red" }, "spend")).toBe("red");
  });

  it("returns undefined for a prototype-inherited key with no own entry", () => {
    expect(ownValue({}, "constructor")).toBeUndefined();
    expect(ownValue({}, "toString")).toBeUndefined();
  });

  it("returns the value for an explicit own 'constructor' key", () => {
    const map: Record<string, string> = { constructor: "safe" };
    expect(ownValue(map, "constructor")).toBe("safe");
  });

  it("returns undefined for a missing map", () => {
    expect(ownValue(undefined, "spend")).toBeUndefined();
  });
});

describe("diagonalPitchPx", () => {
  it("divides the tile size by sqrt(2)", () => {
    expect(diagonalPitchPx(TEXTURE_TILE_PX)).toBeCloseTo(
      TEXTURE_TILE_PX / Math.SQRT2
    );
  });

  it("scales with the tile size", () => {
    expect(diagonalPitchPx(12)).toBeCloseTo(12 / Math.SQRT2);
  });
});

describe("DonutSliceTextureDefs", () => {
  it("returns null (no <defs>) when every slice is Solid", () => {
    const { container } = render(
      <svg aria-label="test" role="img">
        <DonutSliceTextureDefs
          colorByKey={{ spend: "red" }}
          instanceId="r0"
          textureByKey={{ spend: DonutSliceTexture.Solid }}
        />
      </svg>
    );
    expect(container.querySelector("defs")).toBeNull();
  });

  it("renders one <pattern> per textured slice, skipping Solid ones", () => {
    const { container } = render(
      <svg aria-label="test" role="img">
        <DonutSliceTextureDefs
          colorByKey={{ spend: "red", other: "blue" }}
          instanceId="r0"
          textureByKey={{
            spend: DonutSliceTexture.Diagonal,
            other: DonutSliceTexture.Solid,
          }}
        />
      </svg>
    );
    const patterns = container.querySelectorAll("pattern");
    expect(patterns).toHaveLength(1);
    expect(patterns[0]).toHaveAttribute(
      "id",
      donutSliceTextureId("r0", "spend")
    );
  });

  it("paints the pattern's ground rect with the slice's own color", () => {
    const { container } = render(
      <svg aria-label="test" role="img">
        <DonutSliceTextureDefs
          colorByKey={{ spend: "var(--spend-color)" }}
          instanceId="r0"
          textureByKey={{ spend: DonutSliceTexture.Dots }}
        />
      </svg>
    );
    const rect = container.querySelector("pattern rect");
    expect(rect).toHaveAttribute("fill", "var(--spend-color)");
  });
});
