/**
 * @file agent-coaching-packs-coverage.test.ts
 * @description ISS-10308: behavior pins for the coaching-pack store paths
 * agent-coaching-packs.test.ts does not reach: the folder-pick install, the
 * identity fallbacks, the listing and pointer guards, the distribution-install
 * dead ends, and the bundled-dir resolver. The bundled seed lives in
 * agent-coaching-packs-seed-coverage.test.ts.
 */
import assert from "node:assert/strict";
import type * as NodeFs from "node:fs";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
  getActiveCoachingPack,
  installCoachingPack,
  installCoachingPackFromDistribution,
  listInstalledCoachingPacks,
  readCoachingPackManifest,
  resolveBundledCoachingPacksDir,
  setActiveCoachingPack,
} from "../src/main/agent-monitor/agent-coaching-packs.js";
import { createTempDirManager } from "./helpers/temp-dir.js";

// Only cpSync is hooked, and only while a test sets an override: a real copy
// always leaves a readable manifest behind, so the "copy landed nothing"
// guards are unreachable without replacing the copy itself.
const fsHooks = vi.hoisted(() => ({
  cpSyncOverride: null as null | (() => void),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    cpSync: (...args: Parameters<typeof actual.cpSync>) => {
      if (fsHooks.cpSyncOverride) {
        fsHooks.cpSyncOverride();
        return;
      }
      actual.cpSync(...args);
    },
  };
});

const { makeTempDir } = createTempDirManager("coaching-packs-cov-");

let root: string;
let packsDir: string;

beforeEach(() => {
  root = makeTempDir();
  packsDir = path.join(root, "store");
});

afterEach(() => {
  fsHooks.cpSyncOverride = null;
});

function writePack(
  dir: string,
  manifest: Record<string, unknown>,
  plugin?: Record<string, unknown>
): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "coaching-pack.json"), JSON.stringify(manifest));
  if (plugin) {
    mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      path.join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify(plugin)
    );
  }
  return dir;
}

function readActivePointerText(): string {
  return readFileSync(path.join(packsDir, "active.json"), "utf8");
}

describe("readCoachingPackManifest identity fallbacks", () => {
  test("names the pack after its directory when no manifest names it", () => {
    const dir = writePack(path.join(root, "dir-named-pack"), {
      signals: ["s"],
    });

    assert.deepEqual(readCoachingPackManifest(dir), {
      name: "dir-named-pack",
      displayName: "dir-named-pack",
      version: null,
      description: null,
      signals: ["s"],
    });
  });

  test("returns null when the directory name is blank after trimming", () => {
    const dir = writePack(path.join(root, "   "), { signals: ["s"] });

    assert.equal(readCoachingPackManifest(dir), null);
  });

  test("prefers manifest fields, then display_name, then plugin.json", () => {
    const dir = writePack(
      path.join(root, "mixed"),
      {
        name: "   ",
        display_name: "Snake Name",
        version: "3.0.0",
        signals: ["s"],
      },
      {
        name: "plugin-name",
        displayName: "Plugin Display",
        version: "9.9.9",
        description: "from plugin",
      }
    );

    assert.deepEqual(readCoachingPackManifest(dir), {
      name: "plugin-name",
      displayName: "Snake Name",
      version: "3.0.0",
      description: "from plugin",
      signals: ["s"],
    });
  });
});

describe("listInstalledCoachingPacks guards", () => {
  test("returns an empty list when the store does not exist", () => {
    assert.deepEqual(listInstalledCoachingPacks(path.join(root, "absent")), []);
  });

  test("skips files and directories without a usable manifest", () => {
    writePack(path.join(packsDir, "good"), { name: "good", signals: ["s"] });
    mkdirSync(path.join(packsDir, "broken"), { recursive: true });
    setActiveCoachingPack(packsDir, "good");

    assert.deepEqual(
      listInstalledCoachingPacks(packsDir).map((pack) => pack.name),
      ["good"]
    );
  });
});

