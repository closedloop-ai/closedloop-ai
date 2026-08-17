import assert from "node:assert/strict";
import { describe, test } from "node:test";
import ts from "typescript6";
import { collectTsFiles } from "./helpers/collect-ts-files.js";
import { forEachNode, parseTypeScriptFile } from "./helpers/ts-ast.js";

// PLN-999 guardrail. electron-vite bundles the desktop main process: rollup only
// emits the entry points it is told about plus their STATIC import graph.
// Several Node entry points are spawned as separate processes by runtime PATH —
// `new URL("./<name>.js", import.meta.url)` handed to utilityProcess.fork /
// worker_threads — and are NEVER statically imported. Unless each is declared as
// its own rollup entry, it is silently dropped from dist/main and the fork
// crashes at runtime with `ERR_MODULE_NOT_FOUND` (the db-host-worker boot loop).
//
// The old per-file `tsc` build emitted every `.ts`, so these "just existed";
// headless tests fork-mock the workers, so they never caught the gap. This test
// closes it: every `new URL("./<name>.js", import.meta.url)` worker reference in
// src/main MUST have a matching `<name>` rollup input key in the electron-vite
// config (entry key === emitted basename, because entryFileNames is "[name].js").
//
// Both halves are read via the TypeScript AST rather than raw source text
// (AGENTS.md → "Test Practices"): the references are `new URL` expressions with
// an `import.meta.url` base, and the declared entries are the keys of the MAIN
// target's `build.rollupOptions.input` plus the keys of every registry const
// that literal actually SPREADS (`...MAIN_WORKER_ENTRIES`) — reached by walking
// that exact property path, not by matching any property named `input`, and not
// by trusting a registry the input never references. The `preload` target has its own
// `rollupOptions.input`, and its entries emit as `.cjs`, so accepting them here
// would let a main-process `new URL("./preload-design-system.js", …)` pass
// against an entry that never emits that file.

const MAIN_DIR = "src/main";
const CONFIG_PATH = "electron.vite.config.ts";
const WORKER_ENTRIES_CONST = "MAIN_WORKER_ENTRIES";
/** `main.build.rollupOptions.input` — the ONLY inline input map in scope. */
const MAIN_INPUT_PROPERTY_PATH = [
  "main",
  "build",
  "rollupOptions",
  "input",
] as const;
const WORKER_SPECIFIER_PREFIX = "./";
const WORKER_SPECIFIER_SUFFIX = ".js";

describe("desktop forked-worker entry bundling (PLN-999)", () => {
  test('every new URL("./<name>.js", import.meta.url) worker is a declared electron-vite entry', () => {
    const declared = declaredEntryNames(parseTypeScriptFile(CONFIG_PATH));

    const referenced = new Set<string>();
    for (const file of collectTsFiles(MAIN_DIR)) {
      for (const name of workerEntryNamesReferencedIn(
        parseTypeScriptFile(file)
      )) {
        referenced.add(name);
      }
    }

    // Sanity: the known forked workers must be discoverable, so a regression in
    // the scan itself can't make this test vacuously pass.
    assert.ok(
      referenced.has("db-host-worker"),
      "expected to find the db-host-worker runtime reference in src/main"
    );

    const missing = [...referenced].filter((name) => !declared.has(name));
    assert.deepEqual(
      missing,
      [],
      `These forked-worker entry points are referenced via new URL(import.meta.url) but are NOT declared as electron-vite rollup inputs, so they will be dropped from dist/main and crash the fork at runtime. Add each to ${WORKER_ENTRIES_CONST} in ${CONFIG_PATH}:\n${missing.join("\n")}`
    );
  });

  test("a registry the MAIN rollup input does not spread is NOT declared", () => {
    // The mutation this guardrail must survive: `...MAIN_WORKER_ENTRIES` deleted
    // from `main.build.rollupOptions.input`. Rollup then emits none of those
    // workers, so they must stop counting as declared.
    const withSpread = declaredEntryNames(
      configFixture(`...${WORKER_ENTRIES_CONST},`)
    );
    const withoutSpread = declaredEntryNames(configFixture(""));

    assert.ok(withSpread.has("db-host-worker"));
    assert.deepEqual([...withoutSpread], ["index"]);
  });
});

/** A minimal electron-vite config whose MAIN input carries `inputSpread`. */
function configFixture(inputSpread: string): ts.SourceFile {
  return ts.createSourceFile(
    CONFIG_PATH,
    `const ${WORKER_ENTRIES_CONST} = { "db-host-worker": "w.ts" };\n` +
      `export default defineConfig({ main: { build: { rollupOptions: { input: { index: "i.ts", ${inputSpread} } } } } });\n`,
    ts.ScriptTarget.Latest,
    false
  );
}

/**
 * Rollup input keys declared by the electron-vite config for the MAIN target.
 *
 * Rooted at `main.build.rollupOptions.input` and NOTHING else: a registry const
 * such as `MAIN_WORKER_ENTRIES` counts only where that input literal actually
 * spreads it. Unioning the registry in unconditionally made the test pass with
 * `...MAIN_WORKER_ENTRIES` deleted from the input — every worker still appeared
 * "declared" while rollup silently dropped all of them, which is the exact
 * failure this guardrail exists to catch.
 */
