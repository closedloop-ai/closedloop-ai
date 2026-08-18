/**
 * ISS-5303 — `scripts/generate-icons-lib.cjs`, driven against the REAL tray
 * source.
 *
 * `generate-icons.cjs` rasterizes at module scope through `sharp` and writes
 * into `resources/`, so it can neither be imported nor subprocess-driven here.
 * Two things therefore have to be proven structurally instead: that the shipped
 * `resources/trayIconTemplate.svg` is the input this lib is actually correct
 * for, and that the entrypoint still routes through the lib to build it.
 *
 * The sizes are read out of the entrypoint's own AST rather than restated, so
 * "every size the entrypoint uses" stays true when the entrypoint changes: a
 * new size fails the expectation table below until it is given one.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  extractTrayPaths,
  makeSquareTray,
} from "../scripts/generate-icons-lib.cjs";
import {
  calledIdentifiers,
  declaredFunctionNames,
  numericArgumentsOf,
  parseDesktopScript,
  requiredNamesFrom,
} from "./helpers/entrypoint-wiring.js";

const DESKTOP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TRAY_SVG_PATH = path.join(
  DESKTOP_DIR,
  "resources",
  "trayIconTemplate.svg"
);

const ENTRYPOINT = "generate-icons.cjs";
const LIB_MODULE = "./generate-icons-lib.cjs";

/** Hoisted per Ultracite's `useTopLevelRegex` rule. */
const NO_PATH_ELEMENTS_MESSAGE = /no <path .*\/> elements/;
const TRAY_VIEWBOX_RE = /viewBox="(\d+) (\d+) (\d+) (\d+)"/;
const PATH_OPEN_TAG_RE = /<path\b/g;

const REAL_TRAY_SVG = readFileSync(TRAY_SVG_PATH, "utf8");
const REAL_TRAY_PATHS = extractTrayPaths(REAL_TRAY_SVG);

/**
 * The sizes `generate-icons.cjs` hands `makeSquareTray`, read from the
 * entrypoint itself. Today: 72 (rasterized down to the 18x18 tray icon) and 144
 * (down to the 36x36 @2x icon).
 */
const ENTRYPOINT_TRAY_SIZES = numericArgumentsOf(
  parseDesktopScript(ENTRYPOINT),
  "makeSquareTray"
).flat();

/**
 * The transform each of those sizes must produce, byte-checked against the
 * pre-extraction implementation. A drift in either number moves the mark inside
 * the tray slot without failing anything else.
 */
const EXPECTED_TRANSFORMS = new Map<number, string>([
  [72, "translate(2.6776859504132204, 0) scale(0.5950413223140496)"],
  [144, "translate(5.355371900826441, 0) scale(1.1900826446280992)"],
]);

