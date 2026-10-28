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
 *   1. it imports nothing from `node:test`. Suites import `vitest` directly
 *      (ISS-11262 converted the tree and retired the alias shim that let
 *      node:test's lifecycle names run under Vitest), so a node:test import
 *      now means the file needs the real `tsx --test` runner;
 *   2. it does not install a Node ESM loader hook (see
 *      {@link installsLoaderHook}); and
 *   3. it is not in {@link VITEST_INCOMPATIBLE_FILES}, the short, reasoned list
 *      of files that depend on `tsx --test`'s RUNTIME rather than on
 *      node:test's API.
 *
 * A test file must ALSO import no `test/` helper that fails those same rules —
 * the golden suites' `describe`/`it` live in `test/golden/*.ts`, not in the
 * `.test.ts` files, so a rule reading only the test file's own imports would
 * pass judgement on nothing at all for nine of them.
 *
 * Rules 1 and 2 route no file today. What the legacy lane runs is exactly the
 * {@link VITEST_INCOMPATIBLE_FILES} entries, which need `tsx --test`'s
 * runtime, so it never disappears. `node-test-census.test.ts` ratchets its
 * size so the rules cannot refill it unnoticed, and the repo-wide
 * `no-node-test-import` source gate rejects a new node:test import anywhere
 * else.
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
 * Files another script runs, deliberately not collected here. Each entry must
 * name that script — an excluded file with no runner is a file nobody executes.
 *
 * - `no-token-surface-dist.test.ts` → `test:dist-token-surface`, run by the
 *   `desktop-build` job right after `Build desktop` (ISS-6367). It REQUIRES
 *   `apps/desktop/dist`, and no lane that runs this suite compiles one since
 *   `desktop-node` / `desktop-renderer` moved to `build:prereqs`.
 */
export const EXCLUDED_TEST_FILES = new Set(["no-token-surface-dist.test.ts"]);

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
 * Files that cannot be routed by any rule about imports, because what they
 * depend on is not an import: they need `tsx --test`'s RUNTIME rather than
 * node:test's API. Each entry is a specific, verified incompatibility with a
 * reason, never "this one failed, park it".
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
    "exception-sanitizer.test.ts",
    "Asserts on the frame format of a REAL V8 stack (ISS-6229: that every parenthesised frame location is redacted). Vitest rewrites stacks through its source maps, so the string under test is the runner's rendering rather than V8's, and the case stops describing the behaviour it was written for. The fixture-driven half of that corpus lives in exception-sanitizer-redaction.test.ts and runs fine under Vitest.",
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
 * @param {ts.SourceFile} sourceFile
 * @returns {boolean} True when the module imports anything from `node:test`.
 */
function importsNodeTest(sourceFile) {
  return sourceFile.statements.some(isNodeTestImport);
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
  return sourceInstallsLoaderHook(parseModule(source, fileName));
}

/**
 * {@link installsLoaderHook} over an already-parsed module.
 *
 * @param {ts.SourceFile} sourceFile
 * @returns {boolean}
 */
function sourceInstallsLoaderHook(sourceFile) {
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
  if (testDir === TEST_DIR) {
    defaultDisqualifyingHelpers ??=
      computeDisqualifyingHelperSpecifiers(TEST_DIR);
    return defaultDisqualifyingHelpers;
  }
  return computeDisqualifyingHelperSpecifiers(testDir);
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
  return sourceFileIsVitestEligible(
    parseModule(source, fileName),
    fileName,
    helperSpecifiers
  );
}

/**
 * {@link isVitestEligible} over an already-parsed module.
 *
 * Every caller here parses the file for its own reasons anyway, so the parse is
 * hoisted to them: classifying one file used to build THREE `ts.SourceFile`s
 * (this one, `installsLoaderHook`'s, and — for a helper — `helperClosure`'s),
 * and the census re-does that for the whole tree on every call.
 *
 * @param {ts.SourceFile} sourceFile
 * @param {string} fileName
 * @param {Set<string>} [helperSpecifiers]
 * @returns {boolean}
 */
function sourceFileIsVitestEligible(sourceFile, fileName, helperSpecifiers) {
  if (VITEST_INCOMPATIBLE_FILES.has(fileName)) {
    return false;
  }
  if (sourceInstallsLoaderHook(sourceFile)) {
    return false;
  }
  if (
    helperSpecifiers !== undefined &&
    importsAnyOf(sourceFile, helperSpecifiers)
  ) {
    return false;
  }
  return !importsNodeTest(sourceFile);
}

/**
 * Partition the desktop test directory.
 *
 * @param {string} [testDir]
 * @returns {Census}
 */
export function censusTestFiles(testDir = TEST_DIR) {
  if (testDir !== TEST_DIR) {
    return computeCensus(testDir);
  }
  defaultCensus ??= computeCensus(TEST_DIR);
  // Copied so a caller cannot mutate the memo other callers will read.
  return {
    vitest: [...defaultCensus.vitest],
    nodeTest: [...defaultCensus.nodeTest],
  };
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
  return sourceFileImportsVitest(
    parseModule(source, fileName),
    helperSpecifiers
  );
}

/**
 * {@link importsVitest} over an already-parsed module.
 *
 * @param {ts.SourceFile} sourceFile
 * @param {Set<string>} [helperSpecifiers]
 * @returns {boolean}
 */
function sourceFileImportsVitest(sourceFile, helperSpecifiers) {
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
 * Closed to a FIXED POINT over helper→helper imports, not one hop (whitlockk
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
  if (testDir !== TEST_DIR) {
    return helperClosure(testDir, (sourceFile) =>
      sourceFileImportsVitest(sourceFile)
    );
  }
  defaultVitestReachingHelpers ??= helperClosure(TEST_DIR, (sourceFile) =>
    sourceFileImportsVitest(sourceFile)
  );
  // Copied so a caller cannot mutate the memo other callers will read.
  return new Set(defaultVitestReachingHelpers);
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
 * @param {(sourceFile: ts.SourceFile, fileName: string) => boolean} isSeed Reads one helper in isolation, with no transitive knowledge.
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
      const specifier = resolveHelperSpecifier(
        relativeDir,
        entry.name.replace(TS_EXTENSION, ".js")
      );
      const sourceFile = parseModule(
        readFileSync(join(dir, entry.name), "utf8"),
        entry.name
      );
      imports.set(
        specifier,
        relativeImportSpecifiers(sourceFile).map((imported) =>
          resolveHelperSpecifier(relativeDir, imported)
        )
      );
      if (isSeed(sourceFile, entry.name)) {
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

/**
 * One parse of one module, shared by every rule that reads it.
 *
 * `setParentNodes` is FALSE. Every walk in this file goes through
 * `ts.forEachChild` and none of them consults `.parent`, but building the
 * pointers still costs ~50% on top of the parse (measured over this tree:
 * 1.24s without, 1.91s with) — and this runs over ~1,500 files.
 *
 * @param {string} source
 * @param {string} fileName
 * @returns {ts.SourceFile}
 */
function parseModule(source, fileName) {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false
  );
}

/**
 * {@link censusTestFiles} without the memo — the derivation itself.
 *
 * @param {string} testDir
 * @returns {Census}
 */
function computeCensus(testDir) {
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
    const sourceFile = parseModule(
      readFileSync(join(testDir, name), "utf8"),
      name
    );
    (sourceFileIsVitestEligible(sourceFile, name, helperSpecifiers)
      ? vitest
      : nodeTest
    ).push(`test/${name}`);
  }
  return { vitest, nodeTest };
}

/**
 * {@link disqualifyingHelperSpecifiers} without the memo.
 *
 * @param {string} testDir
 * @returns {Set<string>}
 */
function computeDisqualifyingHelperSpecifiers(testDir) {
  return helperClosure(
    testDir,
    (sourceFile, fileName) => !sourceFileIsVitestEligible(sourceFile, fileName)
  );
}

/**
 * Memos for {@link TEST_DIR} — the one directory whose contents cannot change
 * while a run is in flight, and the one every production caller asks about.
 *
 * A single census parses every file under `test/` and costs seconds; the runner
 * takes one, `vitest.node.config.ts` takes one, and the suites that guard this
 * machinery take one per case and one more per runner they spawn. Uncached,
 * every test file added to the tree is paid for by all of them, which is how a
 * 3% growth in file count bought a 48% slower lane (ISS-9275).
 *
 * Only the default directory is memoised. A caller that passes an explicit
 * `testDir` is driving the derivation over a fixture it just built, and must
 * see that fixture rather than a cached answer about a different tree.
 */
/** @type {Census | undefined} */
let defaultCensus;
/** @type {Set<string> | undefined} */
let defaultDisqualifyingHelpers;
/** @type {Set<string> | undefined} */
let defaultVitestReachingHelpers;
