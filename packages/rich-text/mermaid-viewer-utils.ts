/**
 * Pure utilities and types for the Mermaid viewer.
 *
 * Everything in this module is framework-agnostic (no React) so it can be
 * unit-tested in isolation. UI integration lives in `mermaid-viewer.tsx`;
 * stateful logic that needs React APIs lives in `mermaid-viewer-hooks.ts`.
 */

import DOMPurify from "isomorphic-dompurify";

// --- Constants ---------------------------------------------------------------

/** Minimum CSS scale allowed by the pan/zoom canvas. */
export const MIN_SCALE = 0.1;
/** Maximum CSS scale allowed by the pan/zoom canvas. */
export const MAX_SCALE = 5;
/** Per-wheel-tick zoom multiplier (1 ± ZOOM_FACTOR). */
export const ZOOM_FACTOR = 0.15;
/** Inline (non-fullscreen) canvas height, in CSS pixels. */
export const INLINE_HEIGHT = 450;

// --- Regexes -----------------------------------------------------------------

export const RE_VIEWBOX = /viewBox="([^"]*)"/;
export const RE_WHITESPACE_COMMA = /[\s,]+/;
export const RE_WIDTH_ATTR = /\bwidth="[^"]*"/;
export const RE_HEIGHT_ATTR = /\bheight="[^"]*"/;
export const RE_MAX_WIDTH_STYLE = /max-width:\s*[^;}"]+;?/g;

// --- Types -------------------------------------------------------------------

/** CSS transform on the content div: `translate(x, y) scale(scale)`. */
export type Transform = {
  scale: number;
  x: number;
  y: number;
};

/** SVG's natural (unscaled) render dimensions in CSS pixels. */
export type SvgDimensions = {
  width: number;
  height: number;
};

/**
 * A rectangle in SVG user-space coordinates. Used for both the SVG content's
 * bounding box and for the visible region in the main viewport.
 */
export type ContentBBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

// --- SVG normalization -------------------------------------------------------

/**
 * Tags the `html` profile would admit inside a `<foreignObject>` label that
 * mermaid does not need for label text and that either fetch an external
 * resource on render (passive tracking/exfil beacons such as
 * `<img src="http://...">`), enable DOM clobbering (`<form>`/`<input>`), or
 * navigate the viewer (`<a href>`). Forbidding them keeps a stored diagram from
 * smuggling a beacon, clobbering vector, or phishing link into a viewer's
 * session. Verified zero-regression against real mermaid v11 flowchart output,
 * whose label tag set is only div/span/p/br/strong/em and friends.
 *
 * `<a>` is included deliberately: it disables mermaid `click`/`href` directives
 * (SVG node links and HTML label anchors alike). For a renderer of untrusted,
 * stored diagrams in an authenticated session, author-controlled navigation
 * targets are a phishing vector, so we trade that authoring feature for safety.
 * The "anchor navigation" regression test pins this stripped behavior.
 *
 * Deliberately NOT forbidden: the `<style>` tag (mermaid's top-level theming
 * block) and the `style` attribute (label layout) are load-bearing for correct
 * rendering. Rather than remove them, the hooks below strip only the *external*
 * `url()` / `@import` resource references they could otherwise carry, leaving
 * internal `url(#gradient)` / `url(#marker)` references intact.
 */
const FORBIDDEN_LABEL_TAGS = [
  "img",
  "image",
  "video",
  "audio",
  "source",
  "track",
  "picture",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "a",
  "link",
  "base",
  "meta",
];

/** Resource-loading attributes the `html` profile would otherwise admit. */
const FORBIDDEN_RESOURCE_ATTRS = [
  "srcset",
  "poster",
  "background",
  "ping",
  "formaction",
  "action",
];

