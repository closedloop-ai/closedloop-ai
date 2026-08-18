/**
 * ISS-5362: the legend swatch must teach the texture the ring actually draws.
 *
 * The module claims one geometry table drives both renderings. Visual QA caught
 * that claim being false in two ways at once — the CSS diagonal ran the
 * opposite way from the SVG path and at a 41% coarser pitch, and the dot field
 * rendered as a SINGLE dot because a `radial-gradient` with no
 * `background-size` paints once across the whole element. Both are invisible to
 * a test that only checks "a background exists", and both make the legend teach
 * a texture that is not on the ring, which is worse than no legend because the
 * reader trusts it.
 *
 * So these assert the DERIVATION — that the emitted CSS is a function of the
 * shared tile constant — rather than pinning today's strings.
 */

import {
  DONUT_SLICE_TEXTURE_MARK_COLOR,
  DonutSliceTexture,
  diagonalPitchPx,
  donutSliceMarkColor,
  donutSliceTextureBackground,
  donutSliceTextureId,
  isTexturedSlice,
  LEGEND_SWATCH_TILE_PX,
  ownValue,
  TEXTURE_TILE_PX,
} from "@repo/design-system/components/ui/donut-slice-textures";
import { describe, expect, it } from "vitest";

const COLOR = "var(--destructive)";
// The perpendicular spacing of a 45° line across a square tile.
const DIAGONAL_PITCH_PX = diagonalPitchPx(TEXTURE_TILE_PX);
const DIAGONAL_ANGLE = /repeating-linear-gradient\((?<angle>-?\d+)deg/;
// Two escaped parts joined by the one separator: everything a `url(#…)`
// fragment reference can safely carry, and nothing else.
const SAFE_ID_BODY = /^[A-Za-z0-9_]+-[A-Za-z0-9_]+$/;
const TEXTURED = Object.values(DonutSliceTexture).filter((texture) =>
  isTexturedSlice(texture)
);

describe("donut slice texture CSS/SVG parity (ISS-5362)", () => {
  it("tiles every texture on the shared tile size", () => {
    // The dots regression specifically: without this, one dot on a flat field.
    for (const texture of TEXTURED) {
      expect(donutSliceTextureBackground(texture, COLOR)?.backgroundSize).toBe(
        `${TEXTURE_TILE_PX}px ${TEXTURE_TILE_PX}px`
      );
    }
  });

  it("runs the diagonal the same way the SVG path draws it", () => {
    // The SVG path draws "/". A CSS gradient's bands are perpendicular to its
    // axis, so a POSITIVE 45deg mirrors them to "\" — the drift that shipped.
    const angle = donutSliceTextureBackground(
      DonutSliceTexture.Diagonal,
      COLOR
    )?.backgroundImage?.match(DIAGONAL_ANGLE)?.groups?.angle;

    expect(Number(angle)).toBeLessThan(0);
  });

  it("spaces the diagonal on the tile's diagonal pitch, not the tile", () => {
    // Derived from TEXTURE_TILE_PX, so changing the tile moves the swatch and
    // the arc together instead of only one of them.
    expect(
      donutSliceTextureBackground(DonutSliceTexture.Diagonal, COLOR)
        ?.backgroundImage
    ).toContain(`${DIAGONAL_PITCH_PX}px`);
  });

  it("spaces the crosshatch on the tile itself", () => {
    // Orthogonal lines have no √2 correction — asserting BOTH spacings keeps a
    // future "simplify" from collapsing them onto one wrong constant.
    const image = donutSliceTextureBackground(
      DonutSliceTexture.Crosshatch,
      COLOR
    )?.backgroundImage;

    expect(image).toContain(`${TEXTURE_TILE_PX}px`);
    expect(image).not.toContain(`${DIAGONAL_PITCH_PX}px`);
  });

  it("paints every texture's marks in the surface token", () => {
    // Never a fifth colour: a texture is gaps punched in the slice, so it can
    // neither introduce a hue nor be defeated by a palette change.
    for (const texture of TEXTURED) {
      expect(
        donutSliceTextureBackground(texture, COLOR)?.backgroundImage
      ).toContain(DONUT_SLICE_TEXTURE_MARK_COLOR);
    }
  });

  it("returns no background for a solid slice", () => {
    expect(
      donutSliceTextureBackground(DonutSliceTexture.Solid, COLOR)
    ).toBeUndefined();
    expect(donutSliceTextureBackground(undefined, COLOR)).toBeUndefined();
  });

  it("encodes punctuation a url(#…) reference cannot carry", () => {
    // `useId` has shipped both ":r0:" and "«r0»", and a slice key is
    // server-supplied — neither is safe to drop into a fragment reference.
    const id = donutSliceTextureId(":r7:", "not/recorded");

    expect(id.startsWith("donut-texture-")).toBe(true);
    expect(id.slice("donut-texture-".length)).toMatch(SAFE_ID_BODY);
  });

  it("keeps distinct slice keys on DISTINCT pattern ids", () => {
    // #4514 (review): stripping unsafe characters was lossy — `not/recorded`
    // and `notrecorded` collapsed onto one id, so two slices resolved to a
    // single paint server and one rendered as the other. These pairs are the
    // ones a lossy encoder merges, including the `-` separator case, which a
    // delete-only encoder cannot see at all.
    const collidingPairs = [
      ["not/recorded", "notrecorded"],
      ["a.b", "ab"],
      ["a_b", "ab"],
      ["a-b", "ab"],
      ["a:b", "a/b"],
    ];

    for (const [left, right] of collidingPairs) {
      expect(donutSliceTextureId("r7", left)).not.toBe(
        donutSliceTextureId("r7", right)
      );
    }
  });

  it("keeps the instance/slice boundary unambiguous", () => {
    // The id joins two encoded parts with "-", so a "-" surviving inside a part
    // would let (instance "x", slice "y-z") and (instance "x-y", slice "z")
    // produce the same id for two different donuts on one page.
    expect(donutSliceTextureId("x", "y-z")).not.toBe(
      donutSliceTextureId("x-y", "z")
    );
  });
});

/**
 * #4514 (review): the swatch is a 12px box and the ring's band is 20px and up,
 * so reusing the arc's tile gave the legend two repeats at best — and for dots
 * one whole dot plus clipped slivers, the single-dot read visual QA already
 * caught once on the ring. Parity has to be PERCEPTUAL, so the swatch draws the
 * same texture on a smaller tile.
 */
describe("legend swatch tile (ISS-5362)", () => {
  const SWATCH_BOX_PX = 12;
  const MIN_REPEATS = 3;

  it("fits at least three repeats of every texture in the swatch box", () => {
    // The arc's own tile is what failed this, so assert the ratio rather than
    // the constant: shrinking the swatch box later must fail here too.
    expect(SWATCH_BOX_PX / LEGEND_SWATCH_TILE_PX).toBeGreaterThanOrEqual(
      MIN_REPEATS
    );
    expect(
      SWATCH_BOX_PX / diagonalPitchPx(LEGEND_SWATCH_TILE_PX)
    ).toBeGreaterThanOrEqual(MIN_REPEATS);
  });

  it("draws the swatch on the swatch tile, not the arc's", () => {
    for (const texture of TEXTURED) {
      expect(
        donutSliceTextureBackground(texture, COLOR, {
          tilePx: LEGEND_SWATCH_TILE_PX,
        })?.backgroundSize
      ).toBe(`${LEGEND_SWATCH_TILE_PX}px ${LEGEND_SWATCH_TILE_PX}px`);
    }
  });

  it("keeps the diagonal's √2 correction at swatch scale too", () => {
    // The correction is per-tile, so a scale that forgot it would render the
    // swatch's stripes 41% coarser than the arc's — the exact drift the arc
    // pitch assertions above exist to prevent, reintroduced at the other scale.
    expect(
      donutSliceTextureBackground(DonutSliceTexture.Diagonal, COLOR, {
        tilePx: LEGEND_SWATCH_TILE_PX,
      })?.backgroundImage
    ).toContain(`${diagonalPitchPx(LEGEND_SWATCH_TILE_PX)}px`);
  });
});

/**
 * #4514 (review): a texture is only a channel if its MARKS are visible against
 * the slice. The card token works while the slice has ink to give up; a slice
 * drawn faintly against that same card needs a darker mark instead.
 */
describe("texture mark colour (ISS-5362)", () => {
  it("defaults to the surface token", () => {
    expect(donutSliceMarkColor(undefined, "unknown")).toBe(
      DONUT_SLICE_TEXTURE_MARK_COLOR
    );
    expect(donutSliceMarkColor({ other: "var(--x)" }, "unknown")).toBe(
      DONUT_SLICE_TEXTURE_MARK_COLOR
    );
  });

  it("paints a slice's marks in its override when it has one", () => {
    for (const texture of TEXTURED) {
      const image = donutSliceTextureBackground(texture, COLOR, {
        markColor: "var(--muted-foreground)",
      })?.backgroundImage;

      expect(image).toContain("var(--muted-foreground)");
      expect(image).not.toContain(DONUT_SLICE_TEXTURE_MARK_COLOR);
    }
  });

  it("never resolves an inherited property as a mark colour", () => {
    // Slice keys are server-supplied. `map?.["constructor"]` is truthy on any
    // object literal, so a plain lookup would hand a FUNCTION to a CSS colour.
    expect(donutSliceMarkColor({}, "constructor")).toBe(
      DONUT_SLICE_TEXTURE_MARK_COLOR
    );
    expect(donutSliceMarkColor({}, "toString")).toBe(
      DONUT_SLICE_TEXTURE_MARK_COLOR
    );
  });

  it("reads only own properties out of caller-keyed maps", () => {
    // The same hazard for the texture map itself: an inherited hit there gives
    // a slice a `url(#…)` fill pointing at a <pattern> that was never emitted,
    // and the slice vanishes from the ring.
    expect(ownValue({}, "constructor")).toBeUndefined();
    expect(ownValue(undefined, "clean")).toBeUndefined();
    expect(ownValue({ clean: "var(--chart-4)" }, "clean")).toBe(
      "var(--chart-4)"
    );
  });
});
