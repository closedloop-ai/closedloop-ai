// @ts-check

/**
 * ISS-4933 — split `apps/desktop/test/*.test.ts` into the files that can run
 * under Vitest and the ones that still need `node:test`.
 *
 * Why a census instead of a hand-maintained list: this directory grew 616 →
 * 744 → 901 files in nine days. Any list committed here is stale before it
 * merges, and the failure mode of a stale list is silent — a file nobody
 * classified is a file nobody runs. Deriving the split at runtime means a new
 * test file is always executed by one runner or the other, and the only thing
 * a mis-census can cost is which of the two.
 *
 * The split is by AST, not text scan (multi-line imports, and the repo's
 * no-raw-text-source-scan gate). A module is Vitest-eligible when ALL hold:
 *
 *   1. every specifier it imports from `node:test` is one the Vitest shim
 *      re-implements (`test`/`it`/`describe`/`before`/`after`/`beforeEach`/
 *      `afterEach`, plus the default export, which node:test defines as `test`);
 *      a NAMESPACE import is not, because a namespace object's members are the
 *      module's export set, so rule 2 cannot tell `nodeTest.mock` from
 *      `nodeTest.describe`;
 *   2. none of its test callbacks take the node:test `TestContext` parameter
 *      (`t.after`, `t.diagnostic`, `t.mock`), which Vitest's context does not
 *      implement, and it reads no property off a node:test import that the shim
 *      does not hang there;
 *   3. it does not install a Node ESM loader hook (see
 *      {@link installsLoaderHook}); and
 *   4. it is not in {@link VITEST_INCOMPATIBLE_FILES}, the short, reasoned list
 *      of files that depend on `tsx --test`'s RUNTIME rather than on
 *      node:test's API, including suites whose production imports the outer c8
 *      lane cannot attribute through Vitest's transformed fork runtime.
 *
 * A test file must ALSO import no `test/` helper that fails those same rules —
 * the golden suites' `describe`/`it` live in `test/golden/*.ts`, not in the
 * `.test.ts` files, so a rule reading only the test file's own imports would
 * pass judgement on nothing at all for nine of them.
 *
 * ISS-4934 converted rules 1 and 2 away — the `mock`/`mock.timers` files and
 * the TestContext users — and took the legacy lane from 144 files to 14. Rules 3
 * and 4 are facts about the two RUNNERS rather than about the tests, so the lane
 * SHRANK but did not disappear, and the two `VITEST_INCOMPATIBLE_FILES` entries
 * mean it never will. What is left besides those two is the loader-hook helper's
 * importers plus five files held back by the file-size ratchet (ISS-6258).
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript6";

const desktopDir = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url))
);

/** Repo-root-relative-to-apps/desktop test directory. */
export const TEST_DIR = join(desktopDir, "test");

/**
 * Run separately (`test:prisma-baseline`) rather than in this suite: Linux Node
 * can hit a native V8 allocator check after this WASM-heavy test has already
 * passed (observed on 24.16.0).
 */
export const EXCLUDED_TEST_FILES = new Set([
  "prisma-baseline-equivalence.test.ts",
]);

/**
 * `import test from "node:test"` — the shim exports a default too (ISS-4934).
 *
 * Not a member of {@link SHIMMED_NODE_TEST_SPECIFIERS} because that set is
 * asserted equal to the shim's NAMED export set, and `default` is not one.
 */
export const DEFAULT_IMPORT_SPECIFIER = "<default>";

/**
 * `import * as nodeTest from "node:test"` — still disqualifying. Unlike a
 * default binding, whose members the unshimmed-property rule can enumerate, a
 * namespace object's shape IS the module's export set, so `nodeTest.mock` is
 * indistinguishable from a legitimate `nodeTest.describe`.
 */
export const NAMESPACE_IMPORT_SPECIFIER = "<namespace>";

/**
 * Named exports of `node:test` that `test/support/node-test-vitest-shim.ts`
 * provides. Keep the two in lockstep — `node-test-census.test.ts` asserts it.
 */
export const SHIMMED_NODE_TEST_SPECIFIERS = new Set([
  "after",
  "afterEach",
  "before",
  "beforeEach",
  "describe",
  "it",
  "test",
]);

/**
 * Properties the shim hangs off `test`/`describe` (`test.skip`, `test.after`).
 *
 * Checked as well as the import specifiers so an unrecognised one routes the
 * file to the node:test lane DETERMINISTICALLY. Without this the file would
 * still fail loudly — `TypeError: test.foo is not a function` — but it would
 * fail as a red gate on someone else's PR rather than quietly staying on the
 * runner that supports it.
 */