// Detects a CSS `url(...)` that points at an *external* resource. The negative
// lookahead skips `url(#id)` fragment references (gradients, markers, filters)
// that mermaid uses legitimately, so only beacon-capable URLs match.
const RE_CSS_EXTERNAL_URL = /url\(\s*["']?(?!#)/i;
// Strips CSS `@import` rules and external `url(...)` from `<style>` text.
const RE_STYLE_EXTERNAL_RESOURCE =
  /@import[^;]*;?|url\(\s*["']?(?!#)[^)]*\)?/gi;

// The hooks below close two CSS-beacon paths the `html` profile opens once
// `<foreignObject>` label content is preserved. Registered once at module load;
// isomorphic-dompurify is the only DOMPurify consumer in this package, so the
// hooks stay scoped in practice. Both are zero-regression for mermaid, whose
// theming/layout CSS never references an external resource.

// A label can beacon through `style="background:url(http://attacker)"`. Drop any
// inline style value that carries an external url(); internal `url(#id)` is kept.
DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName === "style" && RE_CSS_EXTERNAL_URL.test(data.attrValue)) {
    data.keepAttr = false;
  }
});

// A label-owned `<style>@import url(...)</style>` survives tag-level allow-listing
// (mermaid's root theming block needs `<style>`) and the attribute hook above
// only inspects `style="..."` attributes, not element text. Scrub `@import` and
// external `url()` from every `<style>` element's CSS so neither the theming
// block nor an injected label `<style>` can fetch a remote resource (FEA-2086).
DOMPurify.addHook("uponSanitizeElement", (node, data) => {
  if (data.tagName === "style" && node.textContent) {
    node.textContent = node.textContent.replace(RE_STYLE_EXTERNAL_RESOURCE, "");
  }
});

/**
 * Sanitize a mermaid-generated SVG string with DOMPurify, stripping `<script>`
 * elements, event handlers (`onload`/`onerror`/`onclick`), and other XSS
 * vectors before the markup is ever handed to `dangerouslySetInnerHTML`.
 *
 * Mermaid runs with `securityLevel: "loose"`, so node labels and other
 * diagram content are interpolated into the SVG without escaping; a stored
 * diagram could otherwise smuggle active content into a viewer's session.
 *
 * FLOWCHART LABELS (`html: true` + foreignObject):
 * Mermaid renders flowchart/graph node and edge labels as HTML
 * (`<div><span class="nodeLabel"><p>text</p></span></div>`) inside an SVG
 * `<foreignObject>` (its default `htmlLabels: true` path). The SVG-only
 * profile that originally shipped here (svg + svgFilters) silently dropped
 * `<foreignObject>` AND every HTML child, so flowcharts rendered boxes and
 * arrows with blank labels while sequence diagrams (which use plain SVG
 * `<text>`) were unaffected (FEA-2086).
 *
 * `<foreignObject>` is a legitimate HTML integration point per the HTML5
 * parsing spec, so the fix is a *namespace* correction, not a blanket
 * loosening of XSS protection:
 *   - `html: true` allows the benign formatting tags mermaid emits in labels
 *     (`div`, `span`, `p`, `br`, `strong`/`em`).
 *   - `ADD_TAGS: ["foreignObject"]` keeps the wrapper element itself.
 *   - `HTML_INTEGRATION_POINTS` marks `foreignobject` as a point where DOMPurify
 *     should treat children as the HTML namespace (it must include the built-in
 *     `annotation-xml` because this option replaces, not merges).
 *   - `FORBID_TAGS`/`FORBID_ATTR` then re-narrow the html profile to exactly the
 *     formatting surface mermaid uses, blocking the passive resource-loading and
 *     DOM-clobbering tags the profile would otherwise admit inside a label.
 *
 * What is NOT relaxed: `<script>`, event-handler attributes, `javascript:`
 * URIs, `<iframe>`/`<object>`, resource-loading tags/attrs, and mutation-XSS
 * namespace-confusion payloads are all still stripped, and external `url()` /
 * `@import` references are scrubbed from both `style` attributes and `<style>`
 * element text by the hooks above. Note on `FORBID_TAGS` semantics: it removes a
 * forbidden element's own tag while DOMPurify promotes the remaining children to
 * the parent (so benign label *text* survives); the child elements that are the
 * actual XSS/beacon vectors are themselves in `FORBID_TAGS`, so they are removed
 * too. `FORBID_CONTENTS` stays at its default, which still discards the contents
 * of the elements listed there (`<script>`, `<title>`, etc.). See the security
 * regression battery in `mermaid-viewer-utils.test.ts`.
 */
export function sanitizeSvg(svgString: string): string {
  return DOMPurify.sanitize(svgString, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ["foreignObject"],
    HTML_INTEGRATION_POINTS: { "annotation-xml": true, foreignobject: true },
    FORBID_TAGS: FORBIDDEN_LABEL_TAGS,
    FORBID_ATTR: FORBIDDEN_RESOURCE_ATTRS,
  });
}

/**
 * Normalize a mermaid-generated SVG string so it renders at a known pixel
 * size (for consistent pan/zoom math) and report its dimensions.
 *
 * The input is first run through {@link sanitizeSvg} (DOMPurify) so every
 * caller that renders the result via `dangerouslySetInnerHTML` gets sanitized
 * markup, then:
 *   1. Read the viewBox (falling back gracefully if it's missing).
 *   2. Replace (or add) `width` and `height` attributes equal to the viewBox
 *      dimensions so the SVG renders at its native size.
 *   3. Strip every `max-width: ...` declaration in style attributes so the
 *      editor's CSS can't cap it.
 *
 * Mermaid typically emits `<svg width="100%" ... style="max-width: Xpx;">`.
 * That's great for flow-sized rendering but it means the rendered pixel size
 * depends on the container, which breaks our "SVG pixel == 1 CSS pixel at
 * scale 1" assumption.
 */