describe("getActiveCoachingPack pointer guards", () => {
  test("a pointer name that cannot slugify reads as no active pack", () => {
    setActiveCoachingPack(packsDir, "active");

    assert.equal(getActiveCoachingPack(packsDir), null);
  });

  test("a pointer that resolves to a file, not a directory, reads as null", () => {
    mkdirSync(packsDir, { recursive: true });
    writeFileSync(path.join(packsDir, "notes"), "not a pack");
    setActiveCoachingPack(packsDir, "notes");

    assert.equal(getActiveCoachingPack(packsDir), null);
  });

  test("a non-string pointer value reads as null", () => {
    mkdirSync(packsDir, { recursive: true });
    writeFileSync(
      path.join(packsDir, "active.json"),
      JSON.stringify({ activePackName: 42 })
    );

    assert.equal(getActiveCoachingPack(packsDir), null);
  });

  test("a pointer holding a display name resolves through its slug", () => {
    writePack(path.join(packsDir, "token-coach"), {
      name: "token-coach",
      signals: ["s"],
    });
    setActiveCoachingPack(packsDir, "Token Coach");

    assert.equal(getActiveCoachingPack(packsDir)?.name, "token-coach");
  });
});

describe("installCoachingPack", () => {
  test("a missing source throws the not-found message and creates no store", () => {
    const missing = path.join(root, "missing");

    assert.throws(() => installCoachingPack(missing, packsDir), {
      message: `not a valid coaching pack (source not found): ${missing}`,
    });
    assert.equal(existsSync(packsDir), false);
  });

  test("a source without signals throws naming the canonical real path", () => {
    const real = path.join(root, "real-empty");
    mkdirSync(real);
    const link = path.join(root, "link-to-empty");
    symlinkSync(real, link);

    assert.throws(() => installCoachingPack(link, packsDir), {
      message: `not a valid coaching pack (missing coaching-pack.json with signals): ${realpathSync(real)}`,
    });
    assert.equal(existsSync(packsDir), false);
  });

  test("a name that cannot slugify throws and creates no store", () => {
    const source = writePack(path.join(root, "src"), {
      name: "active",
      signals: ["s"],
    });

    assert.throws(() => installCoachingPack(source, packsDir), {
      message: "invalid coaching pack name: active",
    });
    assert.equal(existsSync(packsDir), false);
  });

  test("copies the real source under its slug and writes the pointer", () => {
    const real = writePack(path.join(root, "src"), {
      name: "Token Coach",
      version: "1.0.0",
      signals: ["keep the prefix stable"],
    });
    const link = path.join(root, "picked");
    symlinkSync(real, link);

    const installed = installCoachingPack(link, packsDir);
    rmSync(real, { recursive: true });

    assert.deepEqual(installed, {
      name: "Token Coach",
      displayName: "Token Coach",
      version: "1.0.0",
      description: null,
      signals: ["keep the prefix stable"],
    });
    assert.deepEqual(readdirSync(packsDir).sort(), [
      "active.json",
      "token-coach",
    ]);
    assert.equal(
      readActivePointerText(),
      '{\n  "activePackName": "token-coach"\n}\n'
    );
    assert.deepEqual(getActiveCoachingPack(packsDir)?.signals, [
      "keep the prefix stable",
    ]);
  });

  test("re-installing the same version replaces the copy and takes the pointer", () => {
    writePack(path.join(packsDir, "token-coach"), {
      name: "token-coach",
      version: "1.0.0",
      signals: ["old"],
    });
    writePack(path.join(packsDir, "other"), { name: "other", signals: ["o"] });
    setActiveCoachingPack(packsDir, "other");
    const source = writePack(path.join(root, "src"), {
      name: "token-coach",
      version: "1.0.0",
      signals: ["new"],
    });

    installCoachingPack(source, packsDir);

    assert.deepEqual(getActiveCoachingPack(packsDir), {
      name: "token-coach",
      displayName: "token-coach",
      version: "1.0.0",
      description: null,
      signals: ["new"],
    });
  });

  test("a copy that lands no manifest throws and writes no pointer", () => {
    const source = writePack(path.join(root, "src"), {
      name: "token-coach",
      signals: ["s"],
    });
    fsHooks.cpSyncOverride = () => undefined;

    assert.throws(() => installCoachingPack(source, packsDir), {
      message: `coaching pack failed to install: ${path.join(packsDir, "token-coach")}`,
    });
    assert.equal(existsSync(path.join(packsDir, "active.json")), false);
  });
});