export const SHIMMED_NODE_TEST_PROPERTIES = new Set([
  "after",
  "afterEach",
  "before",
  "beforeEach",
  "skip",
]);

/**
 * Glob metacharacters. `vitest.node.config.ts` feeds the Vitest set to
 * `include`, which is matched as PATTERNS, not opened as paths — so unlike the
 * legacy lane (where `tsx --test` errors on a file it cannot open) a name that
 * looks like a pattern is silently dropped from the run, and Vitest only fails
 * when the total reaches zero. No file in this tree contains one, and
 * `node-test-census.test.ts` keeps it that way rather than adding an escaping
 * layer for a case that does not exist.
 */
export const GLOB_METACHARACTERS = /[*?[\]{}()!+@]/;

const TS_EXTENSION = /\.ts$/;

/**
 * Files that depend on `tsx --test`'s RUNTIME, not on node:test's API, and so
 * cannot be routed by any rule about imports. Each entry is a specific,
 * verified incompatibility with a reason — never "this one failed, park it".
 *
 * `node-test-census.test.ts` asserts every entry still exists on disk, so a
 * deleted or renamed file cannot leave a silent no-op sitting here.
 */
export const VITEST_INCOMPATIBLE_FILES = new Map([
  [
    "agent-sync-poll-timer-lifecycle.test.ts",
    "Spawns test/agent-sync-poll-timer-lifecycle-child.ts as a real child process to prove the poll timer does not keep one alive. Under `tsx --test` that child inherits tsx's loader and can resolve the suite's extensionless `.js` specifiers; a Vitest worker has no such loader to pass on, so the child dies with ERR_MODULE_NOT_FOUND before it can demonstrate anything.",
  ],
  [
    "db-host-fire-and-forget.test.ts",
    "The suite passes under Vitest, but the outer c8 node-coverage lane records no execution for db-host-fire-and-forget.ts through Vitest's transformed fork. Running the same node:test suite through tsx credits the production module, so it must stay on that pool for the required coverage census.",
  ],
  [
    "deep-link-protocol.test.ts",
    "The suite passes under Vitest, but the outer c8 node-coverage lane records no execution for lifecycle/deep-link.ts through Vitest's transformed fork. Running the same node:test suite through tsx credits the production module, so it must stay on that pool for the required coverage census.",
  ],
  [
    "exception-sanitizer.test.ts",
    "Asserts on the frame format of a REAL V8 stack (ISS-6229: that every parenthesised frame location is redacted). Vitest rewrites stacks through its source maps, so the string under test is the runner's rendering rather than V8's, and the case stops describing the behaviour it was written for. The fixture-driven half of that corpus lives in exception-sanitizer-redaction.test.ts and runs fine under Vitest.",
  ],
  [
    "shared-branches-canonical-last-active.test.ts",
    "This production-path suite owns the Desktop canonical Last-active coverage contract. The outer c8 lane cannot attribute its main-process imports through Vitest's transformed fork, so routing it through tsx --test keeps the measured production branches attached to the assertions that exercise them.",
  ],
]);

/**
 * @typedef {object} Census
 * @property {string[]} vitest Files the Vitest node config runs, `test/`-prefixed and sorted.
 * @property {string[]} nodeTest Files the temporary node:test runner runs, same shape.
 */

/**
 * @param {ts.Statement} statement
 * @returns {statement is ts.ImportDeclaration} True for `import … from "node:test"`.
 */
function isNodeTestImport(statement) {
  return (
    ts.isImportDeclaration(statement) &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text === "node:test"
  );
}

/**
 * @param {ts.ImportClause} clause
 * @param {Set<string>} specifiers
 * @param {Set<string>} localNames
 */
function collectClause(clause, specifiers, localNames) {
  if (clause.name !== undefined) {
    // `import test from "node:test"` — node:test's default export is `test`,
    // and the shim exports it. Its `.mock` is reachable, but so is the named
    // export's, and `reachesPastShim` reads property accesses off BOTH.
    specifiers.add(DEFAULT_IMPORT_SPECIFIER);
    localNames.add(clause.name.text);
  }
  const bindings = clause.namedBindings;
  if (bindings === undefined) {
    return;
  }
  if (ts.isNamespaceImport(bindings)) {
    specifiers.add(NAMESPACE_IMPORT_SPECIFIER);
    localNames.add(bindings.name.text);
    return;
  }
  for (const element of bindings.elements) {
    specifiers.add((element.propertyName ?? element.name).text);
    localNames.add(element.name.text);
  }
}