function declaredEntryNames(config: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  collectEntryNames(mainRollupInputLiteral(config), config, names, new Set());
  return names;
}

/** The keys of `literal`, plus the keys of every registry it spreads. */
function collectEntryNames(
  literal: ts.ObjectLiteralExpression | undefined,
  config: ts.SourceFile,
  names: Set<string>,
  visited: Set<string>
): void {
  for (const property of literal?.properties ?? []) {
    if (ts.isSpreadAssignment(property)) {
      collectSpreadEntryNames(property, config, names, visited);
      continue;
    }
    const name = propertyKey(property);
    if (name !== undefined) {
      names.add(name);
    }
  }
}

/** `...MAIN_WORKER_ENTRIES` → the keys of that const's object literal. */
function collectSpreadEntryNames(
  property: ts.SpreadAssignment,
  config: ts.SourceFile,
  names: Set<string>,
  visited: Set<string>
): void {
  if (!ts.isIdentifier(property.expression)) {
    return;
  }
  const spreadName = property.expression.text;
  // `visited` only bounds the walk; a real config cannot spread a cycle.
  if (visited.has(spreadName)) {
    return;
  }
  visited.add(spreadName);
  collectEntryNames(
    objectLiteralNamed(config, spreadName),
    config,
    names,
    visited
  );
}

/** The `const <name> = { … }` object literal declared in `config`. */
function objectLiteralNamed(
  config: ts.SourceFile,
  name: string
): ts.ObjectLiteralExpression | undefined {
  let found: ts.ObjectLiteralExpression | undefined;
  forEachNode(config, (node) => {
    if (
      found === undefined &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      found = node.initializer;
    }
  });
  return found;
}

/**
 * Descend `main.build.rollupOptions.input` from the exported config object.
 *
 * Anchored to that path on purpose: a bare "any property named `input`" scan
 * also matches `preload.build.rollupOptions.input`, whose entries emit `.cjs`,
 * so a main-process `new URL("./<preload-entry>.js", …)` would pass against a
 * file that is never produced.
 */
function mainRollupInputLiteral(
  config: ts.SourceFile
): ts.ObjectLiteralExpression | undefined {
  let literal = exportedConfigLiteral(config);
  for (const key of MAIN_INPUT_PROPERTY_PATH) {
    literal = propertyObjectLiteral(literal, key);
  }
  return literal;
}

/** The object literal passed to `defineConfig({ … })` in the default export. */
function exportedConfigLiteral(
  config: ts.SourceFile
): ts.ObjectLiteralExpression | undefined {
  let found: ts.ObjectLiteralExpression | undefined;
  forEachNode(config, (node) => {
    if (found !== undefined || !ts.isExportAssignment(node)) {
      return;
    }
    const expression = node.expression;
    if (ts.isObjectLiteralExpression(expression)) {
      found = expression;
      return;
    }
    const argument = ts.isCallExpression(expression)
      ? expression.arguments[0]
      : undefined;
    if (argument !== undefined && ts.isObjectLiteralExpression(argument)) {
      found = argument;
    }
  });
  return found;
}

/** `{ key: { … } }` → the nested object literal, or `undefined`. */
function propertyObjectLiteral(
  literal: ts.ObjectLiteralExpression | undefined,
  key: string
): ts.ObjectLiteralExpression | undefined {
  for (const property of literal?.properties ?? []) {
    if (
      ts.isPropertyAssignment(property) &&
      propertyKey(property) === key &&
      ts.isObjectLiteralExpression(property.initializer)
    ) {
      return property.initializer;
    }
  }
  return undefined;
}

function propertyKey(
  property: ts.ObjectLiteralElementLike
): string | undefined {
  const name = property.name;
  if (
    name !== undefined &&
    (ts.isIdentifier(name) || ts.isStringLiteralLike(name))
  ) {
    return name.text;
  }
  return undefined;
}

function workerEntryNamesReferencedIn(source: ts.SourceFile): string[] {
  const names: string[] = [];
  forEachNode(source, (node) => {
    const name = workerEntryName(node);
    if (name !== undefined) {
      names.push(name);
    }
  });
  return names;
}

/** `new URL("./<name>.js", import.meta.url)` → `<name>`. */
function workerEntryName(node: ts.Node): string | undefined {
  if (!ts.isNewExpression(node)) {
    return undefined;
  }
  if (!(ts.isIdentifier(node.expression) && node.expression.text === "URL")) {
    return undefined;
  }
  const [specifier, base] = node.arguments ?? [];
  if (specifier === undefined || !ts.isStringLiteralLike(specifier)) {
    return undefined;
  }
  if (base === undefined || !isImportMetaUrl(base)) {
    return undefined;
  }
  const { text } = specifier;
  if (
    !(
      text.startsWith(WORKER_SPECIFIER_PREFIX) &&
      text.endsWith(WORKER_SPECIFIER_SUFFIX)
    )
  ) {
    return undefined;
  }
  return text.slice(
    WORKER_SPECIFIER_PREFIX.length,
    -WORKER_SPECIFIER_SUFFIX.length
  );
}

function isImportMetaUrl(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "url" &&
    ts.isMetaProperty(node.expression)
  );
}
