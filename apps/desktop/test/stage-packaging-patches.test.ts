import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  prepareStagedRuntimePatches,
  selectStagedRuntimePatches,
  verifyStagedRuntimePatches,
} from "../scripts/stage-packaging-patches.mjs";

const unresolvedError = /Unresolved/;
const metadataError = /metadata/;
const selectorError = /Unsupported canonical patch selector/;
const assetError = /asset/;
const hashError = /source hash/;
const resolutionError = /resolution changed/;
const collisionError = /collides/;
const regularFileError = /regular file/;
const rootImporterError = /no root importer/;
const exactNameError = /no exact resolved name\/version/;
const freshWorkspaceError = /requires a fresh workspace/;
const registrationsError = /registrations changed/;
const missingFromGraphError = /missing from the installed dependency graph/;

const baseLock = () => ({
  importers: {
    ".": { dependencies: { bridge: { version: "file:bridge.tgz" } } },
  },
  packages: {
    "bridge@file:bridge.tgz": { version: "1.0.0" },
    "@fixture/leaf@1.2.3": { resolution: { integrity: "sha512-source" } },
    "dev-only@9.0.0": {},
  },
  snapshots: {
    "bridge@file:bridge.tgz": { dependencies: { "@fixture/leaf": "1.2.3" } },
    "@fixture/leaf@1.2.3": {},
    "dev-only@9.0.0": {},
  },
});
const workspace = {
  patchedDependencies: {
    "@fixture/leaf@1.2.3": "patches/leaf.patch",
    "dev-only@9.0.0": "patches/dev.patch",
  },
};