/**
 * @param {ts.SourceFile} sourceFile
 * @returns {{ specifiers: Set<string>, localNames: Set<string> } | null} `null` when the file does not import `node:test`.
 */
function readNodeTestImports(sourceFile) {
  /** @type {Set<string>} */
  const specifiers = new Set();
  /** @type {Set<string>} */
  const localNames = new Set();
  let found = false;
  for (const statement of sourceFile.statements) {
    if (!isNodeTestImport(statement)) {
      continue;
    }
    found = true;
    if (statement.importClause !== undefined) {
      collectClause(statement.importClause, specifiers, localNames);
    }
  }
  return found ? { specifiers, localNames } : null;
}

/**
 * True when the file reaches past what the shim implements, either by
 *
 *  - calling a node:test import with a callback that declares a parameter —
 *    node:test's `TestContext`, whose `t.after`/`t.diagnostic`/`t.mock` have no
 *    Vitest equivalent — or
 *  - reading a property off one that the shim does not hang there.
 *
 * @param {ts.SourceFile} sourceFile
 * @param {Set<string>} localNames
 * @returns {boolean}
 */
function reachesPastShim(sourceFile, localNames) {
  let found = false;
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (found) {
      return;
    }
    if (
      readsUnshimmedProperty(node, localNames) ||
      reachesOpaquely(node, localNames) ||
      passesTestContext(node, localNames)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

/**
 * Any read off a node:test binding that {@link readsUnshimmedProperty} cannot
 * name: `const { mock } = test` (a binding pattern) and `test["mock"]` (an
 * element access, whose key need not even be a literal).
 *
 * Rejected wholesale rather than name-checked, because the point of this rule
 * is that the property rule is the ONLY thing standing between a default import
 * and a shim with no `mock` on it. Both spellings are absent from this tree, so
 * "route it to the runner that definitely supports it" costs nothing and cannot
 * be wrong; name-checking an unresolvable computed key could be.
 *
 * @param {ts.Node} node
 * @param {Set<string>} localNames
 * @returns {boolean}
 */
function reachesOpaquely(node, localNames) {
  if (
    ts.isElementAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    localNames.has(node.expression.text)
  ) {
    return true;
  }
  return (
    ts.isVariableDeclaration(node) &&
    ts.isObjectBindingPattern(node.name) &&
    node.initializer !== undefined &&
    ts.isIdentifier(node.initializer) &&
    localNames.has(node.initializer.text)
  );
}

/**
 * `test.somethingTheShimDoesNotHave` — routed to the legacy lane rather than
 * left to crash at import time on a required gate.
 *
 * @param {ts.Node} node
 * @param {Set<string>} localNames
 * @returns {boolean}
 */
function readsUnshimmedProperty(node, localNames) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    localNames.has(node.expression.text) &&
    !SHIMMED_NODE_TEST_PROPERTIES.has(node.name.text)
  );
}

/**
 * `test("…", async (t) => …)` — node:test's `TestContext`, which Vitest's own
 * context does not match.
 *
 * @param {ts.Node} node
 * @param {Set<string>} localNames
 * @returns {boolean}
 */
function passesTestContext(node, localNames) {
  if (!ts.isCallExpression(node)) {
    return false;
  }
  /** @type {ts.Node} */
  let base = node.expression;
  while (ts.isPropertyAccessExpression(base)) {
    base = base.expression;
  }
  if (!(ts.isIdentifier(base) && localNames.has(base.text))) {
    return false;
  }
  return node.arguments.some(
    (argument) =>
      (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) &&
      argument.parameters.length > 0
  );
}

/**
 * True when the source installs a Node ESM loader hook.
 *
 * `module.registerHooks`/`module.register` patch NODE's resolver. Vitest
 * resolves through Vite's module runner instead, so the hook is registered and
 * then simply never consulted: the module under test gets the real `electron`
 * (a path string outside an Electron process), and every named import off it
 * reads `undefined`. The symptom is a pile of
 * `Cannot read properties of undefined (reading 'handle')` — a real failure,
 * loud, but a failure of the RUNNER rather than of the code under test.
 *
 * Detected rather than listed, because the mechanism is what breaks: a new
 * helper doing the same thing, or a test calling `registerHooks` directly, is
 * routed on the same rule the day it lands.
 *
 * @param {string} source
 * @param {string} fileName
 * @returns {boolean}
 */
export function installsLoaderHook(source, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false
  );
  for (const statement of sourceFile.statements) {
    if (
      !(
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) ||
      statement.moduleSpecifier.text !== "node:module"
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) {
      continue;
    }
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (imported === "registerHooks" || imported === "register") {
        return true;
      }
    }
  }
  return false;
}

