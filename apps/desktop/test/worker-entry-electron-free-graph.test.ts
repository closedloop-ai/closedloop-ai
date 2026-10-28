import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript6";
import { afterAll, describe, test } from "vitest";
import { collectTsFiles } from "./helpers/collect-ts-files.js";
import { forEachNode, parseTypeScriptFile } from "./helpers/ts-ast.js";

// ISS-8906. A `node:worker_threads` worker is plain Node: Electron does NOT
// inject the `electron` built-in into it, so ANY module in a worker entry's
// evaluated import graph that reaches `electron`, `electron-log` or
// `electron-store` (whose own entry is `require('electron')`) throws
// `Cannot find module 'electron'` the moment the graph loads. A
// `utilityProcess.fork` child DOES get the built-in, which is why the same
// imports were fine while the db-host was a utilityProcess and became a
// fleet-wide capture outage the moment ISS-8246 M1 moved the SQLite store onto
// a worker thread: `db-store-worker.ts` answered `Opened { error }` and every
// install that took 0.16.1713 captured nothing.
//
// The sibling `worker-entry-bundling.test.ts` guards that a worker entry is
// DECLARED to rollup. Nothing guarded that it is LOADABLE, and that gap is why
// this shipped. The desktop test runner stubs the `electron` specifier
// (`test/helpers/electron-module-stub.ts`), so no behavioral suite can catch it
// either — the check has to be structural.
//
// Both halves are read through the TypeScript AST rather than raw source text
// (AGENTS.md → "Test Practices"). The walk follows STATIC and DYNAMIC imports:
// `db-store-worker.ts` reaches its entire store graph through a deliberate
// `await import("./db-store-host.js")`, so a static-only walk would report it
// clean while the store is dead. Type-only imports are skipped because they
// erase at build.
//
// Two known ceilings, both stated so the test's title is not read as a wider
// guarantee than the mechanism gives:
//
//  - The walk follows first-party relative specifiers only. A `@repo/*` or
//    third-party package that requires `electron` transitively is out of its
//    reach; the three specifiers below are the ones this repo's own code names
//    directly, and both of the ISS-8906 entry points are among them.
//  - Entry DISCOVERY matches one idiom: a `new URL(...)` written inline as
//    `new Worker`'s argument. A spawn that hoists the URL to a local, or aliases
//    the `Worker` import, is not seen. `EXPECTED_WORKER_THREAD_ENTRIES` is what
//    keeps that from being silent — a dropped entry fails the set comparison
//    rather than quietly shrinking the checked set.

const MAIN_DIR = "src/main";
const CONFIG_PATH = "vite.main.config.ts";
const WORKER_ENTRIES_CONST = "MAIN_WORKER_ENTRIES";

/**
 * Package specifiers that resolve only inside an Electron process. `electron`
 * and `electron-log` were the ISS-8906 chain through `persistent-log.ts`;
 * `electron-store` was the independent second chain through `jobs/job-store.ts`
 * that made fixing only the first one useless.
 */
const ELECTRON_ONLY_SPECIFIERS = ["electron", "electron-log", "electron-store"];

/**
 * Every `MAIN_WORKER_ENTRIES` entry spawned as a worker THREAD, named rather
 * than counted. `db-host-worker`, `historical-parse-worker`, `pack-scan-worker`
 * and `opencode-materialize-worker` are deliberately absent: they are
 * `utilityProcess.fork` children, which DO get the `electron` built-in, so
 * holding them to this rule would be wrong.
 */
const EXPECTED_WORKER_THREAD_ENTRIES = [
  "agent-session-sync-payload-worker",
  "db-store-worker",
  // ISS-8376: the onboarding byte-inventory sweep. A worker THREAD, so it is
  // held to this rule — it reaches the filesystem through `node:fs` only and
  // must never pick up an Electron-only import.
  "transcript-inventory-worker",
];

/**
 * The `MAIN_WORKER_ENTRIES` entries spawned with `utilityProcess.fork`, which
 * DOES get the `electron` built-in, so this rule must not be held against them.
 *
 * Named rather than left implicit: together with
 * `EXPECTED_WORKER_THREAD_ENTRIES` these two must account for EVERY declared
 * entry. Entry DISCOVERY only scans `src/main` for `new Worker`, so a future
 * worker-thread entry spawned from elsewhere in the main process — `src/server`
 * is still the main process and still legal for `worker_threads` — would never
 * land in the discovered set, and nothing would say its graph went unwalked.
 * Classifying every DECLARED key makes that entry fail loudly instead.
 */
