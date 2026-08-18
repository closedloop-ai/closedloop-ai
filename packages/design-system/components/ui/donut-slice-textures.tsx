/**
 * ISS-5362: a REDUNDANT, non-colour channel for donut slice identity.
 *
 * A donut encodes category identity in hue and nothing else, so a reader with a
 * colour-vision deficiency has to map legend swatches onto arcs using the one
 * channel their vision removes. On the Insights spend-by-outcome ring this is
 * not a near miss: simulating protanopia and deuteranopia over the real theme
 * tokens, ALL SIX slice pairs land between 1.02:1 and 2.37:1 — every pair below
 * the WCAG 1.4.11 3:1 non-text floor, in both themes.
 *
 * That is a property of the palette, not of the order the slices sit in. There
 * are only three distinct rings of four slices, and the best of them still
 * leaves a 1.18:1 (light) / 1.42:1 (dark) worst adjacent pair, so no
 * permutation rescues it. Identity has to stop depending on hue.
 *
 * The marks default to `var(--card)` — the surface the ring sits on, and the
 * same token each slice is held to 3:1 against — so a texture reads as gaps
 * punched in the slice rather than as a second colour, and can never introduce
 * a new hue. The consequence to hold onto: texture weight is a LIGHTNESS lever,
 * not a neutral one. Every mark trades ink for surface, so the marks are kept
 * to a hairline and even the heaviest texture moves under a quarter of a
 * slice's ink — enough to read as a grid, little enough that texturing cannot
 * push a slice below the floor it cleared as a flat fill.
 *
 * #4514 (review): that default is only right while the slice itself has enough
 * ink to give up. A slice drawn at low contrast against the card — the
 * deliberately-faint "not recorded" bucket is the live case — cannot carry
 * card-coloured marks at all, because the mark's contrast against the slice IS
 * the contrast this whole channel lives on, and there it sits near 2:1. Such a
 * slice passes a DARKER achromatic mark colour via `markColor`, which adds ink
 * instead of removing it: still no new hue, and the marks stay visible without
 * bleaching the one bucket that is meant to read faintest.
 * `packages/app/insights/lib/__tests__/spend-outcome-texture-contrast.test.ts`
 * holds every shipped mark/slice pair to the 3:1 non-text floor in both themes,
 * so the paragraph above is enforced rather than asserted.
 *
 * {@link DonutSliceTexture.Solid} is deliberately part of the set. A ring where
 * every slice is hatched is noise; leaving the dominant slice flat keeps the
 * chart calm and still separates it from all three textured ones.
 */

import * as React from "react";

export const DonutSliceTexture = {
  Solid: "solid",
  Diagonal: "diagonal",
  Dots: "dots",
  Crosshatch: "crosshatch",
} as const;

export type DonutSliceTexture =
  (typeof DonutSliceTexture)[keyof typeof DonutSliceTexture];

/**
 * The one geometry table both renderings read.
 *
 * The arcs are SVG and the legend swatch is a DOM node, so the same texture has
 * to be expressed twice — once as an SVG `<pattern>` and once as a CSS
 * background. Deriving both from these numbers is what stops the two drifting
 * into different-looking textures for the same category, which is not a
 * hypothetical: a legend that teaches a texture the ring does not draw is worse
 * than no legend, because the reader trusts it.
 *
 * `donut-slice-textures.test.ts` asserts the derivation rather than the strings,
 * so the claim above is enforced instead of merely stated.
 *
 * #4514 (review): 8px was too coarse for the arc. The ring's band is about 20px
 * on the smallest tile, and the "still running" bucket is routinely single
 * digits — roughly 30px of arc — so the slice with the least room is the one
 * the texture most has to rescue. 6px buys repeats everywhere.
 */
export const TEXTURE_TILE_PX = 6;

/**
 * The tile the LEGEND swatch draws on.
 *
 * #4514 (review): parity between arc and legend has to be perceptual, not
 * literal px. The swatch box is 12px and the ring's band is 20px and up, so
 * reusing the arc's tile gave the swatch two repeats at best — and, for dots,
 * one whole dot plus clipped slivers, which is the single-dot read visual QA
 * already caught once on the ring. A smaller tile puts three repeats of every
 * texture inside a 12px square, so the swatch teaches the shape the arc draws.
 */
export const LEGEND_SWATCH_TILE_PX = 4;

/**
 * A hairline, and the same hairline at both scales. Scaling the stroke down
 * with the tile would make the swatch's texture FAINTER than the arc's exactly
 * where it has the least room to read; holding it constant instead lets the
 * ink fraction rise a little at swatch scale, which is what a 12px box needs.
 */
const TEXTURE_STROKE_PX = 0.75;

/**
 * Dot size as a fraction of the tile, so the dot field scales with the tile the
 * way the stripe textures do rather than needing a second constant per scale.
 */
const TEXTURE_DOT_RADIUS_RATIO = 0.2;

