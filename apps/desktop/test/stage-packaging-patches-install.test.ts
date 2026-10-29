import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import ts from "typescript6";
import { it } from "vitest";
import { stringify } from "yaml";
import {
  prepareStagedRuntimePatches,
  verifyStagedRuntimePatches,
} from "../scripts/stage-packaging-patches.mjs";
import {
  namedImportsFrom,
  parseDesktopScript,
} from "./helpers/entrypoint-wiring.js";
import { forEachNode } from "./helpers/ts-ast.js";

const execute = promisify(execFile);
const missingRuntimeError = /ENOENT/;
const PATCH = `diff --git a/index.cjs b/index.cjs
--- a/index.cjs
+++ b/index.cjs
@@ -1 +1 @@
-module.exports = "unpatched";
+module.exports = "patched";
diff --git a/index.mjs b/index.mjs
--- a/index.mjs
+++ b/index.mjs
@@ -1 +1 @@
-export default "unpatched";
+export default "patched";
`;

it("the production staging caller resolves before preserving patches, then installs and verifies", () => {
  const source = parseDesktopScript("stage-packaging-app.mjs");
  const calls: { name: string; position: number; node: ts.CallExpression }[] =
    [];
  forEachNode(source, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      calls.push({ name: node.expression.text, position: node.pos, node });
    }
  });
  const prepare = calls.filter(
    (call) => call.name === "prepareStagedRuntimePatches"
  );
  const verify = calls.filter(
    (call) => call.name === "verifyStagedRuntimePatches"
  );
  assert.equal(prepare.length, 1);
  assert.equal(verify.length, 1);
  assert.deepEqual(namedImportsFrom(source, "./stage-packaging-patches.mjs"), [
    "prepareStagedRuntimePatches",
    "verifyStagedRuntimePatches",
  ]);
  assert.deepEqual(prepare[0].node.arguments.map(identifier), [
    "repoRoot",
    "stageAppDir",
  ]);
  assert.deepEqual(verify[0].node.arguments.map(identifier), [
    "stageAppDir",
    "preparedRuntimePatches",
  ]);
  const installs = calls
    .filter((call) => call.name === "spawnSync")
    .flatMap((call) => {
      const [command, argv] = call.node.arguments;
      if (
        !ts.isStringLiteral(command) ||
        command.text !== "pnpm" ||
        !ts.isArrayLiteralExpression(argv)
      ) {
        return [];
      }
      const values = argv.elements.map((value) =>
        ts.isStringLiteral(value) ? value.text : ""
      );
      return values[0] === "install"
        ? [{ position: call.position, values }]
        : [];
    });
  assert.equal(installs.length, 2);
  const resolution = installs.filter((call) =>
    call.values.includes("--lockfile-only")
  );
  const actual = installs.filter(
    (call) => !call.values.includes("--lockfile-only")
  );
  assert.equal(resolution.length, 1);
  assert.equal(actual.length, 1);
  for (const flag of [
    "--prod",
    "--ignore-scripts",
    "--lockfile-only",
    "--no-frozen-lockfile",
  ]) {
    assert(resolution[0].values.includes(flag));
  }
  assert(actual[0].values.includes("--prod"));
  assert(actual[0].values.includes("--no-frozen-lockfile"));
  assert(!actual[0].values.includes("--ignore-scripts"));
  assert(
    resolution[0].position < prepare[0].position &&
      prepare[0].position < actual[0].position &&
      actual[0].position < verify[0].position
  );
});

it("a real offline staged install patches direct and transitive CJS/ESM runtime bytes through the shared caller", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stage-patches-install-"));
  const repo = path.join(root, "source"),
    stage = path.join(root, "stage");
  try {
    await mkdir(path.join(repo, "patches"), { recursive: true });
    await mkdir(stage);
    const leaf = await pack(root, "@fixture/leaf", "1.2.3", "leaf");
    const bridge = await pack(root, "fixture-bridge", "1.0.0", "bridge", {
      "@fixture/leaf": `file:${leaf}`,
    });
    await writeFile(path.join(repo, "patches/leaf.patch"), PATCH);
    await writeFile(path.join(repo, "patches/bridge.patch"), PATCH);
    await writeFile(
      path.join(repo, "pnpm-workspace.yaml"),
      stringify({
        patchedDependencies: {
          "@fixture/leaf@1.2.3": "patches/leaf.patch",
          "fixture-bridge@1.0.0": "patches/bridge.patch",
          "dev-only@9.0.0": "patches/missing-dev.patch",
        },
      })
    );
    await writeFile(
      path.join(stage, "package.json"),
      JSON.stringify({
        name: "fixture-stage",
        version: "1.0.0",
        private: true,
        type: "module",
        dependencies: { "fixture-bridge": `file:${bridge}` },
      })
    );
    await writeFile(
      path.join(stage, "pnpm-workspace.yaml"),
      "nodeLinker: hoisted\nallowBuilds:\n  protobufjs: true\n"
    );
    await pnpm(stage, [
      "install",
      "--prod",
      "--lockfile-only",
      "--ignore-scripts",
      "--offline",
      "--no-frozen-lockfile",
    ]);
    await assert.rejects(
      readFile(path.join(stage, "node_modules/@fixture/leaf/index.cjs")),
      missingRuntimeError
    );
    const prepared = await prepareStagedRuntimePatches(repo, stage);
    assert.equal(prepared.patches.length, 2);
    await pnpm(stage, [
      "install",
      "--prod",
      "--offline",
      "--no-frozen-lockfile",
    ]);
    await verifyStagedRuntimePatches(stage, prepared);
    const probe =
      "const leaf=require('@fixture/leaf'),bridge=require('fixture-bridge');Promise.all([import('@fixture/leaf'),import('fixture-bridge')]).then(([l,b])=>process.stdout.write(JSON.stringify({leaf,bridge,leafEsm:l.default,bridgeEsm:b.default})));";
    const { stdout } = await execute(process.execPath, ["-e", probe], {
      cwd: stage,
      timeout: 10_000,
    });
    assert.deepEqual(JSON.parse(stdout), {
      leaf: "patched",
      bridge: "patched",
      leafEsm: "patched",
      bridgeEsm: "patched",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

/** Local tarballs ensure the regression does not depend on registry/network state. */
async function pack(
  root: string,
  name: string,
  version: string,
  directory: string,
  dependencies?: Record<string, string>
) {
  const source = path.join(root, directory);
  await mkdir(source);
  await writeFile(
    path.join(source, "package.json"),
    JSON.stringify({
      name,
      version,
      type: "module",
      main: "index.cjs",
      exports: { require: "./index.cjs", import: "./index.mjs" },
      ...(dependencies ? { dependencies } : {}),
    })
  );
  await writeFile(
    path.join(source, "index.cjs"),
    'module.exports = "unpatched";\n'
  );
  await writeFile(
    path.join(source, "index.mjs"),
    'export default "unpatched";\n'
  );
  const tarball = path.join(root, `${directory}.tgz`);
  const packageDir = path.join(root, `${directory}-archive`);
  await mkdir(packageDir);
  await cp(source, path.join(packageDir, "package"), { recursive: true });
  await execute("tar", ["-czf", tarball, "-C", packageDir, "package"], {
    timeout: 10_000,
  });
  return tarball;
}

async function pnpm(cwd: string, args: string[]) {
  await execute("pnpm", args, {
    cwd,
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function identifier(node: ts.Node): string | null {
  return ts.isIdentifier(node) ? node.text : null;
}