const EXPECTED_UTILITY_PROCESS_ENTRIES = [
  "db-host-worker",
  "historical-parse-worker",
  "opencode-materialize-worker",
  "pack-scan-worker",
];

/**
 * Repo-relative targets a relative specifier is EXPECTED not to resolve to a
 * TypeScript file. `catalog-seed.json` is the only relative non-TS import under
 * `src/main` today. Every other unresolved specifier is a hole in
 * `resolveRelativeSpecifier`, and a hole there is this guard reporting clean
 * over a subgraph it never opened — so it fails rather than shrinking the walk.
 */
const ALLOWED_UNRESOLVED_TARGETS = ["src/main/packs/catalog-seed.json"];

/** Extensions an extensionless specifier or a directory index resolves to. */
const TS_EXTENSIONS = [".ts", ".tsx"];

/**
 * A relative specifier's JS suffix → the TS extensions that emit it. The
 * families are disjoint: `./x.mjs` resolves to `x.mts`, never `x.ts`. A missing
 * row used to drop that dependency in silence, leaving the guard clean over a
 * subgraph it never read; the walk now records every unresolved specifier and
 * the test fails on any whose target is not allowlisted.
 */
const SUFFIX_EXTENSIONS: ReadonlyArray<readonly [string, readonly string[]]> = [
  [".mjs", [".mts"]],
  [".cjs", [".cts"]],
  [".jsx", [".tsx"]],
  [".js", [".ts", ".tsx"]],
];
const JS_SUFFIX = ".js";
const WORKER_SPECIFIER_PREFIX = "./";

type BannedReference = {
  /** The offending bare specifier. */
  specifier: string;
  /** Entry → … → the module that names it. */
  chain: string[];
};

/** A relative specifier the resolver could not map to any TypeScript file. */
type UnresolvedImport = {
  /** The specifier as written. */
  specifier: string;
  /** Repo-relative path of the module that names it. */
  from: string;
  /** Repo-relative path it points at, before extension resolution. */
  target: string;
};

/** One walk's result: what it found, AND what it was unable to read. */
type GraphWalk = {
  references: BannedReference[];
  unresolved: UnresolvedImport[];
};

