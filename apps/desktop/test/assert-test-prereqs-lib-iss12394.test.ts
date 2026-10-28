/**
 * ISS-12394 — `dependencyBuildPrerequisites`' derivation on a synthetic
 * workspace: which declared dependencies earn a build-output sentinel, and how
 * `exports` / `main` / `module` / `types` targets are read.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  allPrerequisites,
  dependencyBuildPrerequisites,
  GENERATED_PREREQUISITES,
  missingPrerequisites,
  prerequisiteProblem,
} from "../scripts/assert-test-prereqs-lib.mjs";

const MISSING_COUNT_RE = /^\[assert-test-prereqs\] (\d+) module\(s\)/;

let root = "";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "prereqs-iss12394-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeRaw(directory: string, contents: string): void {
  const absolute = path.join(root, ...directory.split("/"));
  mkdirSync(absolute, { recursive: true });
  writeFileSync(path.join(absolute, "package.json"), contents, "utf8");
}

function writeManifest(directory: string, manifest: unknown): void {
  writeRaw(directory, JSON.stringify(manifest));
}

describe("dependencyBuildPrerequisites", () => {
  it("returns nothing when the desktop manifest is missing", () => {
    expect(dependencyBuildPrerequisites(root)).toEqual([]);
  });

  it("derives sorted, de-duplicated build roots from every target shape", () => {
    writeManifest("apps/desktop", {
      name: "desktop",
      dependencies: {
        "@repo/zeta": "workspace:*",
        "@repo/source": "workspace:*",
        "@repo/unlisted": "workspace:*",
        lodash: "^4.0.0",
        "@repo/registry": "1.0.0",
      },
      devDependencies: { "@repo/alpha": "workspace:^" },
    });
    // Nested conditional exports with null and non-string leaves, plus a main
    // pointing at the same build root: one entry, not two.
    writeManifest("packages/zeta", {
      name: "@repo/zeta",
      exports: {
        ".": { import: "./dist/index.js", types: null, default: 5 },
        "./extra": ["./dist-esm/extra.js"],
      },
      main: "./dist/index.cjs",
    });
    writeManifest("packages/alpha", {
      name: "@repo/alpha",
      module: "./lib-dist/mod.js",
      types: "./src/index.ts",
    });
    writeManifest("packages/source", {
      name: "@repo/source",
      exports: { ".": "./src/index.ts" },
    });
    // A member with a build root, declared with a non-workspace range: skipped.
    writeManifest("packages/registry", {
      name: "@repo/registry",
      main: "./dist/x.js",
    });
    writeRaw("packages/broken", "{ not json");
    writeManifest("packages/nameless", { version: "1.0.0" });

    expect(dependencyBuildPrerequisites(root)).toEqual([
      {
        file: "packages/alpha/lib-dist",
        producedBy: "build:deps (turbo build --filter=@repo/alpha)",
      },
      {
        file: "packages/zeta/dist",
        producedBy: "build:deps (turbo build --filter=@repo/zeta)",
      },
      {
        file: "packages/zeta/dist-esm",
        producedBy: "build:deps (turbo build --filter=@repo/zeta)",
      },
    ]);
  });

  it("resolves a name to the first workspace root that declares it", () => {
    writeManifest("apps/desktop", {
      name: "desktop",
      dependencies: { "@repo/dup": "workspace:*" },
    });
    writeManifest("apps/dup", { name: "@repo/dup", main: "./dist/a.js" });
    writeManifest("packages/dup", { name: "@repo/dup", main: "./dist/b.js" });

    expect(dependencyBuildPrerequisites(root).map((p) => p.file)).toEqual([
      "apps/dup/dist",
    ]);
  });
});

describe("prerequisiteProblem over a dependency sentinel", () => {
  it("lists the generated modules then the missing build output", () => {
    writeManifest("apps/desktop", {
      name: "desktop",
      dependencies: { "@repo/built": "workspace:*" },
    });
    writeManifest("packages/built", {
      name: "@repo/built",
      main: "./dist/i.js",
    });
    const desktopDir = path.join(root, "apps", "desktop");

    const all = allPrerequisites(root);
    expect(all.slice(0, GENERATED_PREREQUISITES.length)).toEqual(
      GENERATED_PREREQUISITES
    );
    expect(all.at(-1)?.file).toBe("packages/built/dist");

    expect(missingPrerequisites(desktopDir)).toEqual(all);
    const problem = prerequisiteProblem(desktopDir) ?? "";
    expect(MISSING_COUNT_RE.exec(problem)?.[1]).toBe(String(all.length));
    expect(problem).toContain(
      "  - packages/built/dist  (build:deps (turbo build --filter=@repo/built))"
    );

    for (const prerequisite of all) {
      const absolute = path.join(root, ...prerequisite.file.split("/"));
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, "", "utf8");
    }
    expect(prerequisiteProblem(desktopDir)).toBeUndefined();
  });
});
