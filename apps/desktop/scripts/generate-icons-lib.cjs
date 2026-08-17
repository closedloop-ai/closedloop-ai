// @ts-check
"use strict";

/**
 * ISS-5303 — the pure, testable half of `scripts/generate-icons.cjs`.
 *
 * The entrypoint keeps everything that touches the world: locating
 * `app-icon.svg` / `resources/trayIconTemplate.svg`, resolving `sharp`, and
 * rasterizing. What is left here is string in, string out — the tray mark's
 * geometry — which is the part that can silently produce a wrong icon.
 *
 * CommonJS on purpose. `generate-icons.cjs` is a `.cjs` entrypoint that
 * `require()`s its dependencies, so a sibling `.cjs` keeps the module system
 * consistent and needs no `require(esm)` interop. The TypeScript surface is
 * declared in `generate-icons-lib.d.cts`.
 */

/**
 * Every `<path .../>` element in the tray source SVG.
 *
 * Global on purpose — `String#match` with a global pattern returns ALL matches
 * (and resets `lastIndex` itself), which is what "take every path" needs.
 */
const TRAY_PATH_PATTERN = /<path[\s\S]*?\/>/g;

/** The tray source SVG's own square viewBox extent. */
const TRAY_VIEWBOX_EXTENT = 121;

/**
 * Width of the tray mark inside that viewBox. It is narrower than the extent,
 * which is why the mark has to be re-centred horizontally after scaling.
 */
const TRAY_MARK_WIDTH = 112;

/** Indentation the extracted paths are re-joined at inside the `<g>`. */
const TRAY_PATH_JOIN = "\n    ";

/**
 * Pull the mark's path elements out of `resources/trayIconTemplate.svg`.
 *
 * Throws rather than returning an empty mark: a tray SVG we cannot find a path
 * in would rasterize to a blank 18x18 PNG, and a blank tray icon looks like a
 * broken app rather than a broken build.
 *
 * @param {string} traySvg Raw contents of the tray template SVG.
 * @returns {string} The path elements, joined for embedding in the `<g>`.
 */
function extractTrayPaths(traySvg) {
  const paths = traySvg.match(TRAY_PATH_PATTERN);
  if (paths === null) {
    throw new Error(
      "trayIconTemplate.svg contains no <path .../> elements; the tray icon would rasterize blank."
    );
  }
  return paths.join(TRAY_PATH_JOIN);
}

/**
 * Build a square SVG wrapper around the tray mark at `size`.
 *
 * The source mark is 112 wide in a 121 box, so it is scaled by `size / 121` and
 * then translated by half the leftover width to sit centred in a square canvas.
 * `sharp` rasterizes the result down to the 18x18 / 36x36 tray PNGs.
 *
 * @param {number} size Square canvas extent, in SVG user units.
 * @param {string} trayPaths Path elements from {@link extractTrayPaths}.
 * @returns {string} A complete, self-contained SVG document.
 */
function makeSquareTray(size, trayPaths) {
  const scale = size / TRAY_VIEWBOX_EXTENT;
  const scaledMarkWidth = TRAY_MARK_WIDTH * scale;
  const offsetX = (size - scaledMarkWidth) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <g transform="translate(${offsetX}, 0) scale(${scale})">
    ${trayPaths}
  </g>
</svg>`;
}

module.exports = { extractTrayPaths, makeSquareTray };
