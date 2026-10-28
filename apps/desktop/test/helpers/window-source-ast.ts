/**
 * @file window-source-ast.ts
 * @description The `src/main/window.ts` AST plumbing shared by the guards that
 * pin its `new BrowserWindow({ ... })` call.
 *
 * `window.ts` statically imports `electron`, so it cannot be loaded in a plain
 * node/Vitest process at all — which is why the invariants that live in its
 * constructor argument are pinned structurally (AGENTS.md → "Test Practices":
 * the sanctioned `ts.createSourceFile` parse, never a raw-text regex, which
 * breaks on reformatting and is satisfiable by a comment).
 *
 * Three suites need the same parse and the same lookups
 * (`window-default-size`, `initial-window-reveal-wiring`,
 * `browser-window-web-preferences-lock`), so the parse lives here once. Only the
 * plumbing is shared; each suite keeps its own domain predicates — which is why
 * {@link scanDesktopSourceForRendererTrustBoundary} reports what it FOUND and
 * never decides whether a finding is a violation.
 *
 * Parent pointers ARE set (`setParentNodes: true`) because callers read
 * `node.getText(sourceFile)` for the failure messages that name the offending
 * expression — a structural assertion with an unreadable message is a guard
 * nobody can act on.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ObjectLiteralExpression,
  PropertyName,
  SourceFile,
} from "typescript6";
import {
  createSourceFile,
  forEachChild,
  isComputedPropertyName,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isNewExpression,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSpreadAssignment,
  isStringLiteralLike,
  isVariableDeclaration,
  type Node,
  ScriptKind,
  ScriptTarget,
} from "typescript6";
import { collectTsFiles } from "./collect-ts-files.js";

const helpersDir = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the module under structural test. */
export const WINDOW_SOURCE_PATH = path.resolve(
  helpersDir,
  "..",
  "..",
  "src/main/lifecycle/create-desktop-browser-window.ts"
);

/**
 * Absolute path of the desktop source root.
 *
 * The whole of `src`, not just `src/main`: the gateway (`src/server`) and the
 * cross-process modules (`src/shared`) run in the SAME Electron main process and
 * can construct a window exactly as `src/main` can, and scoping the sweep to the
 * directory the known construction already lives in is how a sweep answers only
 * the question it was already sure of. `src/renderer` is swept too — a renderer
 * module is not supposed to be able to reach `electron` at all, so a
 * `new BrowserWindow` appearing there is a finding rather than an exemption.
 */
export const DESKTOP_SOURCE_DIR = path.resolve(helpersDir, "..", "..", "src");

/** Parse `src/main/window.ts` with parent pointers set. */
export function parseWindowSource(): SourceFile {
  return createSourceFile(
    WINDOW_SOURCE_PATH,
    readFileSync(WINDOW_SOURCE_PATH, "utf8"),
    ScriptTarget.Latest,
    true,
    ScriptKind.TS
  );
}

/**
 * Every `new BrowserWindow({ ... })` options literal in the parsed source.
 *
 * Returns ALL of them, not the first: a second construction site is exactly the
 * thing a caller wants to fail on rather than quietly skip, and a lookup that
 * stopped at the first match would guard one window while a second went
 * unreviewed.
 */
