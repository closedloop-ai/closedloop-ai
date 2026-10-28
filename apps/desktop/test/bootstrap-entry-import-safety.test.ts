/**
 * @file bootstrap-entry-import-safety.test.ts
 * @description ISS-6330: `src/main/index.ts` registers the crash handlers, so
 * its WHOLE static module graph is evaluated before any handler exists. A module
 * on that graph that throws at evaluation time exits silently — no dialog, no
 * telemetry — which is strictly worse than having no handler at all. This walks
 * the real graph transitively and fails when a dependency-heavy or I/O-touching
 * surface appears on it.
 *
 * WHY A TEST AND NOT ONLY dependency-cruiser. The declarative twins of these
 * rules live in `scripts/dependency-cruiser.config.cjs`
 * (`bootstrap-entry-import-safe` / `bootstrap-entry-no-raw-io`). That gate DOES
 * execute — as of ISS-7240, which repaired it. This file is a second,
 * independent guard on those two rules rather than the only one.
 *
 * Be precise about what it does NOT cover, because the two are not equivalent.
 * The config carries nine rules (8 forbidden + 1 required); this file
 * substitutes for two of them. It also walks a single root, BOOTSTRAP_ENTRY
 * (`src/main/index.ts`), whereas `boot-no-design-system-runtime` covers four
 * boot entries — so a database import added to `startup.ts`, `app.ts`, or
 * `window.ts` is caught by the depcruise gate and not by anything here. That is
 * not hypothetical; it is how both ISS-7240 violations arrived.
 *
 * Keep the two in sync. Where they disagree the depcruise config is the
 * authority: it resolves the real module graph, while the walk below matches
 * specifiers by substring.
 *
 * AST-based (import specifiers only), per the sanctioned guard pattern in
 * `scripts/lint/rules/no-raw-text-source-scan.ts`.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SourceFile } from "typescript6";
import {
  createSourceFile,
  forEachChild,
  isExportDeclaration,
  isImportDeclaration,
  isStringLiteral,
  ScriptKind,
  ScriptTarget,
} from "typescript6";
import { test } from "vitest";
import { findDependencyCruiserManifest } from "../scripts/assert-supported-node.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(testDir, "..");
const BOOTSTRAP_ENTRY = "src/main/index.ts";

/**
 * Surfaces that must not be reachable from the bootstrap entry. Substring match
 * against every specifier on the graph and every repo-relative module it
 * resolves to, so `@opentelemetry/api` and
 * `src/main/telemetry/app-otel-runtime.ts` are both caught.
 *
 * The OTel runtime is the pointed one: the telemetry bridge index.ts reaches
 * holds a `DesktopOtelRuntime` as a TYPE only, and type-only edges are excluded
 * from this walk. Promote that to a value import and this list bites.
 */
const FORBIDDEN_REACHABLE_SUBSTRINGS = [
  "app-otel-runtime",
  "@opentelemetry",
  "socket.io-client",
  "cloud-socket",
  "relay",
  "datadog",
  "posthog",
  "observability",
  "telemetry-service",
  "prisma",
  "otlp",
  "collectors/",
  "database/",
];

/**
 * Raw I/O and process control. Evaluating one is not itself fatal, but each
 * marks a module heavy enough to fail at load, and none has any business on a
 * path whose only job is to install two listeners.
 */
const FORBIDDEN_CORE_MODULES = new Set([
  "fs",
  "fs/promises",
  "http",
  "https",
  "net",
  "tls",
  "dgram",
  "dns",
  "child_process",
  "worker_threads",
  "cluster",
  "inspector",
]);

const NODE_PROTOCOL_PREFIX = /^node:/;
const JS_EXTENSION = /\.js$/;

type ModuleReader = (repoRelativePath: string) => string | undefined;

test("the bootstrap entry reaches no OTel runtime, transport, or vendor SDK", () => {
  const reached = collectReachableSpecifiers(
    BOOTSTRAP_ENTRY,
    readDesktopModule
  );

  const offenders = [...reached].filter((specifier) =>
    FORBIDDEN_REACHABLE_SUBSTRINGS.some((forbidden) =>
      specifier.includes(forbidden)
    )
  );

  assert.deepEqual(
    offenders,
    [],
    `${BOOTSTRAP_ENTRY} must stay import-safe; these are reachable from it: ${offenders.join(", ")}`
  );
  // The walk genuinely traversed: index.ts's own eager path must be present, so
  // this cannot pass because the parse produced nothing.
  assert.ok(
    [...reached].some((specifier) => specifier.includes("exception-sanitizer")),
    `expected the walk to reach the sanitizer; reached: ${[...reached].join(", ")}`
  );
});

