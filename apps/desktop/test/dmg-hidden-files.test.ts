import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";
import { parse } from "yaml";
import parkDmgHiddenFiles, {
  type DmgContentEntry,
} from "../scripts/dmg-hidden-files.mjs";

/**
 * ISS-12185 — `dmg-hidden-files.mjs`, electron-builder's `beforePack` hook. It parks the
 * DMG's hidden support files below the installer window so a Finder that
 * shows hidden files does not list them beside the app. The hook is run
 * against the `dmg` block of the shipped `electron-builder.yml`, so dropping
 * either the hook wiring or the `contents` it extends fails here.
 */

// cwd for the desktop test suite is apps/desktop.
const CONFIG_PATH = path.resolve("electron-builder.yml");
// electron-builder's documented default for `dmg.iconSize`.
const DEFAULT_ICON_SIZE = 80;
const SUPPORT_FILES = [".background.tiff", ".VolumeIcon.icns", ".fseventsd"];
const MISSING_CONTENTS_ERROR = /dmg\.contents/;

type BuilderConfig = {
  beforePack?: string;
  directories?: { buildResources?: string } | null;
  dmg?: {
    background?: string | null;
    backgroundColor?: string | null;
    contents?: DmgContentEntry[] | null;
    iconSize?: number | null;
  } | null;
};

function readConfig(): BuilderConfig {
  return parse(fs.readFileSync(CONFIG_PATH, "utf8")) as BuilderConfig;
}

describe("DMG hidden-file positions", () => {
  test("electron-builder.yml wires the hook as beforePack", () => {
    assert.equal(readConfig().beforePack, "./scripts/dmg-hidden-files.mjs");
  });

  test("keeps the app and the Applications link inside the window", () => {
    const config = readConfig();
    const { height } = readWindowSize(config);
    const contents = config.dmg?.contents ?? [];
    assert.deepEqual(
      contents.map(({ type, path: entryPath }) => ({ type, path: entryPath })),
      [
        { type: "file", path: undefined },
        { type: "link", path: "/Applications" },
      ]
    );
    for (const entry of contents) {
      assert.ok(entry.y < height, JSON.stringify(entry));
    }
  });

  test("positions each support file below the window, once across repeated runs", () => {
    const config = readConfig();
    const { height } = readWindowSize(config);
    parkDmgHiddenFiles({ packager: { config } });
    parkDmgHiddenFiles({ packager: { config } });

    const positioned = (config.dmg?.contents ?? []).filter(
      (entry) => entry.type === "position"
    );
    for (const file of SUPPORT_FILES) {
      const matches = positioned.filter((entry) => entry.path === file);
      assert.equal(matches.length, 1, `${file}: ${JSON.stringify(positioned)}`);
      assert.ok(matches[0].y > height, JSON.stringify(matches[0]));
    }
  });

  // Positions are icon centers. An icon that crosses the window's width gives
  // Finder a horizontal scrollbar once hidden files are shown.
  test("keeps every icon within the window's width", () => {
    const config = readConfig();
    const { width } = readWindowSize(config);
    const halfIcon = (config.dmg?.iconSize ?? DEFAULT_ICON_SIZE) / 2;
    parkDmgHiddenFiles({ packager: { config } });

    for (const entry of config.dmg?.contents ?? []) {
      assert.ok(
        entry.x - halfIcon >= 0 && entry.x + halfIcon <= width,
        JSON.stringify(entry)
      );
    }
  });

  test("throws when dmg.contents is not declared", () => {
    assert.throws(
      () => parkDmgHiddenFiles({ packager: { config: { dmg: {} } } }),
      MISSING_CONTENTS_ERROR
    );
  });
});

// dmg-builder sizes the window to its background image (customizeDmg runs sips
// on it). With neither dmg.background nor dmg.backgroundColor set,
// computeBackground takes background.tiff, then background.png, from the build
// resources directory. A replaced background.png is measured; a
// background.tiff or a config override, which this PNG reader cannot follow,
// throws.
function readWindowSize(config: BuilderConfig): {
  width: number;
  height: number;
} {
  if (config.dmg?.background != null || config.dmg?.backgroundColor != null) {
    throw new Error("dmg.background or dmg.backgroundColor is set");
  }
  const resources = path.resolve(config.directories?.buildResources ?? "build");
  const background = ["background.tiff", "background.png"]
    .map((name) => path.join(resources, name))
    .find((file) => fs.existsSync(file));
  const png = path.join(resources, "background.png");
  if (background !== png) {
    throw new Error(`dmg-builder would use ${background ?? "its template"}`);
  }
  // A PNG stores its pixel width and height big-endian at bytes 16 and 20.
  const header = fs.readFileSync(png);
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}