export function prepareSvg(svgString: string): {
  html: string;
  dims: SvgDimensions | null;
} {
  const sanitized = sanitizeSvg(svgString);
  const viewBoxMatch = RE_VIEWBOX.exec(sanitized);
  if (!viewBoxMatch) {
    return { html: sanitized, dims: null };
  }
  // viewBox is "minX minY width height"; entries can be separated by spaces
  // or commas. We only care about indices 2 and 3.
  const parts = viewBoxMatch[1].split(RE_WHITESPACE_COMMA);
  if (parts.length < 4) {
    return { html: sanitized, dims: null };
  }
  const width = Number.parseFloat(parts[2]);
  const height = Number.parseFloat(parts[3]);
  if (!(width > 0 && height > 0)) {
    return { html: sanitized, dims: null };
  }

  let processed = sanitized;
  // Only rewrite attributes in the opening <svg> tag, not in descendant
  // elements that might also have `width="..."`.
  const svgTagEnd = processed.indexOf(">");
  const svgTag = processed.slice(0, svgTagEnd);

  if (RE_WIDTH_ATTR.test(svgTag)) {
    processed = processed.replace(RE_WIDTH_ATTR, `width="${width}"`);
  } else {
    processed = processed.replace("<svg", `<svg width="${width}"`);
  }
  if (RE_HEIGHT_ATTR.test(svgTag)) {
    processed = processed.replace(RE_HEIGHT_ATTR, `height="${height}"`);
  } else {
    processed = processed.replace("<svg", `<svg height="${height}"`);
  }
  // Strip max-width caps everywhere (mermaid sometimes adds these inside the
  // root style attribute). Without this the SVG renders shrunk.
  processed = processed.replaceAll(RE_MAX_WIDTH_STYLE, "");

  return { html: processed, dims: { width, height } };
}

/**
 * Rewrite an SVG string's viewBox and width/height so it renders only the
 * given content-bounding-box region. Used by the minimap to crop out the
 * empty padding mermaid leaves around content.
 */
export function cropSvgToBBox(svgString: string, bbox: ContentBBox): string {
  return svgString
    .replace(
      RE_VIEWBOX,
      `viewBox="${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height}"`
    )
    .replace(RE_WIDTH_ATTR, `width="${bbox.width}"`)
    .replace(RE_HEIGHT_ATTR, `height="${bbox.height}"`);
}

// --- Fit-to-view -------------------------------------------------------------

/**
 * Compute an initial pan+zoom `Transform` that fits the diagram inside the
 * container with a small 8% margin.
 *
 * Two regimes:
 *   - Default: fit both axes, bounded by scale=1 (don't upscale above native).
 *   - Tall-diagram fallback: if the fit-both scale is below 15% (i.e. the
 *     diagram is so tall relative to the container that fitting-to-height
 *     leaves it unreadably small), switch to fit-to-WIDTH and pin it to the
 *     top (y=16). The user scrolls vertically with pan/wheel. This keeps tall
 *     flowcharts legible on first render instead of showing them at 6% size.
 */
export function computeFitTransform(
  dims: SvgDimensions,
  containerWidth: number,
  containerHeight: number
): Transform {
  const scaleX = containerWidth / dims.width;
  const scaleY = containerHeight / dims.height;
  const fitScale = Math.min(scaleX, scaleY, 1) * 0.92;

  if (fitScale < 0.15) {
    const widthFit = Math.min(scaleX, 1) * 0.92;
    return {
      scale: widthFit,
      // Centered horizontally, anchored 16px from the top.
      x: (containerWidth - dims.width * widthFit) / 2,
      y: 16,
    };
  }

  return {
    scale: fitScale,
    // Centered on both axes.
    x: (containerWidth - dims.width * fitScale) / 2,
    y: (containerHeight - dims.height * fitScale) / 2,
  };
}

// --- Pan/zoom math -----------------------------------------------------------

/**
 * Compute a new Transform that zooms to `newScale` while keeping the given
 * container-local point (cx, cy) fixed on screen.
 *
 * Derivation: the SVG coordinate under the point (cx, cy) is
 * `(cx - x) / scale`. We want that invariant when `scale` changes to `s'`:
 *     (cx - x') / s' = (cx - x) / s
 * Solving for x' gives:
 *     x' = cx - (cx - x) * (s' / s)
 * (and the same for y).
 *
 * The resulting scale is clamped to [MIN_SCALE, MAX_SCALE].
 */