/** The colour marks are drawn in unless a slice overrides it — see the module docstring. */
export const DONUT_SLICE_TEXTURE_MARK_COLOR = "var(--card)";

/**
 * Whether a texture needs a `<pattern>` at all. `Solid` is the absence of one,
 * so callers keep painting the plain colour and no `<defs>` entry is emitted.
 */
export function isTexturedSlice(texture: DonutSliceTexture | undefined) {
  return texture !== undefined && texture !== DonutSliceTexture.Solid;
}

/**
 * Stable `<pattern>` id for one slice. Scoped by the chart instance's `useId`
 * so two donuts on the same dashboard cannot collide on a document-global id.
 *
 * Both parts are encoded because this id is not just an attribute — it is
 * dereferenced as `url(#…)`, and `useId` is free to return punctuation that a
 * fragment reference cannot carry (React has shipped both `:r0:` and `«r0»`).
 * A slice key is server-supplied, so it gets the same treatment rather than
 * being trusted to be selector-safe.
 *
 * #4514 (review): the encoding is INJECTIVE rather than lossy. Stripping unsafe
 * characters collapsed `not/recorded` and `notrecorded` onto one id, which
 * hands two slices the same paint server and makes one of them silently render
 * as the other. Escaping instead of deleting — and escaping `-` too, so the
 * separator below can never be ambiguous — keeps distinct keys distinct.
 */
export function donutSliceTextureId(instanceId: string, sliceKey: string) {
  return `donut-texture-${safeIdPart(instanceId)}-${safeIdPart(sliceKey)}`;
}

/**
 * The `<defs>` block for a donut: one `<pattern>` per textured slice.
 *
 * Each pattern paints the slice's own colour as its ground and then the texture
 * marks on top, so a patterned slice keeps the semantic colour a
 * non-colour-blind reader is reading it by.
 */
export function DonutSliceTextureDefs({
  instanceId,
  textureByKey,
  colorByKey,
  markColorByKey,
}: {
  instanceId: string;
  textureByKey: Readonly<Record<string, DonutSliceTexture>>;
  colorByKey: Readonly<Record<string, string>>;
  // Per-slice override for the mark colour. Absent keys use the card token —
  // see the module docstring for when a slice needs a darker mark instead.
  markColorByKey?: Readonly<Record<string, string>>;
}) {
  const textured = Object.entries(textureByKey).filter(([, texture]) =>
    isTexturedSlice(texture)
  );
  if (textured.length === 0) {
    return null;
  }
  return (
    <defs>
      {textured.map(([sliceKey, texture]) => (
        <pattern
          height={TEXTURE_TILE_PX}
          id={donutSliceTextureId(instanceId, sliceKey)}
          key={sliceKey}
          patternUnits="userSpaceOnUse"
          width={TEXTURE_TILE_PX}
        >
          <rect
            fill={ownValue(colorByKey, sliceKey)}
            height={TEXTURE_TILE_PX}
            width={TEXTURE_TILE_PX}
            x={0}
            y={0}
          />
          {textureMarks(
            texture,
            TEXTURE_TILE_PX,
            donutSliceMarkColor(markColorByKey, sliceKey)
          )}
        </pattern>
      ))}
    </defs>
  );
}

/**
 * The same texture as a CSS background, for the legend and tooltip swatches.
 *
 * The swatch is the only place a reader can learn what a texture MEANS, so a
 * textured ring with a flat legend would move the problem rather than solve it.
 * Returns `undefined` for `Solid`, letting the caller fall back to a plain fill.
 *
 * A style OBJECT rather than a bare image string, because two of the three
 * textures are not fully described by `background-image` alone: a
 * `radial-gradient` with no `background-size` paints its shape once across the
 * whole element, which renders a dot FIELD as a single dot.
 */
export function donutSliceTextureBackground(
  texture: DonutSliceTexture | undefined,
  color: string,
  options?: { tilePx?: number; markColor?: string }
): React.CSSProperties | undefined {
  if (!isTexturedSlice(texture)) {
    return undefined;
  }
  const tilePx = options?.tilePx ?? TEXTURE_TILE_PX;
  const mark = options?.markColor ?? DONUT_SLICE_TEXTURE_MARK_COLOR;
  const tile = `${tilePx}px ${tilePx}px`;
  if (texture === DonutSliceTexture.Diagonal) {
    // Negative, so the stripes run "/" like the SVG path. A CSS gradient's
    // bands are perpendicular to its axis, so `45deg` would mirror them.
    return {
      backgroundImage: diagonalGradient(-45, color, tilePx, mark),
      backgroundSize: tile,
    };
  }
  if (texture === DonutSliceTexture.Crosshatch) {
    return {
      backgroundImage: [
        orthogonalGradient(0, "transparent", tilePx, mark),
        orthogonalGradient(90, color, tilePx, mark),
      ].join(", "),
      backgroundSize: tile,
    };
  }
  const radius = dotRadiusPx(tilePx);
  return {
    backgroundImage: `radial-gradient(${mark} ${radius}px, ${color} ${radius}px)`,
    backgroundSize: tile,
  };
}