/**
 * Every non-test module under `test/` that would disqualify its importer, as
 * the `./<path>.js` specifier importers write.
 *
 * The helpers matter as much as the test files, and for the golden suites they
 * matter MORE: `golden-layer3.utc.test.ts` imports no `node:test` at all — it
 * calls `registerGoldenLayer3Suite()` from `test/golden/golden-layer3.ts`, and
 * THAT is where the `describe`/`it` come from. A rule that only reads the test
 * file's own imports declares those nine files eligible vacuously, and the day
 * a golden helper reaches for `mock` they would go to the Vitest lane and fail
 * there instead of being routed. So the disqualifying test applied to a helper
 * is the same one applied to a test file, not just the loader-hook half.
 *
 * Closed transitively over helper→helper imports (see {@link helperClosure}) —
 * `golden-layer3.ts` alone imports seven siblings, and a helper that reaches a
 * disqualifier through one of them disqualifies its importer just as surely as
 * one that imports it directly.
 *
 * @param {string} testDir
 * @returns {Set<string>}
 */
function disqualifyingHelperSpecifiers(testDir) {
  return helperClosure(
    testDir,
    (source, fileName) => !isVitestEligible(source, fileName)
  );
}

/**
 * @param {ts.SourceFile} sourceFile
 * @param {Set<string>} specifiers
 * @returns {boolean} True when the file imports any of `specifiers`.
 */
function importsAnyOf(sourceFile, specifiers) {
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      specifiers.has(statement.moduleSpecifier.text)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Classify one module's source — a test file, or a helper it imports.
 *
 * A module that does not import `node:test` at all is fine on the Vitest lane:
 * either it drives Vitest directly, or (the golden suites' shape) its
 * `describe`/`it` come from a helper, and that helper is classified by this
 * same function through {@link disqualifyingHelperSpecifiers}.
 *
 * @param {string} source
 * @param {string} fileName
 * @param {Set<string>} [helperSpecifiers] Helper specifiers that disqualify their importer.
 * @returns {boolean} True when the Vitest node config can run this file.
 */
export function isVitestEligible(source, fileName, helperSpecifiers) {
  if (VITEST_INCOMPATIBLE_FILES.has(fileName)) {
    return false;
  }
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true
  );
  if (installsLoaderHook(source, fileName)) {
    return false;
  }
  if (
    helperSpecifiers !== undefined &&
    importsAnyOf(sourceFile, helperSpecifiers)
  ) {
    return false;
  }
  const imports = readNodeTestImports(sourceFile);
  if (imports === null) {
    return true;
  }
  for (const specifier of imports.specifiers) {
    if (
      specifier !== DEFAULT_IMPORT_SPECIFIER &&
      !SHIMMED_NODE_TEST_SPECIFIERS.has(specifier)
    ) {
      return false;
    }
  }
  return !reachesPastShim(sourceFile, imports.localNames);
}

/**
 * Partition the desktop test directory.
 *
 * @param {string} [testDir]
 * @returns {Census}
 */
export function censusTestFiles(testDir = TEST_DIR) {
  /** @type {string[]} */
  const vitest = [];
  /** @type {string[]} */
  const nodeTest = [];
  const helperSpecifiers = disqualifyingHelperSpecifiers(testDir);
  const names = readdirSync(testDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".test.ts") &&
        !EXCLUDED_TEST_FILES.has(entry.name)
    )
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    const source = readFileSync(join(testDir, name), "utf8");
    (isVitestEligible(source, name, helperSpecifiers) ? vitest : nodeTest).push(
      `test/${name}`
    );
  }
  return { vitest, nodeTest };
}

/**
 * True when the module imports anything from `vitest`.
 *
 * ISS-4934. A file can be converted to `vi` and still be held on the legacy
 * lane by a rule that has nothing to do with node:test's API — the loader-hook
 * helper's importers are the case that happened — and `tsx --test` then runs a
 * file whose first `vi.*` call throws "Vitest failed to access its internal
 * state". `node-test-census.test.ts` asserts no legacy-lane file does this.
 *
 * By AST rather than by text scan: a regex over the source is satisfiable by a
 * COMMENT mentioning the specifier, which here would red the gate on a file
 * that is perfectly fine.
 *
 * @param {string} source
 * @param {string} fileName
 * @param {Set<string>} [helperSpecifiers] Vitest-reaching helpers, from
 *   {@link vitestReachingHelperSpecifiers}. Omitted to ask only whether this
 *   module imports `vitest` DIRECTLY, which is how the closure seeds itself.
 * @returns {boolean}
 */