export function findBrowserWindowOptions(
  source: SourceFile
): ObjectLiteralExpression[] {
  const found: ObjectLiteralExpression[] = [];
  const localNames = browserWindowLocalNames(source);
  const visit = (node: Node): void => {
    if (
      isNewExpression(node) &&
      namesBrowserWindow(node.expression, localNames)
    ) {
      const [options] = node.arguments ?? [];
      if (options && isObjectLiteralExpression(options)) {
        found.push(options);
      }
    }
    forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * How many `new BrowserWindow(...)` sites the source contains, whatever shape
 * their argument takes.
 *
 * The COMPANION to {@link findBrowserWindowOptions}, and the reason it exists:
 * that function can only return options it can read, so a site written
 * `new BrowserWindow(makeOptions())` — or with an options variable, or a spread
 * — contributes nothing to its result and is indistinguishable from not
 * existing. A caller pinning "exactly one window" off the literal count would
 * therefore keep passing while a SECOND, unreadable renderer trust boundary was
 * opened beside it, which is the one outcome that guard exists to prevent
 * (chatgpt-codex-connector, PR #5833).
 *
 * Comparing this count against the literal count turns an unreadable options
 * argument into a FAILURE rather than a silent omission: the guard cannot review
 * webPreferences it cannot see, so it must refuse instead of vouching.
 */
export function countBrowserWindowConstructions(source: SourceFile): number {
  let constructions = 0;
  const localNames = browserWindowLocalNames(source);
  const visit = (node: Node): void => {
    if (
      isNewExpression(node) &&
      namesBrowserWindow(node.expression, localNames)
    ) {
      constructions += 1;
    }
    forEachChild(node, visit);
  };
  visit(source);
  return constructions;
}

/**
 * One `webPreferences: { ... }` literal, and the module it was found in.
 *
 * `source` rides along because a caller that reports on the literal — or reads
 * the module's imports to find out where a spread helper came from — needs the
 * `SourceFile` the node was parsed from, and the sweep is the only thing holding
 * it.
 */
export type LocatedWebPreferences = {
  /** Path relative to `src`, e.g. `main/window.ts`. */
  module: string;
  source: SourceFile;
  literal: ObjectLiteralExpression;
};

/**
 * The result of one structural sweep of the desktop source tree.
 *
 * `scannedModules` is the WHOLE list rather than a count, because a count can
 * only answer "did the walk reach anything" and the interesting failure is
 * narrower than that: a walk that quietly drops a SUBTREE, or an extension,
 * still returns a large number and passes any floor. Handing the caller the
 * paths lets it pin the shape of the population — which directories, which
 * extensions — instead of only its size.
 */
export type RendererTrustBoundaryScan = {
  /** Every file the walk parsed, relative to `src`, sorted. */
  scannedModules: string[];
  /** Modules containing a `new BrowserWindow(...)`, relative to `src`. */
  browserWindowModules: string[];
  /** Every `webPreferences` object literal in the tree, in file order. */
  webPreferences: LocatedWebPreferences[];
};

/**
 * Sweep every `.ts`/`.tsx` file under `src` for the two things that can open a
 * renderer trust boundary: a `BrowserWindow` construction, and a
 * `webPreferences` literal.
 *
 * BOTH, in ONE walk, because they are different doors to the same room and a
 * guard that watches only one is not a guard on the boundary. A window
 * constructed in a sibling module carries its own preferences that a
 * `window.ts`-scoped assertion never reads; and `webPreferences` can reach
 * Chromium with no `new BrowserWindow` in sight at all, via a
 * `setWindowOpenHandler` returning `overrideBrowserWindowOptions` — whose child
 * window inherits this window's privileged preload.
 *
 * Structural (`ts.createSourceFile` per file), never a text scan, so a mention
 * in a comment or a string is not a hit and a rename or reformat is not a break.
 *
 * THROWS on any `webPreferences` this cannot read as an inline object literal,
 * rather than skipping it, and the throw is keyed on the KEY rather than on the
 * node shape. Skipping is the silent direction: a window built as
 * `webPreferences: relaxedPrefs()`, as the shorthand `{ webPreferences }`, or
 * as a getter would be collected by nothing, produce no violation, and leave
 * every caller green while handing Chromium a preference set this sweep never
 * read. All three mean the same thing to Chromium, so all three have to mean the
 * same thing here. Assembling one elsewhere has to be made visible by changing
 * this contract.
 */
export function scanDesktopSourceForRendererTrustBoundary(): RendererTrustBoundaryScan {
  const filePaths = collectTsFiles(DESKTOP_SOURCE_DIR).sort();
  const scannedModules: string[] = [];
  const browserWindowModules: string[] = [];
  const webPreferences: LocatedWebPreferences[] = [];
  for (const filePath of filePaths) {
    const source = createSourceFile(
      filePath,
      readFileSync(filePath, "utf8"),
      ScriptTarget.Latest,
      false,
      ScriptKind.TS
    );
    const module = path.relative(DESKTOP_SOURCE_DIR, filePath);
    scannedModules.push(module);
    const localNames = browserWindowLocalNames(source);
    let constructs = false;
    const visit = (node: Node): void => {
      if (
        isNewExpression(node) &&
        namesBrowserWindow(node.expression, localNames)
      ) {
        constructs = true;
      }
      if (isObjectLiteralExpression(node)) {
        collectWebPreferencesOf(node, module, source, webPreferences);
      }
      forEachChild(node, visit);
    };
    visit(source);
    if (constructs) {
      browserWindowModules.push(module);
    }
  }
  return { scannedModules, browserWindowModules, webPreferences };
}

/** The `webPreferences` object literal inside a `BrowserWindow` options literal. */
export function findWebPreferences(
  options: ObjectLiteralExpression
): ObjectLiteralExpression | undefined {
  for (const property of options.properties) {
    if (
      isPropertyAssignment(property) &&
      propertyKeyText(property.name) === "webPreferences" &&
      isObjectLiteralExpression(property.initializer)
    ) {
      return property.initializer;
    }
  }
  return undefined;
}

/**
 * The text of a top-level property's initializer, or `undefined` when the key is
 * absent. Used to pin that a value is read from an imported constant rather than
 * an inline literal.
 */
export function topLevelPropertyValueText(
  options: ObjectLiteralExpression,
  key: string,
  source: SourceFile
): string | undefined {
  for (const property of options.properties) {
    if (
      isPropertyAssignment(property) &&
      isIdentifier(property.name) &&
      property.name.text === key
    ) {
      return property.initializer.getText(source);
    }
  }
  return undefined;
}

/**
 * Every local binding in `source` that refers to Electron's `BrowserWindow`.
 *
 * Always includes the bare name, and adds both alias spellings this repo can
 * actually produce: a renamed named import
 * (`import { BrowserWindow as Win } from "electron"`) and a renamed destructure
 * off the default export (`const { BrowserWindow: Win } = electron`). The second
 * is not hypothetical — `window.ts:59` already does `const { powerMonitor } =
 * electron`, and six other main-process modules destructure the same way, so it
 * is the spelling a second construction site is most likely to arrive in.
 * Without this, an aliased site reads as "no BrowserWindow here" and the sweep
 * reports it as ABSENT rather than as unreviewed.
 */
function browserWindowLocalNames(source: SourceFile): Set<string> {
  const names = new Set<string>(["BrowserWindow"]);
  const visit = (node: Node): void => {
    addRenamedImportBinding(node, names);
    addRenamedDestructureBinding(node, names);
    forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/**
 * Whether a `new <expr>(...)` callee names `BrowserWindow`.
 *
 * Matches the bare identifier, a renamed import's local name, and the
 * PROPERTY-ACCESS spelling `new electron.BrowserWindow(...)`. The last one is
 * not hypothetical: `window.ts` already imports the default export alongside the
 * named ones and destructures off it, so the property-access form is a one-line
 * rewrite. An identifier-only match would let a second, unreviewed renderer
 * trust boundary open in a sibling module while the whole-tree scan stayed green.
 */
function namesBrowserWindow(callee: Node, localNames: Set<string>): boolean {
  if (isIdentifier(callee)) {
    return localNames.has(callee.text);
  }
  if (isPropertyAccessExpression(callee)) {
    return callee.name.text === "BrowserWindow";
  }
  return false;
}

/**
 * The static text of a property key, or `undefined` when it has none.
 *
 * Identifier and string-literal keys resolve; a COMPUTED key does not, and
 * returning `undefined` for it is deliberate — the callers treat an unresolvable
 * key as "not the key I am looking for" rather than guessing, and the object
 * literals that matter here separately reject any spelling that is not a plain
 * `key: value` assignment, so an unresolvable key cannot slip past both.
 */
/** `import { BrowserWindow as Win } from "electron"` → adds `Win`. */
function addRenamedImportBinding(node: Node, names: Set<string>): void {
  if (!isImportDeclaration(node)) {
    return;
  }
  const bindings = node.importClause?.namedBindings;
  if (!(bindings && isNamedImports(bindings))) {
    return;
  }
  for (const element of bindings.elements) {
    if (element.propertyName?.text === "BrowserWindow") {
      names.add(element.name.text);
    }
  }
}

/** `const { BrowserWindow: Win } = electron` → adds `Win`. */
function addRenamedDestructureBinding(node: Node, names: Set<string>): void {
  if (!(isVariableDeclaration(node) && isObjectBindingPattern(node.name))) {
    return;
  }
  for (const element of node.name.elements) {
    if (
      element.propertyName &&
      propertyKeyText(element.propertyName) === "BrowserWindow" &&
      isIdentifier(element.name)
    ) {
      names.add(element.name.text);
    }
  }
}

function propertyKeyText(name: PropertyName): string | undefined {
  if (isIdentifier(name)) {
    return name.text;
  }
  if (isStringLiteralLike(name)) {
    return name.text;
  }
  if (isComputedPropertyName(name) && isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return undefined;
}

/**
 * Collect the `webPreferences` value of ONE object literal, throwing on every
 * spelling that cannot be read as an inline object literal.
 *
 * Keyed on the property NAME first and the node shape second, which is the whole
 * point. Matching `isPropertyAssignment(node) && key === "webPreferences"` reads
 * as thorough and is not: a shorthand `{ webPreferences }` is a
 * `ShorthandPropertyAssignment`, a getter is a `GetAccessorDeclaration`, and
 * neither is a `PropertyAssignment` — so the branch is never entered, nothing is
 * collected, nothing throws, and every caller downstream reads green over a
 * literal it never saw. Chromium does not care which spelling was used.
 */
function collectWebPreferencesOf(
  literal: ObjectLiteralExpression,
  module: string,
  source: SourceFile,
  found: LocatedWebPreferences[]
): void {
  for (const property of literal.properties) {
    if (isSpreadAssignment(property)) {
      continue;
    }
    if (propertyKeyText(property.name) !== "webPreferences") {
      continue;
    }
    if (
      !(
        isPropertyAssignment(property) &&
        isObjectLiteralExpression(property.initializer)
      )
    ) {
      throw new Error(
        `webPreferences must be an inline object literal to be checked structurally, but ${module} writes it as \`${property.getText(source)}\``
      );
    }
    found.push({ module, source, literal: property.initializer });
  }
}