describe("worker-thread entry module graphs are electron-free (ISS-8906)", () => {
  test("no node:worker_threads entry can reach electron, electron-log or electron-store", () => {
    // Every DECLARED entry is classified. The discovered-set check below
    // catches an entry dropped from the set the scan FINDS; this one catches an
    // entry the scan never finds at all, which would otherwise be absent from
    // `entries` with nothing said and its graph never walked.
    assert.deepEqual(
      [...declaredWorkerEntrySources().keys()].sort(),
      [
        ...EXPECTED_WORKER_THREAD_ENTRIES,
        ...EXPECTED_UTILITY_PROCESS_ENTRIES,
      ].sort(),
      `Every ${WORKER_ENTRIES_CONST} entry in ${CONFIG_PATH} must be classified: a worker thread (EXPECTED_WORKER_THREAD_ENTRIES, held to this rule) or a utilityProcess.fork child (EXPECTED_UTILITY_PROCESS_ENTRIES, exempt because it gets the electron built-in). An unclassified entry is one this test never walks.`
    );

    const entries = workerThreadEntrySourcePaths();

    // Sanity, so neither an emptied/renamed MAIN_WORKER_ENTRIES nor a rewritten
    // spawn call can make this test vacuously green. Every known worker-thread
    // entry is named, not just a non-empty count: discovery needs the `new URL`
    // INLINED as `new Worker`'s argument (see the ceiling note in the header),
    // so hoisting one entry's URL to a local would otherwise drop that entry
    // from the check in silence while `size > 0` still held for the other.
    assert.deepEqual(
      [...entries.keys()].sort(),
      EXPECTED_WORKER_THREAD_ENTRIES,
      `Discovered node:worker_threads entries do not match the expected set. Either ${WORKER_ENTRIES_CONST} in ${CONFIG_PATH} changed, or the "new Worker(new URL(...))" scan over ${MAIN_DIR} stopped matching one of them. Update ${"EXPECTED_WORKER_THREAD_ENTRIES"} deliberately when an entry is genuinely added or removed.`
    );

    const violations: string[] = [];
    const unreadable: string[] = [];
    for (const [name, sourcePath] of entries) {
      const walk = electronOnlyReferencesReachableFrom(sourcePath);
      for (const found of walk.references) {
        violations.push(
          `  [${name}] ${found.specifier}\n      ${found.chain.join("\n   -> ")}`
        );
      }
      for (const miss of walk.unresolved) {
        if (!ALLOWED_UNRESOLVED_TARGETS.includes(miss.target)) {
          unreadable.push(
            `  [${name}] ${miss.specifier}\n      named by ${miss.from}`
          );
        }
      }
    }

    assert.deepEqual(
      unreadable,
      [],
      `These relative specifiers resolved to no TypeScript file, so the walk enqueued nothing and this guard reported clean over a subgraph it never read — the same silence that hid the .mjs/.cjs hole. Teach resolveRelativeSpecifier, or add the target to ALLOWED_UNRESOLVED_TARGETS if it is genuinely not TypeScript:\n${unreadable.join("\n")}`
    );

    assert.deepEqual(
      violations,
      [],
      `These node:worker_threads entries reach an Electron-only package in their evaluated import graph. A worker thread has no "electron" built-in, so the graph throws "Cannot find module 'electron'" on load and the worker's work never happens:\n${violations.join("\n")}`
    );
  });

  test("the graph walk reports every Electron-only reference, not just the first", () => {
    // The decision, executed against a synthetic graph rather than the repo's:
    // two independent chains, one behind a dynamic import, plus a type-only
    // import that must NOT count because it erases at build.
    const root = makeFixtureDir();
    writeFixture(
      root,
      "entry.ts",
      'const m = await import("./host.js");\nexport default m;\n'
    );
    writeFixture(
      root,
      "host.ts",
      'import "./logging.js";\nimport "./nested/store.js";\nimport type { Foo } from "electron";\nexport type Bar = Foo;\n'
    );
    writeFixture(
      root,
      "logging.ts",
      'import electronLog from "electron-log/main.js";\nexport default electronLog;\n'
    );
    writeFixture(
      root,
      "nested/store.ts",
      'import Store from "electron-store";\nexport default Store;\n'
    );

    const { references } = electronOnlyReferencesReachableFrom(
      path.join(root, "entry.ts")
    );

    assert.deepEqual(
      references.map((reference) => reference.specifier).sort(),
      ["electron-log/main.js", "electron-store"],
      "expected BOTH independent chains — reporting only the first is what let ISS-8906's second entry point survive a fix for the first"
    );
    assert.deepEqual(
      references[0].chain.map((file) => path.basename(file)),
      ["entry.ts", "host.ts", "logging.ts"]
    );
  });

  test("a .mjs or .cjs dependency is walked, not silently skipped", () => {
    // The resolver mapped only `.js`, so `./x.mjs` produced the candidate
    // `x.mjs.ts`, matched nothing, and dropped the subgraph without a word —
    // leaving this guard green over a module that imports Electron. The shared
    // `collectTsFiles` helper had already made this call for its own file
    // filter; the dependency walk had not.
    const root = makeFixtureDir();
    writeFixture(
      root,
      "entry.ts",
      'import "./esm-only.mjs";\nimport "./cjs-only.cjs";\nexport const ok = 1;\n'
    );
    writeFixture(
      root,
      "esm-only.mts",
      'import { app } from "electron";\nexport default app;\n'
    );
    writeFixture(
      root,
      "cjs-only.cts",
      'import Store from "electron-store";\nexport default Store;\n'
    );

    assert.deepEqual(
      electronOnlyReferencesReachableFrom(path.join(root, "entry.ts"))
        .references.map((reference) => reference.specifier)
        .sort(),
      ["electron", "electron-store"],
      "expected BOTH suffix families walked — a resolver that maps only .js reports [] here, which is this guard passing over a subgraph it never read"
    );
  });

  test("a clean synthetic graph produces no violations", () => {
    const root = makeFixtureDir();
    writeFixture(
      root,
      "entry.ts",
      'import "./safe.js";\nexport const ok = 1;\n'
    );
    writeFixture(
      root,
      "safe.ts",
      'import type { Foo } from "electron";\nexport type Bar = Foo;\n'
    );

    assert.deepEqual(
      electronOnlyReferencesReachableFrom(path.join(root, "entry.ts"))
        .references,
      []
    );
  });

  test("an unresolvable relative specifier is reported, not silently dropped", () => {
    // `resolved === undefined` used to share a branch with "already visited",
    // which are opposite facts: the first means the walk read nothing AND said
    // nothing. A resolver hole has to be a red test, not a green one over a
    // module the walk never opened.
    const root = makeFixtureDir();
    writeFixture(
      root,
      "entry.ts",
      'import "./seed.json";\nimport "./gone.js";\nexport const ok = 1;\n'
    );

    const { references, unresolved } = electronOnlyReferencesReachableFrom(
      path.join(root, "entry.ts")
    );

    assert.deepEqual(references, []);
    assert.deepEqual(
      unresolved.map((miss) => miss.specifier).sort(),
      ["./gone.js", "./seed.json"],
      "both unresolvable specifiers must be recorded — collapsing them into the visited check is what let a dropped subgraph read as clean"
    );
  });
});

