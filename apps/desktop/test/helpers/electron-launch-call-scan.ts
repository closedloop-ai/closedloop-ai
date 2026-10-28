import { readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";
import { forEachNode, parseTypeScriptFile } from "./ts-ast.js";

/**
 * The AST scan behind the guards that every harness Electron launch goes
 * through `launchElectronOrExplain` (ISS-6875; ISS-12135 added its preflight
 * and the soak and control-skill scopes). Shared so each scope's guard counts
 * launches the same way.
 */

export const ELECTRON_LAUNCH_WRAPPER = "launchElectronOrExplain";
export const PLAYWRIGHT_MODULE = "@playwright/test";
const ELECTRON_EXPORT = "_electron";
/**
 * The raw spellings, kept as a FLOOR under the per-file derivation below rather
 * than as the whole set. A launcher that re-exports Playwright's entry point
 * through a local barrel has no `@playwright/test` import to derive from, so
 * dropping these would make the guard narrower than it is today.
 */
const ELECTRON_RECEIVER_FLOOR = ["electron", ELECTRON_EXPORT];
/**
 * The extensions the guard scans, which must cover everything the Desktop
 * Playwright runner collects. Its `testMatch` is the UNANCHORED `/.*\.spec\.ts/`
 * (`playwright.config.ts`), so `.spec.tsx` matches it too — a `.tsx` spec runs
 * in the suite, and a scan that skipped it would drop the file before any
 * wrapper assertion was generated. `runner collects` below pins that against
 * the config's own regex rather than against this comment.
 */
export const RUNNER_SOURCE_EXTENSIONS = [".ts", ".tsx"];

/** Local bindings through which Playwright's `_electron` can be reached. */
export type ElectronBindings = {
  /** `import { _electron as X }` — `X.launch(...)`. */
  direct: Set<string>;
  /** `import * as X` — `X._electron.launch(...)`. */
  namespaces: Set<string>;
};

/**
 * Every source file under `dir` a harness runner could collect, as a path
 * relative to `root`. Parameterised by directory because the guards scan
 * different scopes.
 */
export function harnessSourceFiles(dir: string, root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...harnessSourceFiles(full, root));
    } else if (
      entry.isFile() &&
      RUNNER_SOURCE_EXTENSIONS.some((extension) =>
        entry.name.endsWith(extension)
      )
    ) {
      found.push(path.relative(root, full));
    }
  }
  return found;
}

/**
 * The names `_electron` actually answers to IN THIS FILE, derived from its own
 * `@playwright/test` imports.
 *
 * A hard-coded receiver set reads as complete while any other alias — and both
 * shipped launchers already alias, as `_electron as electron` — walks straight
 * past it and takes the whole file out of the guarded set, generating no case
 * at all. Type-only bindings are excluded: they cannot be a runtime receiver.
 */
export function electronBindings(source: ts.SourceFile): ElectronBindings {
  const bindings: ElectronBindings = {
    direct: new Set(ELECTRON_RECEIVER_FLOOR),
    namespaces: new Set<string>(),
  };
  for (const statement of source.statements) {
    const named = playwrightNamedBindings(statement);
    if (!named) {
      continue;
    }
    if (ts.isNamespaceImport(named)) {
      bindings.namespaces.add(named.name.text);
      continue;
    }
    for (const element of named.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (!element.isTypeOnly && imported === ELECTRON_EXPORT) {
        bindings.direct.add(element.name.text);
      }
    }
  }
  return bindings;
}

/** The runtime named bindings of a `@playwright/test` import, if any. */
function playwrightNamedBindings(
  statement: ts.Statement
): ts.NamedImportBindings | undefined {
  if (
    !(
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === PLAYWRIGHT_MODULE
    )
  ) {
    return undefined;
  }
  const clause = statement.importClause;
  if (!clause || clause.isTypeOnly) {
    return undefined;
  }
  return clause.namedBindings;
}

/** Count of `<electron>.launch(...)` under `root`, for this file's bindings. */
export function countElectronLaunchCalls(
  root: ts.Node,
  bindings: ElectronBindings
): number {
  let count = 0;
  forEachNode(root, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "launch" &&
      isElectronReceiver(node.expression.expression, bindings)
    ) {
      count += 1;
    }
  });
  return count;
}

/** Count of those calls that sit INSIDE a `launchElectronOrExplain(...)`. */
export function countWrappedElectronLaunchCalls(
  source: ts.SourceFile,
  bindings: ElectronBindings
): number {
  let count = 0;
  forEachNode(source, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === ELECTRON_LAUNCH_WRAPPER
    ) {
      count += countElectronLaunchCalls(node, bindings);
    }
  });
  return count;
}

/** Whether `receiver` is one of this file's routes to Playwright's Electron. */
function isElectronReceiver(
  receiver: ts.Expression,
  bindings: ElectronBindings
): boolean {
  if (ts.isIdentifier(receiver)) {
    return bindings.direct.has(receiver.text);
  }
  return (
    ts.isPropertyAccessExpression(receiver) &&
    receiver.name.text === ELECTRON_EXPORT &&
    ts.isIdentifier(receiver.expression) &&
    bindings.namespaces.has(receiver.expression.text)
  );
}

/**
 * Every module under `dir` that launches the app, with its parsed source,
 * DERIVED rather than listed.
 *
 * A hand-written list is stale before it merges and fails silently when it is,
 * which is why `scripts/node-test-census.mjs` derives its own partition. A new
 * launcher helper is covered here the day it lands.
 */
export function electronLaunchers(
  dir: string,
  root: string
): {
  relativePath: string;
  source: ts.SourceFile;
  bindings: ElectronBindings;
}[] {
  return harnessSourceFiles(dir, root)
    .map((relativePath) => {
      const source = parseTypeScriptFile(path.join(root, relativePath));
      return { relativePath, source, bindings: electronBindings(source) };
    })
    .filter(
      ({ source, bindings }) => countElectronLaunchCalls(source, bindings) > 0
    );
}
