/**
 * ISS-5303 — `packaging-workspace-deps.mjs`, the spec-parsing half of Desktop
 * packaging.
 *
 * `stage-packaging-app.mjs` rewrites every `workspace:`/`link:` dependency in
 * the staged `package.json` into something installable from a tarball. To do
 * that it has to answer one deceptively subtle question per dependency: which
 * package does this spec actually install? A `workspace:` range installs the
 * key; an ALIASED `workspace:<name>@<range>` installs a different package under
 * that key. Get it backwards and the stager either packs the wrong member or
 * leaves a `workspace:` spec in a published tarball, where it resolves against
 * a registry that has never heard of `@repo/*` — a packaged app that fails at
 * require time, not at build time.
 *
 * These tests drive all four exports: the runtime-closure SSOT, both spec
 * parsers, and the staged-directory resolver.
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DESKTOP_RUNTIME_CLOSURE,
  isWorkspaceProtocolSpec,
  resolveStagedPackageRuntimeFile,
  resolveWorkspaceDependencyTarget,
} from "../scripts/packaging-workspace-deps.mjs";

const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".."
);

const createdStageDirs: string[] = [];

/**
 * Build a staged app directory containing one resolvable package, the shape
 * `stage-packaging-app.mjs` hands to `resolveStagedPackageRuntimeFile`.
 */
function makeStagedApp(packageName: string, relativeFile: string): string {
  const stageAppDir = realpathSync(
    mkdtempSync(join(tmpdir(), "packaging-workspace-deps-"))
  );
  createdStageDirs.push(stageAppDir);

  writeFileSync(
    join(stageAppDir, "package.json"),
    JSON.stringify({ name: "staged-desktop", version: "0.0.0" })
  );

  const packageDir = join(
    stageAppDir,
    "node_modules",
    ...packageName.split("/")
  );
  const runtimeFile = join(packageDir, ...relativeFile.split("/"));
  mkdirSync(dirname(runtimeFile), { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: packageName, version: "0.0.0", main: relativeFile })
  );
  writeFileSync(
    runtimeFile,
    `export const stageAppDir = ${JSON.stringify(stageAppDir)};\n`
  );

  return stageAppDir;
}