export function importsVitest(source, fileName, helperSpecifiers) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false
  );
  for (const statement of sourceFile.statements) {
    if (
      !(
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      )
    ) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    if (specifier === "vitest" || specifier.startsWith("vitest/")) {
      return true;
    }
    if (helperSpecifiers?.has(specifier)) {
      return true;
    }
  }
  return false;
}

/**
 * Every non-test module under `test/` that reaches `vitest`, as the
 * `./<path>.js` specifier importers write.
 *
 * The TRANSITIVE half of the cross-lane guard, and the half that matters most:
 * a converted suite does not import `vitest` itself, it imports
 * `./support/node-test-fake-timers.js`. A guard reading only the test file's
 * own imports would declare all 26 of them safe, and then the first one to
 * acquire a census disqualifier would reproduce the exact incident the guard
 * exists to prevent.
 *
 * Closed to a FIXED POINT over helper→helper imports, not one hop (wongk
 * review). This tree does have helpers importing helpers — `golden-layer3.ts`
 * → `golden-layer3-derive.js` → `golden-corpus.js` → `golden-divergences.js`
 * is four deep — so a one-hop set lets a legacy-routed test reach `vitest`
 * through A → B, pass the guard, and then fail under `tsx --test` with exactly
 * the error the guard exists to prevent.
 *
 * @param {string} [testDir]
 * @returns {Set<string>}
 */
export function vitestReachingHelperSpecifiers(testDir = TEST_DIR) {
  return helperClosure(testDir, importsVitest);
}

/**
 * Every relative specifier a module imports, as written.
 *
 * @param {ts.SourceFile} sourceFile
 * @returns {string[]}
 */
function relativeImportSpecifiers(sourceFile) {
  /** @type {string[]} */
  const specifiers = [];
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.startsWith(".")
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

/**
 * One helper's specifier in the `./<path>.js` form its importers write, from a
 * specifier written relative to some OTHER helper's directory.
 *
 * `golden/golden-layer3.ts` writes `./golden-corpus.js` and
 * `../agent-db-test-utils.js` for two files this set knows as
 * `./golden/golden-corpus.js` and `./agent-db-test-utils.js`. Resolving against
 * the importer's own directory is what makes those the same key; string
 * concatenation would silently match neither, which is a closure that
 * terminates immediately and reports one hop.
 *
 * @param {string} importerDir Importer's directory, relative to the test dir (`""` at the root).
 * @param {string} specifier
 * @returns {string}
 */
function resolveHelperSpecifier(importerDir, specifier) {
  return `./${posix.normalize(posix.join(importerDir, specifier))}`;
}

/**
 * Every non-test module under `test/` that satisfies `isSeed`, plus every
 * helper that reaches one through any chain of helper imports.
 *
 * The loop is monotone — a pass either adds a helper or ends the walk — so a
 * cycle between two helpers terminates it rather than spinning: the second pass
 * over a cycle adds nothing new. Bounded by the helper count.
 *
 * @param {string} testDir
 * @param {(source: string, fileName: string) => boolean} isSeed Reads one helper in isolation, with no transitive knowledge.
 * @returns {Set<string>}
 */
function helperClosure(testDir, isSeed) {
  /** @type {Map<string, string[]>} Helper specifier → the helper specifiers it imports. */
  const imports = new Map();
  /** @type {Set<string>} */
  const matched = new Set();
  /** @param {string} dir @param {string} relativeDir */
  const walk = (dir, relativeDir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), posix.join(relativeDir, entry.name));
        continue;
      }
      if (
        !(entry.isFile() && entry.name.endsWith(".ts")) ||
        entry.name.endsWith(".test.ts")
      ) {
        continue;
      }
      const source = readFileSync(join(dir, entry.name), "utf8");
      const specifier = resolveHelperSpecifier(
        relativeDir,
        entry.name.replace(TS_EXTENSION, ".js")
      );
      const sourceFile = ts.createSourceFile(
        entry.name,
        source,
        ts.ScriptTarget.Latest,
        /* setParentNodes */ false
      );
      imports.set(
        specifier,
        relativeImportSpecifiers(sourceFile).map((imported) =>
          resolveHelperSpecifier(relativeDir, imported)
        )
      );
      if (isSeed(source, entry.name)) {
        matched.add(specifier);
      }
    }
  };
  walk(testDir, "");

  let grew = true;
  while (grew) {
    grew = false;
    for (const [specifier, imported] of imports) {
      if (matched.has(specifier)) {
        continue;
      }
      if (imported.some((name) => matched.has(name))) {
        matched.add(specifier);
        grew = true;
      }
    }
  }
  return matched;
}