function trayDocument(size: number, transform: string, paths: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <g transform="${transform}">
    ${paths}
  </g>
</svg>`;
}

/**
 * `[width, height]` of the real tray source's own viewBox. Throws rather than
 * asserting: this is a precondition of the case below, not one of its claims,
 * and a fixture that cannot be read must not read as a normal failed assertion.
 */
function realTrayViewBox(): [number, number] {
  const match = TRAY_VIEWBOX_RE.exec(REAL_TRAY_SVG);
  if (!match) {
    throw new Error(`${TRAY_SVG_PATH} declares no viewBox`);
  }
  return [Number(match[3]), Number(match[4])];
}

describe("ISS-5303: the real tray source is the input this lib assumes", () => {
  test("every path element in resources/trayIconTemplate.svg is taken", () => {
    // The real mark is two multi-line <path .../> elements wrapped in an <svg>
    // with a <title>. A single-line stub cannot show any of that: a pattern
    // without `[\s\S]` matches the stub and silently truncates this file, and a
    // pattern that took every element would swallow the <title> too.
    const occurrences = REAL_TRAY_SVG.match(PATH_OPEN_TAG_RE) ?? [];
    assert.equal(occurrences.length, 2);

    const elements = REAL_TRAY_PATHS.split("\n    <path");
    assert.equal(elements.length, 2);
    assert.ok(REAL_TRAY_PATHS.startsWith("<path"));
    assert.ok(REAL_TRAY_PATHS.endsWith("/>"));
    assert.equal(REAL_TRAY_PATHS.includes("<title>"), false);
    assert.equal(REAL_TRAY_PATHS.includes("<svg"), false);
  });

  test("the extracted paths carry the artwork verbatim, newlines included", () => {
    // The `d` attribute is split across five lines in the source. Anything that
    // normalized or re-wrapped it would change the rasterized geometry.
    assert.ok(
      REAL_TRAY_PATHS.includes(
        'd="M 50.5000 23.2031\n       A 39.5000 39.5000 0 1 0 93.7969 66.5000'
      ),
      REAL_TRAY_PATHS
    );
    assert.ok(
      REAL_TRAY_PATHS.includes(
        'd="M 58.5000 23.2031\n       A 39.5000 39.5000 0 0 1 93.7969 58.5000'
      ),
      REAL_TRAY_PATHS
    );
    assert.equal(
      REAL_TRAY_PATHS.split('fill="#000000"').length - 1,
      2,
      "both fills survived the extraction"
    );
  });

  test("the lib's geometry constants match that source's own viewBox", () => {
    // 112 wide in a 121 box. The lib hardcodes both, so a redraw that changed
    // the viewBox without updating them would off-centre the tray mark on every
    // machine — silently, because the rasterizer accepts any transform.
    const [markWidth, extent] = realTrayViewBox();

    assert.deepEqual([markWidth, extent], [112, 121]);
    // At the source extent the transform must degenerate to scale 1 and half
    // the leftover width. This is the geometry contract stated in terms the SVG
    // itself supplies, not in terms of the lib's private constants.
    assert.equal(
      makeSquareTray(extent, REAL_TRAY_PATHS),
      trayDocument(
        extent,
        `translate(${(extent - markWidth) / 2}, 0) scale(1)`,
        REAL_TRAY_PATHS
      )
    );
  });
});

describe("ISS-5303: the tray documents generate-icons.cjs rasterizes", () => {
  test("the entrypoint builds trays at exactly the expected sizes", () => {
    // Guards the table below from going stale: a third `makeSquareTray(...)`
    // call in the entrypoint fails here rather than going uncovered.
    assert.deepEqual(ENTRYPOINT_TRAY_SIZES, [...EXPECTED_TRANSFORMS.keys()]);
  });

  for (const size of EXPECTED_TRANSFORMS.keys()) {
    test(`emits the exact ${size}-unit document for the real mark`, () => {
      const transform = EXPECTED_TRANSFORMS.get(size);
      assert.ok(transform, `no pinned transform for size ${size}`);

      assert.equal(
        makeSquareTray(size, REAL_TRAY_PATHS),
        trayDocument(size, transform, REAL_TRAY_PATHS)
      );
    });
  }

  test("size parameterizes the canvas, the scale and the centring together", () => {
    // Anything that hardcoded one of the three passes both sizes above by
    // coincidence.
    assert.notEqual(
      makeSquareTray(72, REAL_TRAY_PATHS),
      makeSquareTray(144, REAL_TRAY_PATHS)
    );
  });
});

// The branches below are unreachable from the real tray source: it always has
// paths, has no <rect> or nested <g>, and is read once. Stubs are the only way
// to exercise them.
const STUB_PATH = '<path d="M0 0h1v1z"/>';

describe("ISS-5303: tray-path extraction branches the real SVG cannot reach", () => {
  test("drops non-path elements and descends into groups", () => {
    assert.equal(
      extractTrayPaths(
        '<svg><rect x="0"/><path d="a"/><g><path d="b" fill="#000"/></g></svg>'
      ),
      '<path d="a"/>\n    <path d="b" fill="#000"/>'
    );
  });

  test("is not stateful across calls", () => {
    // The pattern is a module-level /g regex. String#match resets lastIndex, but
    // a future switch to exec/test would not — and a half-empty tray icon is the
    // kind of defect that ships.
    const svg = '<svg><path d="a"/><path d="b"/></svg>';

    assert.equal(extractTrayPaths(svg), extractTrayPaths(svg));
  });

  test("refuses a tray SVG with no path at all", () => {
    // A blank tray icon reads as a broken app, so this must fail the generator
    // rather than quietly rasterize 18x18 of nothing.
    assert.throws(
      () => extractTrayPaths('<svg><rect x="0" y="0"/></svg>'),
      NO_PATH_ELEMENTS_MESSAGE
    );
  });

  test("embeds the caller's paths verbatim", () => {
    assert.ok(
      makeSquareTray(121, STUB_PATH).includes(`\n    ${STUB_PATH}\n`),
      "the stub path is not embedded as given"
    );
  });
});

describe("ISS-5303: generate-icons.cjs is wired to the lib", () => {
  test("requires exactly the two helpers the lib exports for it", () => {
    // CommonJS, so the binding is a destructured `require(...)` and
    // `namedImportsFrom` would see nothing. Without this, re-inlining
    // `makeSquareTray` into the entrypoint leaves every case above green while
    // the shipped icons come from an untested second copy.
    const entrypoint = parseDesktopScript(ENTRYPOINT);

    assert.deepEqual(requiredNamesFrom(entrypoint, LIB_MODULE), [
      "extractTrayPaths",
      "makeSquareTray",
    ]);
  });

  test("the required names are the ones the lib actually exports", () => {
    const required = requiredNamesFrom(
      parseDesktopScript(ENTRYPOINT),
      LIB_MODULE
    );
    const exported: Record<string, unknown> = {
      extractTrayPaths,
      makeSquareTray,
    };

    for (const name of required) {
      assert.notEqual(
        exported[name],
        undefined,
        `${ENTRYPOINT} requires ${name}, which the lib does not export`
      );
    }
  });

  test("keeps no local copy of either helper", () => {
    const declared = declaredFunctionNames(parseDesktopScript(ENTRYPOINT));

    assert.deepEqual(
      declared.filter(
        (name) => name === "extractTrayPaths" || name === "makeSquareTray"
      ),
      []
    );
  });

  test("still extracts once and still builds one tray per size", () => {
    const called = calledIdentifiers(parseDesktopScript(ENTRYPOINT));

    assert.equal(
      called.filter((name) => name === "extractTrayPaths").length,
      1
    );
    assert.equal(
      called.filter((name) => name === "makeSquareTray").length,
      ENTRYPOINT_TRAY_SIZES.length
    );
  });
});