describe("staged canonical runtime patches", () => {
  it("selects a transitive exact version and excludes unreachable dev packages", () => {
    const selected = selectStagedRuntimePatches(workspace, baseLock());
    assert.deepEqual(selected.patches, [
      { selector: "@fixture/leaf@1.2.3", path: "patches/leaf.patch" },
    ]);
    assert.deepEqual(selected.graph.packages.map((pkg) => pkg.name).sort(), [
      "@fixture/leaf",
      "bridge",
    ]);
  });

  it("uses actual staged file-tarball metadata rather than source-installed versions", () => {
    const lock = {
      importers: {
        ".": { dependencies: { leaf: { version: "file:leaf.tgz" } } },
      },
      packages: { "leaf@file:leaf.tgz": { version: "2.0.0" } },
      snapshots: { "leaf@file:leaf.tgz": {} },
    };
    assert.deepEqual(
      selectStagedRuntimePatches(
        {
          patchedDependencies: {
            "leaf@1.0.0": "patches/old.patch",
            "leaf@2.0.0": "patches/current.patch",
          },
        },
        lock
      ).patches,
      [{ selector: "leaf@2.0.0", path: "patches/current.patch" }]
    );
  });

  it("follows optional and alias edges with multiple versions and peer suffixes", () => {
    const lock = {
      importers: {
        ".": {
          dependencies: { alias: { version: "leaf@1.0.0(peer@3.0.0)" } },
          optionalDependencies: { leaf: { version: "2.0.0" } },
        },
      },
      packages: { "leaf@1.0.0": {}, "leaf@2.0.0": {}, "peer@3.0.0": {} },
      snapshots: {
        "leaf@1.0.0(peer@3.0.0)": { dependencies: { peer: "3.0.0" } },
        "leaf@2.0.0": {},
        "peer@3.0.0": {},
      },
    };
    assert.equal(
      selectStagedRuntimePatches(
        {
          patchedDependencies: {
            "leaf@1.0.0": "patches/one.patch",
            "leaf@2.0.0": "patches/two.patch",
          },
        },
        lock
      ).patches.length,
      2
    );
  });

  it("fails for malformed or unresolved lockfile inputs instead of dropping patches", () => {
    assert.throws(() => selectStagedRuntimePatches(workspace, {}));
    assert.throws(
      () =>
        selectStagedRuntimePatches(workspace, { ...baseLock(), snapshots: {} }),
      unresolvedError
    );
    assert.throws(
      () =>
        selectStagedRuntimePatches(workspace, { ...baseLock(), packages: {} }),
      metadataError
    );
    assert.throws(
      () =>
        selectStagedRuntimePatches(
          { patchedDependencies: { "leaf@^1": "patches/range.patch" } },
          baseLock()
        ),
      selectorError
    );
  });

  it("copies exact assets while retaining hoisting and build policy", async () => {
    await fixture(async ({ repo, stage }) => {
      const prepared = await prepareStagedRuntimePatches(repo, stage);
      const config: unknown = parse(
        await readFile(path.join(stage, "pnpm-workspace.yaml"), "utf8")
      );
      assert.deepEqual(config, {
        nodeLinker: "hoisted",
        allowBuilds: { protobufjs: true },
        patchedDependencies: { "@fixture/leaf@1.2.3": "patches/leaf.patch" },
      });
      assert.equal(
        await readFile(path.join(stage, "patches/leaf.patch"), "utf8"),
        "exact fixture bytes\n"
      );
      assert.equal(prepared.patches.length, 1);
    });
  });

  it("rejects escaping, absolute, missing and escaping-symlink assets", async () => {
    for (const patchPath of [
      "../outside.patch",
      path.resolve("synthetic-absolute.patch"),
      "patches/missing.patch",
      "patches/escape.patch",
    ]) {
      await fixture(async ({ root, repo, stage }) => {
        await writeFile(path.join(root, "outside.patch"), "outside");
        await symlink(
          path.join(root, "outside.patch"),
          path.join(repo, "patches/escape.patch")
        );
        await writeFile(
          path.join(repo, "pnpm-workspace.yaml"),
          stringify({
            patchedDependencies: { "@fixture/leaf@1.2.3": patchPath },
          })
        );
        await assert.rejects(prepareStagedRuntimePatches(repo, stage));
      });
    }
  });

  it("verifies patch identity without treating legitimate patch-hash suffixes as drift", async () => {
    await fixture(async ({ repo, stage }) => {
      const prepared = await prepareStagedRuntimePatches(repo, stage);
      const hash = prepared.patches[0].hash;
      await writeFile(
        path.join(stage, "pnpm-lock.yaml"),
        stringify(patchedLock(hash))
      );
      await verifyStagedRuntimePatches(stage, prepared);
      await writeFile(path.join(stage, "patches/leaf.patch"), "mutated");
      await assert.rejects(
        verifyStagedRuntimePatches(stage, prepared),
        assetError
      );
    });
  });

  it("refuses lost edges and missing applied hashes after install", async () => {
    await fixture(async ({ repo, stage }) => {
      const prepared = await prepareStagedRuntimePatches(repo, stage);
      await assert.rejects(
        verifyStagedRuntimePatches(stage, prepared),
        hashError
      );
      const lock = baseLock();
      lock.snapshots["bridge@file:bridge.tgz"].dependencies["@fixture/leaf"] =
        "dev-only@9.0.0";
      await writeFile(path.join(stage, "pnpm-lock.yaml"), stringify(lock));
      await assert.rejects(
        verifyStagedRuntimePatches(stage, prepared),
        resolutionError
      );
    });
  });

  it("refuses a same-version content resolution change after install", async () => {
    await fixture(async ({ repo, stage }) => {
      const prepared = await prepareStagedRuntimePatches(repo, stage);
      const lock = patchedLock(prepared.patches[0].hash);
      lock.packages["@fixture/leaf@1.2.3"].resolution.integrity =
        "sha512-other-content";
      await writeFile(path.join(stage, "pnpm-lock.yaml"), stringify(lock));
      await assert.rejects(
        verifyStagedRuntimePatches(stage, prepared),
        resolutionError
      );
    });
  });

  it("rejects non-file assets and conflicting stage bytes, accepting identical deduplication", async () => {
    await fixture(async ({ repo, stage }) => {
      await mkdir(path.join(stage, "patches"));
      await writeFile(path.join(stage, "patches/leaf.patch"), "conflicting");
      await assert.rejects(
        prepareStagedRuntimePatches(repo, stage),
        collisionError
      );
      await writeFile(
        path.join(stage, "patches/leaf.patch"),
        "exact fixture bytes\n"
      );
      await prepareStagedRuntimePatches(repo, stage);
    });
    await fixture(async ({ repo, stage }) => {
      await rm(path.join(repo, "patches/leaf.patch"));
      await mkdir(path.join(repo, "patches/leaf.patch"));
      await assert.rejects(
        prepareStagedRuntimePatches(repo, stage),
        regularFileError
      );
    });
  });

  it("rejects target-parent symlinks before creating anything outside the stage", async () => {
    await fixture(async ({ root, repo, stage }) => {
      const outside = path.join(root, "outside");
      await mkdir(outside);
      await symlink(outside, path.join(stage, "patches"));
      await mkdir(path.join(repo, "patches/new-dir"));
      await writeFile(
        path.join(repo, "patches/new-dir/leaf.patch"),
        "exact fixture bytes\n"
      );
      await writeFile(
        path.join(repo, "pnpm-workspace.yaml"),
        stringify({
          patchedDependencies: {
            "@fixture/leaf@1.2.3": "patches/new-dir/leaf.patch",
          },
        })
      );
      await assert.rejects(prepareStagedRuntimePatches(repo, stage));
      await assert.rejects(readFile(path.join(outside, "new-dir/leaf.patch")));
      await assert.rejects(stat(path.join(outside, "new-dir")));
    });
  });

  it("selects nothing when the workspace registers no patches", () => {
    const selected = selectStagedRuntimePatches({}, baseLock());
    assert.deepEqual(selected.patches, []);
    assert.equal(selected.graph.packages.length, 2);
  });

  it("rejects a selector that has no package name before its version", () => {
    assert.throws(
      () =>
        selectStagedRuntimePatches(
          { patchedDependencies: { "@1.2.3": "patches/nameless.patch" } },
          baseLock()
        ),
      selectorError
    );
  });

  it("refuses a lockfile without a root importer", () => {
    assert.throws(
      () =>
        selectStagedRuntimePatches(workspace, { ...baseLock(), importers: {} }),
      rootImporterError
    );
  });

  it("visits a package reached through two parents once", () => {
    const lock = {
      importers: {
        ".": { dependencies: { left: "1.0.0", right: "1.0.0" } },
      },
      packages: { "left@1.0.0": {}, "right@1.0.0": {}, "leaf@1.0.0": {} },
      snapshots: {
        "left@1.0.0": { dependencies: { leaf: "1.0.0" } },
        "right@1.0.0": { dependencies: { leaf: "1.0.0" } },
        "leaf@1.0.0": {},
      },
    };
    const names = selectStagedRuntimePatches({}, lock).graph.packages.map(
      (pkg) => pkg.name
    );
    assert.deepEqual(names.sort(), ["leaf", "left", "right"]);
  });

  it("refuses a package key that carries neither a name nor a version", () => {
    const lock = {
      importers: { ".": { dependencies: { bare: "bare-ref" } } },
      packages: { "bare-ref": {} },
      snapshots: { "bare-ref": {} },
    };
    assert.throws(() => selectStagedRuntimePatches({}, lock), exactNameError);
  });

  it("refuses a named package key whose version is not exact", () => {
    const lock = {
      importers: { ".": { dependencies: { leaf: "latest" } } },
      packages: { "leaf@latest": {} },
      snapshots: { "leaf@latest": {} },
    };
    assert.throws(() => selectStagedRuntimePatches({}, lock), exactNameError);
  });

  it("refuses a staging workspace that already registers patches", async () => {
    await fixture(async ({ repo, stage }) => {
      await writeFile(
        path.join(stage, "pnpm-workspace.yaml"),
        stringify({
          nodeLinker: "hoisted",
          allowBuilds: {},
          patchedDependencies: { "x@1.0.0": "patches/x.patch" },
        })
      );
      await assert.rejects(
        prepareStagedRuntimePatches(repo, stage),
        freshWorkspaceError
      );
    });
  });

  it("writes no registrations when no patch applies, and verifies that empty set", async () => {
    await fixture(async ({ repo, stage }) => {
      await writeFile(
        path.join(repo, "pnpm-workspace.yaml"),
        stringify({
          patchedDependencies: { "dev-only@9.0.0": "patches/dev.patch" },
        })
      );
      const prepared = await prepareStagedRuntimePatches(repo, stage);
      assert.deepEqual(prepared.patches, []);
      assert.deepEqual(
        parse(await readFile(path.join(stage, "pnpm-workspace.yaml"), "utf8")),
        { nodeLinker: "hoisted", allowBuilds: { protobufjs: true } }
      );
      await verifyStagedRuntimePatches(stage, prepared);
    });
  });

  it("stages a patch that sits at the repository root", async () => {
    await fixture(async ({ repo, stage }) => {
      await writeFile(path.join(repo, "leaf.patch"), "root bytes\n");
      await writeFile(
        path.join(repo, "pnpm-workspace.yaml"),
        stringify({
          patchedDependencies: { "@fixture/leaf@1.2.3": "leaf.patch" },
        })
      );
      const prepared = await prepareStagedRuntimePatches(repo, stage);
      assert.deepEqual(
        prepared.patches.map((patch) => patch.path),
        ["leaf.patch"]
      );
      assert.equal(
        await readFile(path.join(stage, "leaf.patch"), "utf8"),
        "root bytes\n"
      );
    });
  });

  it("refuses registrations edited during install", async () => {
    await fixture(async ({ repo, stage }) => {
      const prepared = await prepareStagedRuntimePatches(repo, stage);
      await writeFile(
        path.join(stage, "pnpm-lock.yaml"),
        stringify(patchedLock(prepared.patches[0].hash))
      );
      await writeFile(
        path.join(stage, "pnpm-workspace.yaml"),
        stringify({
          nodeLinker: "hoisted",
          allowBuilds: { protobufjs: true },
          patchedDependencies: { "@fixture/leaf@1.2.3": "patches/other.patch" },
        })
      );
      await assert.rejects(
        verifyStagedRuntimePatches(stage, prepared),
        registrationsError
      );
    });
  });

  it("refuses a registered hash that no installed snapshot carries", async () => {
    await fixture(async ({ repo, stage }) => {
      const prepared = await prepareStagedRuntimePatches(repo, stage);
      await writeFile(
        path.join(stage, "pnpm-lock.yaml"),
        stringify({
          ...baseLock(),
          patchedDependencies: {
            "@fixture/leaf@1.2.3": prepared.patches[0].hash,
          },
        })
      );
      await assert.rejects(
        verifyStagedRuntimePatches(stage, prepared),
        missingFromGraphError
      );
    });
  });

  it("finds the patch hash in any peer-suffix position, and refuses a peer suffix without it", async () => {
    await fixture(async ({ repo, stage }) => {
      await writeFile(
        path.join(stage, "pnpm-lock.yaml"),
        stringify(peerLock("1.2.3(peer@1.0.0)"))
      );
      const prepared = await prepareStagedRuntimePatches(repo, stage);
      const hash = prepared.patches[0].hash;
      const writeFinalLock = (leafRef: string) =>
        writeFile(
          path.join(stage, "pnpm-lock.yaml"),
          stringify({
            ...peerLock(leafRef),
            patchedDependencies: { "@fixture/leaf@1.2.3": hash },
          })
        );
      await writeFinalLock(`1.2.3(patch_hash=${hash})(peer@1.0.0)`);
      await verifyStagedRuntimePatches(stage, prepared);
      await writeFinalLock(`1.2.3(peer@1.0.0)(patch_hash=${hash})`);
      await verifyStagedRuntimePatches(stage, prepared);
      await writeFinalLock("1.2.3(peer@1.0.0)");
      await assert.rejects(
        verifyStagedRuntimePatches(stage, prepared),
        missingFromGraphError
      );
    });
  });
});