const fixtureRoots: string[] = [];

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeFixtureDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "worker-graph-"));
  fixtureRoots.push(root);
  return root;
}

function writeFixture(
  root: string,
  relativePath: string,
  source: string
): void {
  const full = path.join(root, relativePath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, source, "utf8");
}

/**
 * Entry name → source file, for every entry spawned with `new Worker(...)`.
 *
 * The spawn API is the discriminator, not the file name: `db-host-worker`,
 * `historical-parse-worker`, `pack-scan-worker` and
 * `opencode-materialize-worker` are `utilityProcess.fork` children (each wraps
 * its URL in `fileURLToPath`) and DO get the `electron` built-in, so holding
 * them to this rule would be wrong. Only names that are BOTH spawned as a
 * worker thread and declared in `MAIN_WORKER_ENTRIES` are returned, so the
 * config's `resolve(...)` argument is the source of the path.
 */
function workerThreadEntrySourcePaths(): Map<string, string> {
  const declared = declaredWorkerEntrySources();
  const result = new Map<string, string>();
  for (const file of collectTsFiles(MAIN_DIR)) {
    for (const name of workerThreadEntryNamesIn(parseTypeScriptFile(file))) {
      const source = declared.get(name);
      if (source !== undefined) {
        result.set(name, source);
      }
    }
  }
  return result;
}

/** `MAIN_WORKER_ENTRIES` → entry name → the `resolve("…")` source path. */
function declaredWorkerEntrySources(): Map<string, string> {
  const config = parseTypeScriptFile(CONFIG_PATH);
  const sources = new Map<string, string>();
  forEachNode(config, (node) => {
    if (
      !(
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === WORKER_ENTRIES_CONST &&
        node.initializer !== undefined &&
        ts.isObjectLiteralExpression(node.initializer)
      )
    ) {
      return;
    }
    for (const property of node.initializer.properties) {
      const key = propertyKey(property);
      const value = resolveCallArgument(property);
      if (key !== undefined && value !== undefined) {
        sources.set(key, value);
      }
    }
  });
  return sources;
}

/** `"name": resolve("src/…/x.ts")` → `src/…/x.ts`. */
function resolveCallArgument(
  property: ts.ObjectLiteralElementLike
): string | undefined {
  if (!ts.isPropertyAssignment(property)) {
    return undefined;
  }
  const call = property.initializer;
  if (
    !(
      ts.isCallExpression(call) &&
      ts.isIdentifier(call.expression) &&
      call.expression.text === "resolve"
    )
  ) {
    return undefined;
  }
  const [argument] = call.arguments;
  return argument !== undefined && ts.isStringLiteralLike(argument)
    ? argument.text
    : undefined;
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

/** `new Worker(new URL("./<name>.js", import.meta.url))` → `<name>`. */
function workerThreadEntryNamesIn(source: ts.SourceFile): string[] {
  const names: string[] = [];
  forEachNode(source, (node) => {
    if (
      !(
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Worker"
      )
    ) {
      return;
    }
    const [argument] = node.arguments ?? [];
    const name =
      argument !== undefined && ts.isNewExpression(argument)
        ? workerUrlEntryName(argument)
        : undefined;
    if (name !== undefined) {
      names.push(name);
    }
  });
  return names;
}

/** `new URL("./<name>.js", import.meta.url)` → `<name>`. */
function workerUrlEntryName(node: ts.NewExpression): string | undefined {
  if (!(ts.isIdentifier(node.expression) && node.expression.text === "URL")) {
    return undefined;
  }
  const [specifier, base] = node.arguments ?? [];
  if (
    specifier === undefined ||
    !ts.isStringLiteralLike(specifier) ||
    base === undefined ||
    !isImportMetaUrl(base)
  ) {
    return undefined;
  }
  const { text } = specifier;
  if (!(text.startsWith(WORKER_SPECIFIER_PREFIX) && text.endsWith(JS_SUFFIX))) {
    return undefined;
  }
  return text.slice(WORKER_SPECIFIER_PREFIX.length, -JS_SUFFIX.length);
}

function isImportMetaUrl(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "url" &&
    ts.isMetaProperty(node.expression)
  );
}