test("the bootstrap entry reaches no filesystem, network, or spawn builtin", () => {
  const reached = collectReachableSpecifiers(
    BOOTSTRAP_ENTRY,
    readDesktopModule
  );

  const offenders = [...reached].filter((specifier) =>
    FORBIDDEN_CORE_MODULES.has(specifier.replace(NODE_PROTOCOL_PREFIX, ""))
  );

  assert.deepEqual(
    offenders,
    [],
    `${BOOTSTRAP_ENTRY} must not reach raw I/O; found: ${offenders.join(", ")}`
  );
});

test("the walk catches a heavy import added TRANSITIVELY, not just at the entry", () => {
  // Synthetic graph, so this proves the guard CATCHES rather than only that the
  // current tree passes: the violation sits two hops down, exactly where a real
  // regression would land, and the entry itself looks innocent.
  const modules: Record<string, string> = {
    "src/main/index.ts": 'import { a } from "./lifecycle/handlers.js";',
    "src/main/lifecycle/handlers.ts":
      'import { b } from "../telemetry/bridge.js";',
    "src/main/telemetry/bridge.ts":
      'import { trace } from "@opentelemetry/api";',
  };
  const reached = collectReachableSpecifiers(
    "src/main/index.ts",
    (modulePath) => modules[modulePath]
  );

  assert.ok(
    [...reached].some((specifier) => specifier.includes("@opentelemetry")),
    `the walk must follow past the first hop; reached: ${[...reached].join(", ")}`
  );
});

test("a type-only edge is not a value edge", () => {
  // The exact shape the production bridge uses for `DesktopOtelRuntime`. Counting
  // it would make the real guard fire on a graph that is genuinely import-safe.
  const modules: Record<string, string> = {
    "src/main/index.ts": 'import { a } from "./bridge.js";',
    "src/main/bridge.ts": [
      'import type { DesktopOtelRuntime } from "./telemetry/app-otel-runtime.js";',
      'import { SOME_CONSTANT } from "./contract.js";',
      "export type Held = DesktopOtelRuntime;",
      "export const a = SOME_CONSTANT;",
    ].join("\n"),
    "src/main/contract.ts": "export const SOME_CONSTANT = 1;",
  };
  const reached = collectReachableSpecifiers(
    "src/main/index.ts",
    (modulePath) => modules[modulePath]
  );

  assert.ok(
    ![...reached].some((specifier) => specifier.includes("app-otel-runtime")),
    "a type-only import must not count as reaching the runtime"
  );
  assert.ok(
    [...reached].some((specifier) => specifier.includes("contract")),
    "the value import beside it must still be followed"
  );
});

/**
 * ISS-7240. The assertion the boundary gate cannot make about itself: whether it
 * inspected anything. These two are what prove the `typescript6`
 * `packageExtensions` entry in pnpm-workspace.yaml is doing its job — drop that
 * entry and both go red here, naming the cause, instead of the gate quietly
 * cruising nothing and exiting 0.
 *
 * They shipped as `node:test` `todo` in #5422, when they were truthfully red and
 * no green formulation existed; ISS-7240 made them pass, so they are ordinary
 * assertions now.
 */
// Well under the ~1340 non-test `.ts`/`.tsx` files under src/, so ordinary
// churn never trips it — only a cruise that has collapsed.
const MINIMUM_GATHERED_MODULES = 800;

type DependencyCruiserMeta = { scannableExtensions: string[] };
type GatherOptions = {
  baseDir: string;
  extraExtensionsToScan: string[];
  exclude: unknown;
  doNotFollow: unknown;
};
type GatherInitialSources = (
  filesDirectoriesAndGlobs: string[],
  options: GatherOptions
) => string[];
type BoundaryConfig = { options: { exclude: unknown; doNotFollow: unknown } };

test("the boundary gate can see TypeScript at all", async () => {
  const { scannableExtensions } =
    await importDependencyCruiserInternal<DependencyCruiserMeta>(
      "src/extract/transpile/meta.mjs"
    );
  assert.ok(
    scannableExtensions.includes(".ts"),
    `dependency-cruiser will not scan .ts files (scannableExtensions = ${scannableExtensions.join(" ")}), so every rule in dependency-cruiser.config.cjs passes vacuously`
  );
});