/**
 * The mark colour for one slice: its own override, or the card token.
 *
 * An OWN-key lookup, not `?.[key]`. Slice keys are server-supplied, so a bucket
 * named `constructor` or `toString` would otherwise resolve through
 * `Object.prototype` and hand a function where a colour belongs.
 */
export function donutSliceMarkColor(
  markColorByKey: Readonly<Record<string, string>> | undefined,
  sliceKey: string
) {
  return ownValue(markColorByKey, sliceKey) ?? DONUT_SLICE_TEXTURE_MARK_COLOR;
}

/**
 * Own-property read for the caller-keyed maps this module and its callers index.
 *
 * Slice keys come from the server, so `map?.[key]` is not a lookup — a key like
 * `constructor` resolves through `Object.prototype` and returns a truthy value
 * for a slice that has no entry. For a texture that means a `url(#…)` fill
 * pointing at a `<pattern>` that `Object.entries` never emitted, and the slice
 * disappears from the ring entirely.
 */
export function ownValue<T>(
  map: Readonly<Record<string, T>> | undefined,
  key: string
): T | undefined {
  if (map === undefined || !Object.hasOwn(map, key)) {
    return undefined;
  }
  return map[key];
}

/**
 * The marks painted over a pattern tile's colour ground.
 *
 * Kept as one mapping rather than a branch per call site so the SVG and the CSS
 * above stay the same four shapes. `Solid` never reaches here — callers gate on
 * {@link isTexturedSlice} — so the fall-through is `Dots`, the remaining case.
 */
function textureMarks(
  texture: DonutSliceTexture,
  tilePx: number,
  mark: string
): React.ReactNode {
  if (texture === DonutSliceTexture.Diagonal) {
    // "/" stripes. The two short strokes past each corner are what make the
    // tile seamless: a single diagonal would leave a visible notch where tiles
    // meet, which reads as a defect rather than as a texture.
    return (
      <path
        d={`M-1,1 l2,-2 M0,${tilePx} l${tilePx},-${tilePx} M${tilePx - 1},${tilePx + 1} l2,-2`}
        stroke={mark}
        strokeWidth={TEXTURE_STROKE_PX}
      />
    );
  }
  if (texture === DonutSliceTexture.Crosshatch) {
    return (
      <path
        d={`M0,0 V${tilePx} M0,0 H${tilePx}`}
        stroke={mark}
        strokeWidth={TEXTURE_STROKE_PX}
      />
    );
  }
  return (
    <circle
      cx={tilePx / 2}
      cy={tilePx / 2}
      fill={mark}
      r={dotRadiusPx(tilePx)}
    />
  );
}

const UNSAFE_ID_CHARS = /[^A-Za-z0-9]/g;

/**
 * Percent-style escape into `[A-Za-z0-9_]`, injective by construction: every
 * literal `_` is itself escaped, so a `_` in the output can only ever open an
 * escape and no two inputs can produce the same output.
 */
function safeIdPart(value: string) {
  return value.replace(
    UNSAFE_ID_CHARS,
    (char) => `_${char.charCodeAt(0).toString(16)}_`
  );
}

function dotRadiusPx(tilePx: number) {
  return tilePx * TEXTURE_DOT_RADIUS_RATIO;
}

/**
 * A 45° line's perpendicular spacing is the tile's diagonal pitch, not the tile
 * itself. SVG measures the tile; a CSS `repeating-linear-gradient` measures
 * along its own gradient axis, which is already perpendicular to the stripes —
 * so the CSS period has to be the tile divided by √2 or the swatch renders the
 * same texture 41% coarser than the arc.
 */
export function diagonalPitchPx(tilePx: number) {
  return tilePx / Math.SQRT2;
}

/** A 45° stripe set, spaced on the tile's DIAGONAL pitch — see {@link diagonalPitchPx}. */
function diagonalGradient(
  angleDeg: number,
  color: string,
  tilePx: number,
  mark: string
) {
  const pitch = diagonalPitchPx(tilePx);
  const ink = pitch - TEXTURE_STROKE_PX;
  return `repeating-linear-gradient(${angleDeg}deg, ${color} 0 ${ink}px, ${mark} ${ink}px ${pitch}px)`;
}

/** A horizontal or vertical stripe set, spaced on the tile itself. */
function orthogonalGradient(
  angleDeg: number,
  color: string,
  tilePx: number,
  mark: string
) {
  const ink = tilePx - TEXTURE_STROKE_PX;
  return `repeating-linear-gradient(${angleDeg}deg, ${color} 0 ${ink}px, ${mark} ${ink}px ${tilePx}px)`;
}