export function zoomAtPoint(
  current: Transform,
  newScale: number,
  cx: number,
  cy: number
): Transform {
  const clamped = Math.min(Math.max(newScale, MIN_SCALE), MAX_SCALE);
  const ratio = clamped / current.scale;
  return {
    scale: clamped,
    x: cx - (cx - current.x) * ratio,
    y: cy - (cy - current.y) * ratio,
  };
}

/**
 * Compute a new Transform that translates the viewport so that SVG coordinate
 * `(svgX, svgY)` lands at the center of a container of the given size. The
 * current zoom level is preserved.
 */
export function centerOnSvgPoint(
  current: Transform,
  svgX: number,
  svgY: number,
  containerWidth: number,
  containerHeight: number
): Transform {
  return {
    ...current,
    x: containerWidth / 2 - svgX * current.scale,
    y: containerHeight / 2 - svgY * current.scale,
  };
}

// --- Label fitting -----------------------------------------------------------

/**
 * Shrink the font size of mermaid node labels whose HTML content overflows
 * the foreignObject's declared height.
 *
 * WHY THIS IS NEEDED: mermaid sizes each node's foreignObject based on a
 * single-line measurement, but the node label actually wraps. Wrapped text
 * can be taller than the foreignObject, which clips (or, with
 * `overflow: visible`, spills below the node visually). We read
 * `div.scrollHeight` (the natural content height with wrapping) and, when it
 * exceeds the declared `height`, scale the font down proportionally with a
 * 10% safety margin. 6px is the floor.
 *
 * Idempotent by design: the `div.style.fontSize` guard ensures each node is
 * only adjusted once, so repeated calls (e.g. from a MutationObserver) don't
 * bounce between sizes.
 */
export function fitNodeLabels(root: HTMLElement): void {
  const foreignObjects = root.querySelectorAll("foreignObject");
  for (const fo of foreignObjects) {
    const div = fo.querySelector("div");
    if (!div) {
      continue;
    }
    const foHeight = Number.parseFloat(fo.getAttribute("height") || "0");
    if (foHeight <= 0) {
      continue;
    }
    // Idempotency guard: we've already measured + adjusted this node.
    if (div.style.fontSize) {
      continue;
    }
    const contentHeight = div.scrollHeight;
    if (contentHeight > foHeight) {
      const ratio = foHeight / contentHeight;
      const base = Number.parseFloat(getComputedStyle(div).fontSize) || 16;
      // 0.9 leaves a bit of breathing room; Math.max caps the minimum so we
      // never produce unreadable 2-3px labels.
      div.style.fontSize = `${Math.max(6, base * ratio * 0.9)}px`;
    }
  }
}

// --- Base64 / export ---------------------------------------------------------

/**
 * Base64-encode a UTF-8 string in a way `btoa` accepts (it only accepts
 * Latin-1 / ISO-8859-1 code points).
 *
 * The previous approach, `btoa(unescape(encodeURIComponent(str)))`, relied on
 * the deprecated global `unescape`. We use `TextEncoder` instead — one pass,
 * no deprecated APIs.
 */
export function encodeSvgToBase64(svgString: string): string {
  const bytes = new TextEncoder().encode(svgString);
  // Build a Latin-1 string from the UTF-8 byte sequence.
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Trigger a browser download for a Blob by synthesizing a hidden anchor and
 * clicking it. Cleans up the object URL afterwards to avoid leaking.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Download the diagram as a standalone `.svg` file. */
export function exportSvg(svgString: string, filename: string): void {
  const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
  downloadBlob(blob, filename);
}

/**
 * Download the diagram as a rasterized PNG at 2x the natural size (for
 * crispness on HiDPI displays).
 *
 * The non-obvious bit is the data-URL source. When the SVG contains
 * `<foreignObject>` (which mermaid uses for HTML labels), loading it via
 * `URL.createObjectURL(blob)` taints the <canvas> in Chrome — `toBlob()` then
 * throws "Tainted canvases may not be exported". Inlining the SVG as a
 * base64 data URL is treated as same-origin and bypasses the restriction.
 */
export async function exportPng(
  svgString: string,
  width: number,
  height: number,
  filename: string
): Promise<void> {
  // Use a base64 data URL instead of blob URL — see function doc for reason.
  const dataUrl = `data:image/svg+xml;base64,${encodeSvgToBase64(svgString)}`;
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to load SVG"));
    img.src = dataUrl;
  });
  // 2x for HiDPI. Round up + guard against zero so we never create a 0-pixel
  // canvas (which would throw later).
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to get canvas context");
  }
  // White background — PNG has no transparent channel by default and some
  // viewers render a checkerboard pattern. A white fill matches the default
  // light-theme diagram rendering.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, width, height);
  const pngBlob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });
  if (pngBlob) {
    downloadBlob(pngBlob, filename);
  }
}