describe("installCoachingPackFromDistribution dead ends", () => {
  test("a name that cannot slugify returns null and creates no store", () => {
    const source = writePack(path.join(root, "src"), {
      name: "active",
      signals: ["s"],
    });

    assert.equal(
      installCoachingPackFromDistribution(source, packsDir, true),
      null
    );
    assert.equal(existsSync(packsDir), false);
  });

  // Pins current behavior; looks odd because a slug directory with no valid
  // manifest blocks the install for good: the copy runs only when the
  // directory is missing or the installed version differs, and a broken
  // install has no version to differ from.
  test("an existing slug directory with no manifest is not repaired", () => {
    mkdirSync(path.join(packsDir, "token-coach"), { recursive: true });
    const source = writePack(path.join(root, "src"), {
      name: "token-coach",
      version: "1.0.0",
      signals: ["s"],
    });

    assert.equal(
      installCoachingPackFromDistribution(source, packsDir, true),
      null
    );
    assert.deepEqual(readdirSync(path.join(packsDir, "token-coach")), []);
    assert.equal(existsSync(path.join(packsDir, "active.json")), false);
  });

  test("a copy that throws returns null and writes no pointer", () => {
    const source = writePack(path.join(root, "src"), {
      name: "token-coach",
      signals: ["s"],
    });
    fsHooks.cpSyncOverride = () => {
      throw new Error("EACCES: simulated");
    };

    assert.equal(
      installCoachingPackFromDistribution(source, packsDir, true),
      null
    );
    assert.equal(existsSync(path.join(packsDir, "active.json")), false);
  });
});

describe("resolveBundledCoachingPacksDir", () => {
  const hadResourcesPath = Object.hasOwn(process, "resourcesPath");
  const originalResourcesPath: unknown = Reflect.get(process, "resourcesPath");
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let cwd: string;

  beforeEach(() => {
    cwd = path.join(root, "cwd");
    mkdirSync(cwd);
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
    Reflect.deleteProperty(process, "resourcesPath");
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    if (hadResourcesPath) {
      Reflect.set(process, "resourcesPath", originalResourcesPath);
    } else {
      Reflect.deleteProperty(process, "resourcesPath");
    }
  });

  test("prefers the packaged resourcesPath directory", () => {
    const resources = path.join(root, "resources");
    mkdirSync(path.join(resources, "coaching-packs"), { recursive: true });
    mkdirSync(path.join(cwd, "resources", "coaching-packs"), {
      recursive: true,
    });
    Reflect.set(process, "resourcesPath", resources);

    assert.equal(
      resolveBundledCoachingPacksDir(),
      path.join(resources, "coaching-packs")
    );
  });

  test("skips a candidate that is a file and falls through to cwd/resources", () => {
    const resources = path.join(root, "resources");
    mkdirSync(resources);
    writeFileSync(path.join(resources, "coaching-packs"), "a file");
    mkdirSync(path.join(cwd, "resources", "coaching-packs"), {
      recursive: true,
    });
    Reflect.set(process, "resourcesPath", resources);

    assert.equal(
      resolveBundledCoachingPacksDir(),
      path.join(cwd, "resources", "coaching-packs")
    );
  });

  test("finds the monorepo-root dev layout when resourcesPath is unset", () => {
    const devDir = path.join(
      cwd,
      "apps",
      "desktop",
      "resources",
      "coaching-packs"
    );
    mkdirSync(devDir, { recursive: true });

    assert.equal(resolveBundledCoachingPacksDir(), devDir);
  });

  test("returns null when no candidate exists", () => {
    assert.equal(resolveBundledCoachingPacksDir(), null);
  });
});
