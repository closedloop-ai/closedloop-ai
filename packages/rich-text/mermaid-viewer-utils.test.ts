import { describe, expect, it } from "vitest";
import {
  centerOnSvgPoint,
  computeFitTransform,
  cropSvgToBBox,
  encodeSvgToBase64,
  MAX_SCALE,
  MIN_SCALE,
  prepareSvg,
  sanitizeSvg,
  type Transform,
  zoomAtPoint,
} from "./mermaid-viewer-utils";

const RE_RECT_WIDTH_100 = /<rect width="100"/;
const RE_MAX_WIDTH = /max-width:/;
const RE_ONLOAD_ATTR = /onload=/i;
const RE_ONERROR_ATTR = /onerror=/i;
const RE_ONCLICK_ATTR = /onclick=/i;
const RE_SCRIPT_TAG = /<script/i;
const RE_ANY_EVENT_HANDLER = /\son\w+\s*=/i;
const RE_JAVASCRIPT_URI = /(?:href|src|data)\s*=\s*["']?\s*javascript:/i;
const RE_FOREIGN_OBJECT = /<foreignobject/i;
const RE_IFRAME_TAG = /<iframe/i;
// Resource-loading or interactive tags that must never survive inside a label.
const RE_RESOURCE_OR_INTERACTIVE_TAG =
  /<(?:image|img|video|audio|source|track|picture|iframe|object|embed|form|input|button|textarea|select|a|link|base|meta)\b/i;
const RE_STYLE_URL = /url\(/i;
const RE_LABEL_LAYOUT_STYLE = /style="[^"]*table-cell/i;
const RE_EXTERNAL_CSS_URL = /url\(\s*["']?https?:/i;
const RE_AT_IMPORT = /@import/i;

/**
 * Build a flowchart-node-label fragment in the exact shape mermaid v11 emits
 * for `htmlLabels: true` (the default under `securityLevel: "loose"`): an SVG
 * `<foreignObject>` wrapping an XHTML `<div>` → `<span class="nodeLabel">` →
 * `<p>`. This is the markup the SVG-only DOMPurify profile used to blank
 * (FEA-2086).
 */
function flowchartNodeLabel(text: string): string {
  return `<foreignObject width="80" height="24"><div xmlns="http://www.w3.org/1999/xhtml" style="display: table-cell; white-space: nowrap; line-height: 1.5; text-align: center;"><span class="nodeLabel "><p>${text}</p></span></div></foreignObject>`;
}

/** Wrap a label fragment in a minimal but realistic mermaid flowchart SVG. */
function flowchartSvg(labelText: string): string {
  return `<svg id="m1" viewBox="0 0 200 100" role="graphics-document" aria-roledescription="flowchart-v2"><style>#m1 .nodeLabel{fill:#333;}</style><g class="root"><g class="nodes"><g class="node default"><rect class="basic label-container" width="120" height="40"></rect><g class="label" transform="translate(-40,-12)">${flowchartNodeLabel(labelText)}</g></g></g></g></svg>`;
}

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
    // Passthrough (no width/height/viewBox rewrite) so something still
    // renders. DOMPurify normalizes the self-closing tag to an explicit
    // open/close pair, but the element itself is preserved.
    expect(html).toContain("<svg>");
    expect(html).toContain("<rect");
  });

  it("strips <script> elements from the SVG", () => {
    const input =
      '<svg viewBox="0 0 10 10"><script>alert(1)</script><rect/></svg>';
    const { html } = prepareSvg(input);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    // The legitimate shape is preserved.
    expect(html).toContain("<rect");
  });

  it("strips event-handler attributes (onload/onerror/onclick)", () => {
    const input =
      '<svg viewBox="0 0 10 10"><rect onload="evil()" onclick="evil()"/><image onerror="evil()"/></svg>';
    const { html } = prepareSvg(input);
    expect(html).not.toMatch(RE_ONLOAD_ATTR);
    expect(html).not.toMatch(RE_ONERROR_ATTR);
    expect(html).not.toMatch(RE_ONCLICK_ATTR);
    expect(html).not.toContain("evil()");
  });

  it("preserves mermaid foreignObject text while stripping active content", () => {
    const input =
      '<svg viewBox="0 0 120 80"><foreignObject x="8" y="8" width="100" height="40"><div xmlns="http://www.w3.org/1999/xhtml" onclick="evil()" style="color: #fff;"><script>bad()</script><b>Readable label</b></div></foreignObject></svg>';
    const { html } = prepareSvg(input);

    expect(html).toMatch(RE_FOREIGN_OBJECT);
    expect(html).toContain("Readable label");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(RE_ONCLICK_ATTR);
    expect(html).not.toContain("evil()");
    expect(html).not.toContain("bad()");
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

// FEA-2086: flowchart node labels live in <foreignObject> HTML. The original
// security hardening (commit f6c6e877a) sanitized with the SVG-only DOMPurify
// profile, which dropped foreignObject + its HTML children and blanked every
// flowchart label. These tests pin the labels-survive behavior AND the XSS
// hardening that must NOT regress with it.
describe("sanitizeSvg: flowchart foreignObject labels (FEA-2086)", () => {
  // AC-001: a minimal flowchart node label survives sanitization.
  it("preserves a simple flowchart node label", () => {
    const out = sanitizeSvg(flowchartSvg("Start"));
    expect(out).toMatch(RE_FOREIGN_OBJECT);
    expect(out).toContain("Start");
    expect(out).toContain('class="nodeLabel');
  });

  // AC-003: quoted text and route/path-like punctuation survive (these were the
  // PLN-1069 labels that rendered blank).
  it("preserves route/path-like and quoted label text", () => {
    const out = sanitizeSvg(flowchartSvg("GET /api/v1/users?id=1"));
    expect(out).toContain("GET /api/v1/users?id=1");

    const quoted = sanitizeSvg(flowchartSvg("Return &quot;data&quot;"));
    expect(quoted).toContain('Return "data"');
  });

  // AC-002: the PLN-1069 v4-style flowchart (multiple foreignObject labels)
  // renders visible labels without converting to a sequenceDiagram.
  it("preserves every label in a multi-node flowchart", () => {
    const svg = `<svg viewBox="0 0 400 200"><g class="nodes">${[
      "Implementation fit",
      "Renderer",
      "Sanitizer",
    ]
      .map(
        (t) =>
          `<g class="node"><g class="label">${flowchartNodeLabel(t)}</g></g>`
      )
      .join("")}</g></svg>`;
    const out = sanitizeSvg(svg);
    expect(out).toContain("Implementation fit");
    expect(out).toContain("Renderer");
    expect(out).toContain("Sanitizer");
  });

  // AC-004: sequence-diagram <text> labels keep rendering (the path that always
  // worked must not regress).
  it("preserves sequence-diagram <text> labels", () => {
    const seq =
      '<svg viewBox="0 0 200 100"><text class="messageText" x="10" y="20">Login(user)</text><text class="actor" x="5" y="5">Browser</text></svg>';
    const out = sanitizeSvg(seq);
    expect(out).toContain("Login(user)");
    expect(out).toContain("Browser");
  });

  // The viewer renders sanitizeSvg output via dangerouslySetInnerHTML, so the
  // full prepareSvg pipeline must also keep labels intact end-to-end.
  it("keeps labels through the full prepareSvg pipeline", () => {
    const { html, dims } = prepareSvg(flowchartSvg("Persist record"));
    expect(dims).toEqual({ width: 200, height: 100 });
    expect(html).toContain("Persist record");
    expect(html).toMatch(RE_FOREIGN_OBJECT);
  });
});

describe("sanitizeSvg: XSS hardening still holds with foreignObject allowed", () => {
  // Allowing foreignObject HTML must not reopen the stored-XSS hole the original
  // security commit closed. Each payload must come out inert.
  const payloads: ReadonlyArray<readonly [string, string]> = [
    [
      "script inside foreignObject",
      "<svg><foreignObject><div><script>alert(1)</script></div></foreignObject></svg>",
    ],
    [
      "img onerror inside foreignObject",
      '<svg><foreignObject><img src="x" onerror="alert(1)"></foreignObject></svg>',
    ],
    [
      "anchor javascript: URI",
      '<svg><foreignObject><a href="javascript:alert(1)">x</a></foreignObject></svg>',
    ],
    [
      "iframe javascript: URI",
      '<svg><foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject></svg>',
    ],
    [
      "object data javascript: URI",
      '<svg><foreignObject><object data="javascript:alert(1)"></object></foreignObject></svg>',
    ],
    [
      "nested svg re-entering script context",
      "<svg><foreignObject><svg><script>alert(1)</script></svg></foreignObject></svg>",
    ],
    [
      "details ontoggle handler",
      '<svg><foreignObject><details ontoggle="alert(1)" open></details></foreignObject></svg>',
    ],
    [
      "mutation-XSS namespace confusion",
      '<svg></p><foreignObject><math><mtext></table><div><style><a title="</style><img src=x onerror=alert(1)>"></div></foreignObject></svg>',
    ],
  ];

  for (const [name, payload] of payloads) {
    it(`neutralizes: ${name}`, () => {
      const out = sanitizeSvg(payload);
      expect(out).not.toMatch(RE_SCRIPT_TAG);
      expect(out).not.toMatch(RE_ANY_EVENT_HANDLER);
      expect(out).not.toMatch(RE_JAVASCRIPT_URI);
      expect(out).not.toContain("alert(1)");
    });
  }

  it("still strips script/event-handler/iframe from a benign-looking flowchart label", () => {
    const malicious = flowchartSvg(
      "ok<img src=x onerror=\"fetch('/steal?c='+document.cookie)\">"
    );
    const out = sanitizeSvg(malicious);
    // The benign label text survives...
    expect(out).toContain("ok");
    // ...but the injected handler/script/iframe vectors do not.
    expect(out).not.toMatch(RE_ANY_EVENT_HANDLER);
    expect(out).not.toMatch(RE_SCRIPT_TAG);
    expect(out).not.toMatch(RE_IFRAME_TAG);
    expect(out).not.toContain("document.cookie");
  });
});

// Allowing the html profile inside <foreignObject> must not admit tags/attrs
// that fetch an external resource on render. A stored diagram could otherwise
// beacon a viewer's IP/UA: mermaid keeps an injected `<img src=...>` in a
// loose-mode flowchart edge or node label. The old SVG-only profile stripped
// all of these; these tests keep that protection after the foreignObject fix.
describe("sanitizeSvg: passive resource-loading is blocked (FEA-2086 review)", () => {
  const labelBeacons: ReadonlyArray<readonly [string, string]> = [
    ["img beacon", '<img src="http://attacker.example/b.gif">'],
    [
      "svg image href",
      '<svg><image href="http://attacker.example/i.png"/></svg>',
    ],
    ["video poster", '<video poster="http://attacker.example/p.jpg"></video>'],
    ["audio src", '<audio src="http://attacker.example/a.mp3"></audio>'],
    ["img srcset", '<img srcset="http://attacker.example/s.gif 1x">'],
    ["form/input clobber", '<form><input name="x"></form>'],
    ["anchor navigation", '<a href="http://attacker.example/phish">click</a>'],
  ];

  for (const [name, injected] of labelBeacons) {
    it(`strips resource/interactive markup: ${name}`, () => {
      const out = sanitizeSvg(flowchartSvg(`label ${injected}`));
      // The label container and its text survive...
      expect(out).toMatch(RE_FOREIGN_OBJECT);
      expect(out).toContain("label");
      // ...but the resource-loading / interactive element is gone.
      expect(out).not.toMatch(RE_RESOURCE_OR_INTERACTIVE_TAG);
    });
  }

  it("neutralizes a CSS url() beacon in an inline style attribute", () => {
    const out = sanitizeSvg(
      flowchartSvg(
        '<span style="color:red;background:url(http://attacker.example/s)">x</span>'
      )
    );
    expect(out).toContain("x");
    expect(out).not.toMatch(RE_STYLE_URL);
  });

  it("keeps mermaid's legitimate top-level <style> theming and label layout style", () => {
    // flowchartSvg embeds a top-level <style> theming block and a label layout
    // style attribute; both must survive so diagrams render correctly.
    const out = sanitizeSvg(flowchartSvg("Themed"));
    expect(out).toContain("<style>");
    expect(out).toMatch(RE_LABEL_LAYOUT_STYLE);
  });

  // <style> is allowed (mermaid's theming block needs it), so the inline-style
  // attribute hook is not enough: a label-owned <style> could beacon through
  // CSS @import / url(). The element hook must scrub those from <style> text.
  it("scrubs @import and external url() from a label-owned <style> element", () => {
    const out = sanitizeSvg(
      flowchartSvg(
        "<span><style>@import url(https://attacker.example/x.css);b{background:url(http://attacker.example/p)}</style>label</span>"
      )
    );
    expect(out).toContain("label");
    expect(out).not.toMatch(RE_AT_IMPORT);
    expect(out).not.toMatch(RE_EXTERNAL_CSS_URL);
  });

  it("preserves internal url(#id) references (gradients, markers, filters)", () => {
    // mermaid references its own <defs> via url(#id); these are not beacons and
    // must survive both in <style> text and in presentation attributes.
    const svg =
      '<svg><style>.edge{stroke:url(#grad1)}</style><g><path marker-end="url(#arrow)"></path><foreignObject><span>L</span></foreignObject></g></svg>';
    const out = sanitizeSvg(svg);
    expect(out).toContain("url(#grad1)");
    expect(out).toContain("url(#arrow)");
  });

  // mermaid `click`/`href` directives are intentionally disabled: navigable
  // links in untrusted stored diagrams are a phishing vector. Confirm an
  // SVG-level node anchor is stripped while the node text survives.
  it("disables mermaid click/href node links (security trade-off)", () => {
    const out = sanitizeSvg(
      '<svg><g class="node"><a href="http://attacker.example/phish"><g class="label"><foreignObject><span>Node</span></foreignObject></g></a></g></svg>'
    );
    expect(out).toContain("Node");
    expect(out).not.toMatch(RE_RESOURCE_OR_INTERACTIVE_TAG);
  });
});