/**
 * Breadth-first over the evaluated graph from `entryPath`, returning EVERY
 * Electron-only reference with the chain that reaches it, plus every relative
 * specifier the resolver could not read.
 *
 * Every one, not the first: ISS-8906 had two independent entry points and
 * fixing only the one a first-hit walk reported would have left capture dead.
 * The unresolved half is reported for the same reason in the other direction —
 * a specifier the walk cannot resolve is a subgraph it never read, and silence
 * there is indistinguishable from clean.
 */
function electronOnlyReferencesReachableFrom(entryPath: string): GraphWalk {
  const entry = path.resolve(entryPath);
  const cameFrom = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  const references: BannedReference[] = [];
  const unresolved: UnresolvedImport[] = [];

  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const specifier of evaluatedSpecifiersIn(parseTypeScriptFile(file))) {
      const banned = ELECTRON_ONLY_SPECIFIERS.find(
        (name) => specifier === name || specifier.startsWith(`${name}/`)
      );
      if (banned !== undefined) {
        references.push({ specifier, chain: chainTo(file, cameFrom) });
        continue;
      }
      if (!specifier.startsWith(".")) {
        continue;
      }
      const resolved = resolveRelativeSpecifier(file, specifier);
      // "could not resolve" and "already visited" are opposite facts. Collapsing
      // them meant an unresolvable specifier enqueued nothing and said nothing,
      // so the whole subgraph behind it dropped and the guard still read clean.
      if (resolved === undefined) {
        unresolved.push({
          specifier,
          from: path.relative(process.cwd(), file),
          target: path.relative(
            process.cwd(),
            path.resolve(path.dirname(file), specifier)
          ),
        });
        continue;
      }
      if (cameFrom.has(resolved)) {
        continue;
      }
      cameFrom.set(resolved, file);
      queue.push(resolved);
    }
  }
  return { references, unresolved };
}

function chainTo(file: string, cameFrom: Map<string, string | null>): string[] {
  const chain: string[] = [];
  let current: string | null | undefined = file;
  while (current !== null && current !== undefined) {
    chain.unshift(path.relative(process.cwd(), current));
    current = cameFrom.get(current);
  }
  return chain;
}

/**
 * Every specifier whose module is EVALUATED when `source` is: static imports,
 * side-effect imports, value re-exports, and dynamic `import()` of a literal.
 * Type-only forms are excluded — they erase at build and cannot fail a load.
 */
function evaluatedSpecifiersIn(source: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  forEachNode(source, (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      if (!isTypeOnlyImportClause(node.importClause)) {
        specifiers.push(node.moduleSpecifier.text);
      }
      return;
    }
    if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const [argument] = node.arguments;
      if (argument !== undefined && ts.isStringLiteralLike(argument)) {
        specifiers.push(argument.text);
      }
    }
  });
  return specifiers;
}

/**
 * True when nothing in the clause survives to runtime. A bare side-effect
 * import has NO clause and must return false: `import "./x.js"` evaluates
 * `./x.js`.
 */
function isTypeOnlyImportClause(clause: ts.ImportClause | undefined): boolean {
  if (clause === undefined) {
    return false;
  }
  if (clause.isTypeOnly) {
    return true;
  }
  const bindings = clause.namedBindings;
  return (
    clause.name === undefined &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

/** `./x.js` → the TS file the build resolves it to (`./x.mjs` → `x.mts`, …). */
function resolveRelativeSpecifier(
  fromFile: string,
  specifier: string
): string | undefined {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const match = SUFFIX_EXTENSIONS.find(([suffix]) => base.endsWith(suffix));
  const stem = match === undefined ? base : base.slice(0, -match[0].length);
  const extensions = match === undefined ? TS_EXTENSIONS : match[1];
  const candidates = [
    ...extensions.map((extension) => stem + extension),
    ...TS_EXTENSIONS.map((extension) => path.join(stem, `index${extension}`)),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}