test("the boundary gate gathers a non-zero number of modules from src", async () => {
  const { default: gatherInitialSources } =
    await importDependencyCruiserInternal<{
      default: GatherInitialSources;
    }>("src/extract/gather-initial-sources.mjs");
  const { options } = await importBoundaryConfig();
  const gathered = gatherInitialSources(["src"], {
    baseDir: desktopRoot,
    extraExtensionsToScan: [],
    exclude: options.exclude,
    doNotFollow: options.doNotFollow,
  });
  assert.ok(
    gathered.length >= MINIMUM_GATHERED_MODULES,
    `the boundary gate gathered ${gathered.length} files from src (floor ${MINIMUM_GATHERED_MODULES}) — a cruise this small enforces nothing, whatever its exit code`
  );
});

function readDesktopModule(repoRelativePath: string): string | undefined {
  const absolute = path.join(desktopRoot, repoRelativePath);
  if (!existsSync(absolute)) {
    return undefined;
  }
  return readFileSync(absolute, "utf8");
}

/**
 * Every module specifier reachable from `entry` over STATIC, value-carrying
 * import/export edges.
 *
 * Type-only edges are excluded to match the boundary being asserted — a
 * `import type` is erased before runtime and cannot evaluate anything — as is
 * dynamic `import()`, which is the sanctioned lazy path `index.ts` uses for
 * `startup.js` and is the whole reason this entry can stay small.
 */
function collectReachableSpecifiers(
  entry: string,
  readModule: ModuleReader
): Set<string> {
  const reached = new Set<string>();
  const visited = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    const source = readModule(current);
    if (source === undefined) {
      continue;
    }
    for (const specifier of collectValueImportSpecifiers(current, source)) {
      reached.add(specifier);
      const resolved = resolveRelativeSpecifier(current, specifier, readModule);
      if (resolved) {
        reached.add(resolved);
        queue.push(resolved);
      }
    }
  }

  return reached;
}

function collectValueImportSpecifiers(
  modulePath: string,
  source: string
): string[] {
  const sourceFile: SourceFile = createSourceFile(
    modulePath,
    source,
    ScriptTarget.Latest,
    true,
    ScriptKind.TS
  );
  const specifiers: string[] = [];
  const visit = (node: Parameters<typeof forEachChild>[0]): void => {
    // `import type X` / `import { type X }` erase at compile time.
    if (
      isImportDeclaration(node) &&
      isStringLiteral(node.moduleSpecifier) &&
      !node.importClause?.isTypeOnly
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

/**
 * Map a relative ESM specifier onto the repo-relative `.ts` file it names.
 * Returns undefined for bare specifiers, which are graph leaves here — they are
 * still checked, but never followed.
 */
function resolveRelativeSpecifier(
  fromModule: string,
  specifier: string,
  readModule: ModuleReader
): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const joined = path.join(path.dirname(fromModule), specifier);
  const candidates = [
    joined.replace(JS_EXTENSION, ".ts"),
    joined.replace(JS_EXTENSION, ".tsx"),
    `${joined}.ts`,
    path.join(joined, "index.ts"),
  ];
  return candidates.find((candidate) => readModule(candidate) !== undefined);
}

/**
 * Import a dependency-cruiser module the package does not export.
 *
 * Its `exports` map covers neither these internals nor `./package.json`, so the
 * install is located by walking `node_modules` — reusing the resolver that
 * `scripts/assert-supported-node.mjs` already owns for the same reason — and
 * the module is loaded by file URL. That runtime path is why this is a dynamic
 * import rather than a static one at the top of the file.
 */
async function importDependencyCruiserInternal<T>(
  packageRelativePath: string
): Promise<T> {
  const manifestPath = findDependencyCruiserManifest(desktopRoot);
  if (!manifestPath) {
    throw new Error("dependency-cruiser is not installed under apps/desktop");
  }
  const modulePath = path.join(path.dirname(manifestPath), packageRelativePath);
  return await import(pathToFileURL(modulePath).href);
}

async function importBoundaryConfig(): Promise<BoundaryConfig> {
  const configPath = path.join(
    desktopRoot,
    "scripts",
    "dependency-cruiser.config.cjs"
  );
  return (await import(pathToFileURL(configPath).href)).default;
}