afterEach(() => {
  while (createdStageDirs.length > 0) {
    const dir = createdStageDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("ISS-5303: the Desktop runtime closure SSOT", () => {
  test("names at least one member, so every consumer loop has something to do", () => {
    // `stage-packaging-app.mjs` builds its packed-member Map from this list. An
    // empty closure would make that Map empty and every downstream membership
    // check vacuously false — the stager would pack nothing and still succeed.
    assert.ok(DESKTOP_RUNTIME_CLOSURE.length > 0);
  });

  test("each entry's packageDir really holds a package of that packageName", () => {
    // The two fields are a claim about the tree: `packageDir` is joined onto
    // `packages/` to find the source to pack, and `packageName` is matched
    // against the staged dependency keys. A rename that moved one without the
    // other would pack the wrong directory, or nothing at all.
    for (const member of DESKTOP_RUNTIME_CLOSURE) {
      const manifestPath = join(
        REPO_ROOT,
        "packages",
        member.packageDir,
        "package.json"
      );
      const manifest: { name?: string } = JSON.parse(
        readFileSync(manifestPath, "utf8")
      );

      assert.equal(
        manifest.name,
        member.packageName,
        `packages/${member.packageDir} does not publish ${member.packageName}`
      );
    }
  });
});

describe("ISS-5303: resolveWorkspaceDependencyTarget", () => {
  test("a link: spec installs under the dependency key", () => {
    assert.equal(
      resolveWorkspaceDependencyTarget("@repo/api", "link:../../packages/api"),
      "@repo/api"
    );
  });

  test("a `workspace:*` range installs under the dependency key", () => {
    assert.equal(
      resolveWorkspaceDependencyTarget("@repo/lib", "workspace:*"),
      "@repo/lib"
    );
  });

  test("a caret range installs under the dependency key", () => {
    assert.equal(
      resolveWorkspaceDependencyTarget("@repo/lib", "workspace:^1.2.3"),
      "@repo/lib"
    );
  });

  test("a tilde range installs under the dependency key", () => {
    assert.equal(
      resolveWorkspaceDependencyTarget("@repo/lib", "workspace:~1.2.3"),
      "@repo/lib"
    );
  });

  test("a bare version range installs under the dependency key", () => {
    assert.equal(
      resolveWorkspaceDependencyTarget("@repo/lib", "workspace:1.2.3"),
      "@repo/lib"
    );
  });

  test("an empty range installs under the dependency key", () => {
    // `"workspace:"` leaves nothing after the protocol. It must take the
    // plain-range path: falling through to the alias branch would run
    // `lastIndexOf("@")` on `""` and hand the stager an empty package name.
    assert.equal(
      resolveWorkspaceDependencyTarget("@repo/lib", "workspace:"),
      "@repo/lib"
    );
  });

  test("a scoped alias resolves to the aliased target, not the key", () => {
    // The case the whole helper exists for. Returning the key here would send
    // the stager looking for a packed member named `shared`, which does not
    // exist, and the real package would never be packed.
    assert.equal(
      resolveWorkspaceDependencyTarget(
        "shared",
        "workspace:@closedloop-ai/shared-platform@*"
      ),
      "@repo/shared-platform"
    );
  });

  test("a scoped alias under its own name still resolves to the package name", () => {
    assert.equal(
      resolveWorkspaceDependencyTarget(
        "@repo/shared-platform",
        "workspace:@closedloop-ai/shared-platform@^1.0.0"
      ),
      "@repo/shared-platform"
    );
  });

  test("an unscoped alias resolves to the aliased target", () => {
    assert.equal(
      resolveWorkspaceDependencyTarget("alias", "workspace:real-name@^2.0.0"),
      "real-name"
    );
  });

  test("a scoped alias with no version keeps its leading @", () => {
    // `@repo/thing` has exactly one `@`, at index 0. Slicing at it would yield
    // the empty string, so the helper only treats an `@` past index 0 as the
    // version separator. This is the case that proves that guard is load-bearing.
    assert.equal(
      resolveWorkspaceDependencyTarget("alias", "workspace:@repo/thing"),
      "@repo/thing"
    );
  });
});

describe("ISS-5303: isWorkspaceProtocolSpec", () => {
  test("accepts a workspace: spec", () => {
    assert.equal(isWorkspaceProtocolSpec("workspace:*"), true);
  });

  test("accepts a link: spec", () => {
    assert.equal(isWorkspaceProtocolSpec("link:../../packages/api"), true);
  });

  test("rejects a plain registry range", () => {
    // The consequence of a false positive: the stager would try to rewrite a
    // dependency that pnpm can already fetch from the registry.
    assert.equal(isWorkspaceProtocolSpec("^1.2.3"), false);
  });

  test("rejects a prefix that merely starts with the protocol word", () => {
    assert.equal(isWorkspaceProtocolSpec("workspaces:*"), false);
  });

  test("rejects a non-string spec", () => {
    // package.json is untrusted JSON at this boundary — a dependency value can
    // be any JSON type, and `.startsWith` on a non-string would throw mid-stage.
    assert.equal(isWorkspaceProtocolSpec(undefined), false);
    assert.equal(isWorkspaceProtocolSpec(null), false);
    assert.equal(isWorkspaceProtocolSpec(42), false);
    assert.equal(isWorkspaceProtocolSpec({ spec: "workspace:*" }), false);
  });
});

describe("ISS-5303: resolveStagedPackageRuntimeFile", () => {
  test("resolves a runtime file out of the staged node_modules", () => {
    const stageAppDir = makeStagedApp(
      "staged-runtime-fixture",
      "dist/index.js"
    );

    assert.equal(
      resolveStagedPackageRuntimeFile(
        stageAppDir,
        "staged-runtime-fixture",
        "dist/index.js"
      ),
      join(
        stageAppDir,
        "node_modules",
        "staged-runtime-fixture",
        "dist",
        "index.js"
      )
    );
  });

  test("resolves a scoped package at a nested runtime path", () => {
    const stageAppDir = makeStagedApp(
      "@iss5303/staged-runtime-fixture",
      "dist/main/index.js"
    );

    assert.equal(
      resolveStagedPackageRuntimeFile(
        stageAppDir,
        "@iss5303/staged-runtime-fixture",
        "dist/main/index.js"
      ),
      join(
        stageAppDir,
        "node_modules",
        "@iss5303",
        "staged-runtime-fixture",
        "dist",
        "main",
        "index.js"
      )
    );
  });

  test("resolves relative to the stage dir it was given, not the running process", () => {
    // The `createRequire(join(stageAppDir, "package.json"))` seam is the whole
    // point: the verifier must inspect the file that was STAGED, not a copy the
    // build machine happens to have installed. Two stages carrying the same
    // package name must resolve to their own copies.
    const firstStage = makeStagedApp("staged-runtime-fixture", "dist/index.js");
    const secondStage = makeStagedApp(
      "staged-runtime-fixture",
      "dist/index.js"
    );

    const firstResolved = resolveStagedPackageRuntimeFile(
      firstStage,
      "staged-runtime-fixture",
      "dist/index.js"
    );
    const secondResolved = resolveStagedPackageRuntimeFile(
      secondStage,
      "staged-runtime-fixture",
      "dist/index.js"
    );

    assert.notEqual(firstResolved, secondResolved);
    assert.ok(firstResolved.startsWith(firstStage));
    assert.ok(secondResolved.startsWith(secondStage));
  });

  test("throws when the staged closure is missing the package", () => {
    // Fail loud. A silent miss here means electron-builder packages an asar
    // whose runtime import has nothing to resolve to at launch.
    const stageAppDir = makeStagedApp(
      "staged-runtime-fixture",
      "dist/index.js"
    );

    assert.throws(
      () =>
        resolveStagedPackageRuntimeFile(
          stageAppDir,
          "staged-runtime-absent",
          "dist/index.js"
        ),
      { code: "MODULE_NOT_FOUND" }
    );
  });
});