function peerLock(leafRef: string) {
  return {
    importers: {
      ".": { dependencies: { bridge: { version: "file:bridge.tgz" } } },
    },
    packages: {
      "bridge@file:bridge.tgz": { version: "1.0.0" },
      "@fixture/leaf@1.2.3": {},
      "peer@1.0.0": {},
    },
    snapshots: {
      "bridge@file:bridge.tgz": { dependencies: { "@fixture/leaf": leafRef } },
      [`@fixture/leaf@${leafRef}`]: { dependencies: { peer: "1.0.0" } },
      "peer@1.0.0": {},
    },
  };
}

function patchedLock(hash: string) {
  const patched = `1.2.3(patch_hash=${hash})`;
  return {
    ...baseLock(),
    patchedDependencies: { "@fixture/leaf@1.2.3": hash },
    snapshots: {
      "bridge@file:bridge.tgz": { dependencies: { "@fixture/leaf": patched } },
      [`@fixture/leaf@${patched}`]: {},
      "dev-only@9.0.0": {},
    },
  };
}

/** Each case owns a fresh synthetic source/staging tree and unconditional cleanup. */
async function fixture(
  run: (paths: { root: string; repo: string; stage: string }) => Promise<void>
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "stage-patches-unit-"));
  const repo = path.join(root, "repo"),
    stage = path.join(root, "stage");
  try {
    await mkdir(path.join(repo, "patches"), { recursive: true });
    await mkdir(stage);
    await writeFile(
      path.join(repo, "pnpm-workspace.yaml"),
      stringify(workspace)
    );
    await writeFile(
      path.join(repo, "patches/leaf.patch"),
      "exact fixture bytes\n"
    );
    await writeFile(
      path.join(stage, "pnpm-workspace.yaml"),
      "nodeLinker: hoisted\nallowBuilds:\n  protobufjs: true\n"
    );
    await writeFile(path.join(stage, "pnpm-lock.yaml"), stringify(baseLock()));
    await run({ root, repo, stage });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
