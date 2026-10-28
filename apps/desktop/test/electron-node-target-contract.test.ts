import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript6";
import { describe, test } from "vitest";
import { forEachNode, parseTypeScriptFile } from "./helpers/ts-ast.js";

// ISS-10357. The Node ABI the packaged main process compiles for used to be
// DERIVED: electron-vite read the installed Electron major and looked it up in
// its own table (which, for Electron 43, fell through to node22.20 because the
// table stops at 39). Plain Vite has no such table, so `ELECTRON_NODE_TARGET` is
// a hand-written constant — and "bump alongside the electron major" in its
// docstring is exactly the sentence that stops being true. Bumping the
// `electron` devDependency then fails here, rather than silently compiling the
// next major for the previous ABI.
//
// Read through the TypeScript AST rather than by importing the config, matching
// the sibling guards: importing executes the config body, which reads
// package.json and builds a whole config object this assertion does not need.

const CONFIG_PATH = "vite.main.config.ts";
const TARGET_CONST = "ELECTRON_NODE_TARGET";
const PACKAGE_MANIFEST = "package.json";
const LEADING_MAJOR = /(\d+)/;

/**
 * Electron major → the `build.target` for the Node it embeds. One row per
 * major this app has actually declared; an unlisted major is the failure, not a
 * default, because guessing one is how the ABI silently goes stale.
 */
const ELECTRON_MAJOR_NODE_TARGET: Record<string, string> = {
  "43": "node24",
};

function declaredNodeTarget(): string | undefined {
  let target: string | undefined;
  forEachNode(parseTypeScriptFile(CONFIG_PATH), (node) => {
    if (
      target === undefined &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === TARGET_CONST &&
      node.initializer !== undefined &&
      ts.isStringLiteral(node.initializer)
    ) {
      target = node.initializer.text;
    }
  });
  return target;
}

function declaredElectronRange(): string | undefined {
  const manifest = JSON.parse(readFileSync(PACKAGE_MANIFEST, "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  return manifest.devDependencies?.electron;
}

describe("desktop main-process Node target (ISS-10357)", () => {
  test("`ELECTRON_NODE_TARGET` matches the Electron major the app declares", () => {
    const range = declaredElectronRange();
    assert.ok(
      range,
      `${PACKAGE_MANIFEST} must declare an \`electron\` devDependency`
    );
    const major = LEADING_MAJOR.exec(range)?.[1];
    assert.ok(
      major,
      `could not read a major version out of \`electron\`: ${range}`
    );
    const expected = ELECTRON_MAJOR_NODE_TARGET[major];
    assert.ok(
      expected,
      `Electron ${major} has no row in ELECTRON_MAJOR_NODE_TARGET (${CONFIG_PATH} test). Add one naming the Node major that Electron embeds — \`process.versions.node\` in the new Electron says which — and set ${TARGET_CONST} to match.`
    );
    assert.equal(
      declaredNodeTarget(),
      expected,
      `${CONFIG_PATH} \`${TARGET_CONST}\` must be \`${expected}\` for the declared Electron ${major}. Compiling for an older ABI silently downlevels syntax the runtime supports; a newer one emits syntax it does not.`
    );
  });
});
