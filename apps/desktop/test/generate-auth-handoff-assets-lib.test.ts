/**
 * ISS-11243 — the pure half of the auth-handoff asset generator, plus a check
 * that `generate-auth-handoff-assets.mjs` writes exactly the lib's output.
 *
 * The entrypoint rewrites `src/shared/auth-handoff-assets.generated.ts` at
 * module scope, and `src/main/auth/desktop-handoff-page.ts` imports that file,
 * so the real entrypoint is never run here. The wiring case runs a byte copy of
 * it inside a temp tree against fixture design-system files.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, it } from "vitest";
import {
  buildAuthHandoffAssets,
  DESIGN_SYSTEM_THEME_PATH,
  extractThemeBlocks,
  FONT_PATH,
  LOGO_DARK_PATH,
  LOGO_LIGHT_PATH,
  MISSING_THEME_MESSAGE,
  renderAuthHandoffAssetsModule,
  toDataUrl,
} from "../scripts/generate-auth-handoff-assets-lib.mjs";
import { readWoff2VariationAxes } from "./support/woff2-variation-axes.js";

const DESKTOP_DIR = fileURLToPath(new URL("..", import.meta.url));
const REAL_DESIGN_SYSTEM_DIR = path.join(
  DESKTOP_DIR,
  "..",
  "..",
  "packages",
  "design-system"
);
/** The static Geist face the page bundled before ISS-12591; the control case. */
const STATIC_GEIST_FONT_PATH =
  "node_modules/geist/dist/fonts/geist-sans/Geist-Regular.woff2";
const WEIGHT_AXIS_TAG = "wght";
const ENTRYPOINT_FILENAME = "generate-auth-handoff-assets.mjs";
const LIB_FILENAME = "generate-auth-handoff-assets-lib.mjs";

/**
 * The generator reads four small fixture files and writes one module; anything
 * near this is a hang. `spawnSync` blocks the worker, so the child carries its
 * own deadline and the case a larger one.
 */
const SPAWN_TIMEOUT_MS = 30_000;
const CASE_TIMEOUT_MS = 60_000;

const FIXTURE_CSS = [
  "@import 'tailwindcss';",
  ":root {",
  "  --background: oklch(1 0 0);",
  "  --radius: 0.625rem;",
  "}",
  "",
  ".dark {",
  "  --background: oklch(0.145 0 0);",
  "}",
  "",
  "@theme inline {",
  "  --color-background: var(--background);",
  "}",
  "",
].join("\n");
const FIXTURE_LIGHT_BODY =
  "\n  --background: oklch(1 0 0);\n  --radius: 0.625rem;";
const FIXTURE_DARK_BODY = "\n  --background: oklch(0.145 0 0);";
const FIXTURE_LOGO_LIGHT =
  '<svg xmlns="http://www.w3.org/2000/svg" id="light"/>';
const FIXTURE_LOGO_DARK = '<svg xmlns="http://www.w3.org/2000/svg" id="dark"/>';
const FIXTURE_FONT = Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0xff]);

