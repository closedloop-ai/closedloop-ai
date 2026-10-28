/**
 * @file agent-coaching-packs-seed-coverage.test.ts
 * @description ISS-10308: behavior pins for `seedBundledCoachingPacks`, which
 * no other suite calls: the missing-root early return, the per-entry skips,
 * the version-refresh predicate, and the first-seed activation.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { beforeEach, describe, test } from "vitest";
import {
  getActiveCoachingPack,
  listInstalledCoachingPacks,
  readCoachingPackManifest,
  seedBundledCoachingPacks,
  setActiveCoachingPack,
} from "../src/main/agent-monitor/agent-coaching-packs.js";
import { createTempDirManager } from "./helpers/temp-dir.js";

const { makeTempDir } = createTempDirManager("coaching-seed-cov-");

let root: string;
let packsDir: string;
let bundledDir: string;

beforeEach(() => {
  root = makeTempDir();
  packsDir = path.join(root, "store");
  bundledDir = path.join(root, "bundled");
  mkdirSync(bundledDir);
});

function writePack(dir: string, manifest: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "coaching-pack.json"), JSON.stringify(manifest));
  return dir;
}

function activePointerPath(): string {
  return path.join(packsDir, "active.json");
}

function storedSignals(slug: string): string[] | undefined {
  return readCoachingPackManifest(path.join(packsDir, slug))?.signals;
}

describe("seedBundledCoachingPacks early return", () => {
  test("a null bundled root does nothing, not even create the store", () => {
    seedBundledCoachingPacks(packsDir, null);

    assert.equal(existsSync(packsDir), false);
  });

  test("a bundled root that does not exist does nothing", () => {
    seedBundledCoachingPacks(packsDir, path.join(root, "absent"));

    assert.equal(existsSync(packsDir), false);
  });

  test("an existing root with no packs creates the store but writes no pointer", () => {
    seedBundledCoachingPacks(packsDir, bundledDir);

    assert.deepEqual(readdirSync(packsDir), []);
  });
});

describe("seedBundledCoachingPacks first seed", () => {
  test("copies valid packs, skips the rest, and activates the first by name", () => {
    writeFileSync(path.join(bundledDir, "README.md"), "not a pack");
    mkdirSync(path.join(bundledDir, "no-manifest"));
    writePack(path.join(bundledDir, "reserved"), {
      name: "active",
      signals: ["s"],
    });
    writePack(path.join(bundledDir, "b"), {
      name: "beta-pack",
      signals: ["b"],
    });
    writePack(path.join(bundledDir, "a"), {
      name: "alpha-pack",
      signals: ["a"],
    });

    seedBundledCoachingPacks(packsDir, bundledDir);

    assert.deepEqual(readdirSync(packsDir).sort(), [
      "active.json",
      "alpha-pack",
      "beta-pack",
    ]);
    assert.equal(getActiveCoachingPack(packsDir)?.name, "alpha-pack");
  });

  test("an existing pointer file, even a cleared one, is left untouched", () => {
    setActiveCoachingPack(packsDir, null);
    const before = readFileSync(activePointerPath(), "utf8");
    writePack(path.join(bundledDir, "a"), {
      name: "alpha-pack",
      signals: ["a"],
    });

    seedBundledCoachingPacks(packsDir, bundledDir);

    assert.equal(readFileSync(activePointerPath(), "utf8"), before);
    assert.deepEqual(storedSignals("alpha-pack"), ["a"]);
    assert.equal(getActiveCoachingPack(packsDir), null);
  });

  // Pins current behavior; looks odd because only the first pack by name is
  // considered: when its name cannot slugify, no pointer is written even
  // though a valid pack sorts right after it.
  test("writes no pointer when the first-sorted pack name cannot slugify", () => {
    writePack(path.join(packsDir, "odd"), { name: "active", signals: ["x"] });
    writePack(path.join(bundledDir, "z"), { name: "zeta", signals: ["z"] });

    seedBundledCoachingPacks(packsDir, bundledDir);

    assert.deepEqual(
      listInstalledCoachingPacks(packsDir).map((pack) => pack.name),
      ["active", "zeta"]
    );
    assert.equal(existsSync(activePointerPath()), false);
  });
});

describe("seedBundledCoachingPacks refresh of an installed copy", () => {
  beforeEach(() => {
    writePack(path.join(packsDir, "token-coach"), {
      name: "token-coach",
      version: "1.0.0",
      signals: ["installed"],
    });
    writePack(path.join(packsDir, "user-pack"), {
      name: "user-pack",
      signals: ["u"],
    });
    setActiveCoachingPack(packsDir, "user-pack");
  });

  test("a changed bundled version overwrites the copy and keeps the pointer", () => {
    writePack(path.join(bundledDir, "tc"), {
      name: "token-coach",
      version: "2.0.0",
      signals: ["bundled"],
    });

    seedBundledCoachingPacks(packsDir, bundledDir);

    assert.deepEqual(storedSignals("token-coach"), ["bundled"]);
    assert.equal(getActiveCoachingPack(packsDir)?.name, "user-pack");
  });

  test("the same bundled version leaves the copy alone", () => {
    writePack(path.join(bundledDir, "tc"), {
      name: "token-coach",
      version: "1.0.0",
      signals: ["bundled"],
    });

    seedBundledCoachingPacks(packsDir, bundledDir);

    assert.deepEqual(storedSignals("token-coach"), ["installed"]);
  });

  test("a bundled pack with no version leaves the copy alone", () => {
    writePack(path.join(bundledDir, "tc"), {
      name: "token-coach",
      signals: ["bundled"],
    });

    seedBundledCoachingPacks(packsDir, bundledDir);

    assert.deepEqual(storedSignals("token-coach"), ["installed"]);
  });
});

describe("seedBundledCoachingPacks broken managed copy", () => {
  // Pins current behavior; looks odd because a managed slug directory with no
  // valid manifest is never repaired: it exists, and a broken copy has no
  // version for the bundled one to differ from.
  test("an existing slug directory with no manifest is not re-copied", () => {
    mkdirSync(path.join(packsDir, "token-coach"), { recursive: true });
    writePack(path.join(bundledDir, "tc"), {
      name: "token-coach",
      version: "1.0.0",
      signals: ["bundled"],
    });

    seedBundledCoachingPacks(packsDir, bundledDir);

    assert.deepEqual(readdirSync(path.join(packsDir, "token-coach")), []);
    assert.equal(existsSync(activePointerPath()), false);
  });
});