const DATA_URL_RE = /^data:([^;]+);base64,([A-Za-z0-9+/]*={0,2})$/;
const LIGHT_THEME_OUTPUT_RE = /^:root \{[\s\S]*--background:/;
const DARK_THEME_OUTPUT_RE =
  /@media \(prefers-color-scheme: dark\) \{ :root \{[\s\S]*--background:/;

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("extractThemeBlocks", () => {
  it("returns the bodies of the :root and .dark blocks", () => {
    assert.deepEqual(extractThemeBlocks(FIXTURE_CSS), {
      light: FIXTURE_LIGHT_BODY,
      dark: FIXTURE_DARK_BODY,
    });
  });

  it("throws when the .dark block is missing", () => {
    const css = FIXTURE_CSS.replace(".dark {", ".night {");
    assert.throws(() => extractThemeBlocks(css), {
      message: MISSING_THEME_MESSAGE,
    });
  });

  it("throws when the :root block is missing", () => {
    const css = FIXTURE_CSS.replace(":root {", "html {");
    assert.throws(() => extractThemeBlocks(css), {
      message: MISSING_THEME_MESSAGE,
    });
  });
});

describe("toDataUrl", () => {
  it("base64-encodes the bytes under the given mime type", () => {
    assert.deepEqual(parseDataUrl(toDataUrl(FIXTURE_FONT, "font/woff2")), {
      mime: "font/woff2",
      bytes: FIXTURE_FONT,
    });
  });
});

describe("buildAuthHandoffAssets", () => {
  it("assembles the theme and three data URLs from the design-system files", () => {
    const assets = buildAuthHandoffAssets(fixtureReader(fixtureFiles()));

    assert.deepEqual(Object.keys(assets), [
      "theme",
      "logoLight",
      "logoDark",
      "font",
    ]);
    assert.equal(
      assets.theme,
      `:root {${FIXTURE_LIGHT_BODY}\n}\n@media (prefers-color-scheme: dark) { :root {${FIXTURE_DARK_BODY}\n} }`
    );
    assert.deepEqual(parseDataUrl(assets.logoLight), {
      mime: "image/svg+xml",
      bytes: Buffer.from(FIXTURE_LOGO_LIGHT),
    });
    assert.deepEqual(parseDataUrl(assets.logoDark), {
      mime: "image/svg+xml",
      bytes: Buffer.from(FIXTURE_LOGO_DARK),
    });
    assert.deepEqual(parseDataUrl(assets.font), {
      mime: "font/woff2",
      bytes: FIXTURE_FONT,
    });
  });

  it("throws on a missing theme block before reading any binary asset", () => {
    const files = fixtureFiles();
    files.set(
      DESIGN_SYSTEM_THEME_PATH,
      Buffer.from(FIXTURE_CSS.replace(".dark {", ".night {"))
    );
    const reads: string[] = [];
    const reader = fixtureReader(files);

    assert.throws(
      () =>
        buildAuthHandoffAssets((designSystemPath) => {
          reads.push(designSystemPath);
          return reader(designSystemPath);
        }),
      { message: MISSING_THEME_MESSAGE }
    );
    assert.deepEqual(reads, [DESIGN_SYSTEM_THEME_PATH]);
  });

  it("extracts both themes from the real design-system globals.css", () => {
    const assets = buildAuthHandoffAssets((designSystemPath) =>
      readFileSync(path.join(REAL_DESIGN_SYSTEM_DIR, designSystemPath))
    );

    assert.match(assets.theme, LIGHT_THEME_OUTPUT_RE);
    assert.match(assets.theme, DARK_THEME_OUTPUT_RE);
    assert.equal(parseDataUrl(assets.logoLight)?.mime, "image/svg+xml");
    assert.equal(parseDataUrl(assets.logoDark)?.mime, "image/svg+xml");
    assert.equal(parseDataUrl(assets.font)?.mime, "font/woff2");
    assert.ok((parseDataUrl(assets.font)?.bytes.length ?? 0) > 0);
  });
});

describe("bundled font face", () => {
  it("bundles a variable face whose weight axis spans 100 to 900", () => {
    const assets = buildAuthHandoffAssets((designSystemPath) =>
      readFileSync(path.join(REAL_DESIGN_SYSTEM_DIR, designSystemPath))
    );
    const font = parseDataUrl(assets.font);
    assert.ok(font, "the bundled font is not a data URL");

    const weightAxis = readWoff2VariationAxes(font.bytes).find(
      (axis) => axis.tag === WEIGHT_AXIS_TAG
    );
    assert.equal(weightAxis?.min, 100);
    assert.equal(weightAxis?.max, 900);
  });

  it("reads no weight axis from the static Geist-Regular face", () => {
    const axes = readWoff2VariationAxes(
      readFileSync(path.join(REAL_DESIGN_SYSTEM_DIR, STATIC_GEIST_FONT_PATH))
    );
    assert.deepEqual(axes, []);
  });
});

describe("renderAuthHandoffAssetsModule", () => {
  it("renders a module exporting the assets as JSON", () => {
    const assets = { theme: "t", logoLight: "a", logoDark: "b", font: "c" };
    assert.equal(
      renderAuthHandoffAssetsModule(assets),
      '// Generated by scripts/generate-auth-handoff-assets.mjs.\nexport const AUTH_HANDOFF_ASSETS = {"theme":"t","logoLight":"a","logoDark":"b","font":"c"};\n'
    );
  });
});

describe("generate-auth-handoff-assets.mjs wiring", () => {
  it(
    "writes the lib's rendered module for the design-system files it finds",
    () => {
      const files = fixtureFiles();
      const fixture = makeGeneratorFixture(files);

      const result = runGenerator(fixture.entrypoint);

      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        readFileSync(fixture.outFile, "utf8"),
        renderAuthHandoffAssetsModule(
          buildAuthHandoffAssets(fixtureReader(files))
        )
      );
    },
    CASE_TIMEOUT_MS
  );

  it(
    "exits non-zero and writes nothing when a theme block is missing",
    () => {
      const files = fixtureFiles();
      files.set(
        DESIGN_SYSTEM_THEME_PATH,
        Buffer.from(FIXTURE_CSS.replace(".dark {", ".night {"))
      );
      const fixture = makeGeneratorFixture(files);

      const result = runGenerator(fixture.entrypoint);

      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(MISSING_THEME_MESSAGE), result.stderr);
      assert.equal(existsSync(fixture.outFile), false);
    },
    CASE_TIMEOUT_MS
  );
});

function fixtureFiles(): Map<string, Buffer> {
  return new Map([
    [DESIGN_SYSTEM_THEME_PATH, Buffer.from(FIXTURE_CSS)],
    [LOGO_LIGHT_PATH, Buffer.from(FIXTURE_LOGO_LIGHT)],
    [LOGO_DARK_PATH, Buffer.from(FIXTURE_LOGO_DARK)],
    [FONT_PATH, FIXTURE_FONT],
  ]);
}

function fixtureReader(
  files: Map<string, Buffer>
): (designSystemPath: string) => Buffer {
  return (designSystemPath) => {
    const bytes = files.get(designSystemPath);
    if (!bytes) {
      throw new Error(`unexpected design-system read: ${designSystemPath}`);
    }
    return bytes;
  };
}

function parseDataUrl(url: string): { mime: string; bytes: Buffer } | null {
  const match = DATA_URL_RE.exec(url);
  if (!match) {
    return null;
  }
  return { mime: match[1], bytes: Buffer.from(match[2], "base64") };
}

type GeneratorFixture = { entrypoint: string; outFile: string };

/**
 * The entrypoint resolves the design system and its output off
 * `import.meta.url`, so a byte copy placed at the same relative position in a
 * temp root runs against fixtures. Both scripts are copied from disk at test
 * time, so the copy cannot drift from the source.
 */
function makeGeneratorFixture(files: Map<string, Buffer>): GeneratorFixture {
  const root = mkdtempSync(path.join(tmpdir(), "iss11243-gen-"));
  tempDirs.push(root);
  const scriptsDir = path.join(root, "apps", "desktop", "scripts");
  const designSystemDir = path.join(root, "packages", "design-system");
  mkdirSync(scriptsDir, { recursive: true });
  for (const [relative, bytes] of files) {
    const full = path.join(designSystemDir, ...relative.split("/"));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, bytes);
  }
  const entrypoint = path.join(scriptsDir, ENTRYPOINT_FILENAME);
  copyFileSync(
    path.join(DESKTOP_DIR, "scripts", ENTRYPOINT_FILENAME),
    entrypoint
  );
  copyFileSync(
    path.join(DESKTOP_DIR, "scripts", LIB_FILENAME),
    path.join(scriptsDir, LIB_FILENAME)
  );
  return {
    entrypoint,
    outFile: path.join(
      root,
      "apps",
      "desktop",
      "src",
      "shared",
      "auth-handoff-assets.generated.ts"
    ),
  };
}

function runGenerator(entrypoint: string) {
  return spawnSync(process.execPath, [entrypoint], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: SPAWN_TIMEOUT_MS,
  });
}
