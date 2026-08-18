import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript6";
import { forEachNode, parseTypeScriptFile } from "./ts-ast.js";

/**
 * ISS-5303 — structural wiring assertions for the `apps/desktop/scripts/*`
 * entrypoints (`.mjs`, `.cjs` and `.mts` alike).
 *
 * Several of those scripts do their whole job at module scope: importing one
 * downloads a ~100 MB Electron zip, another deletes the operator's real
 * database, a third spawns the entire desktop suite fifty times. None of them
 * can be imported or driven from a test, so when a pure helper is extracted out
 * of one, nothing behavioral proves the shell still USES the extracted helper —
 * a lib test stays green next to an entrypoint that quietly kept its own copy.
 *
 * These predicates close that hole with the sanctioned `ts.createSourceFile`
 * mechanism (AGENTS.md → Test Practices; never a raw-text scan). The TypeScript
 * parser reads `.mjs`/`.cjs` as JavaScript and `.mts` as TypeScript, so the same
 * plumbing works on all three. Parent pointers are off, so everything resolves
 * through `.text`, not `getText()`.
 */

const SCRIPTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts"
);

/** Parse `apps/desktop/scripts/<fileName>` into a `SourceFile`. */
export function parseDesktopScript(fileName: string): ts.SourceFile {
  return parseTypeScriptFile(path.join(SCRIPTS_DIR, fileName));
}

/**
 * Names imported from `moduleSpecifier`, sorted. Empty when the module is not
 * imported at all — which is exactly the revert this exists to catch.
 */
export function namedImportsFrom(
  source: ts.SourceFile,
  moduleSpecifier: string
): string[] {
  const names: string[] = [];
  forEachNode(source, (node) => {
    if (
      !(
        ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      ) ||
      node.moduleSpecifier.text !== moduleSpecifier
    ) {
      return;
    }
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      names.push(...bindings.elements.map((element) => element.name.text));
    }
  });
  return names.sort();
}

/**
 * Every `function name(...)` declared anywhere in the file. A local
 * redeclaration shadows the import, so the extracted lib could be wrong — or
 * deleted — while the script kept working and its lib test kept passing.
 */
export function declaredFunctionNames(source: ts.SourceFile): string[] {
  const names: string[] = [];
  forEachNode(source, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      names.push(node.name.text);
    }
  });
  return names;
}

/**
 * Every bare `name(...)` call site. Importing a helper is not using it; this is
 * what distinguishes a live call from an import lint has not yet flagged.
 */
export function calledIdentifiers(source: ts.SourceFile): string[] {
  const names: string[] = [];
  forEachNode(source, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      names.push(node.expression.text);
    }
  });
  return names;
}

/**
 * The CommonJS counterpart of {@link namedImportsFrom}: names destructured out
 * of `require("<moduleSpecifier>")`, sorted.
 *
 * `generate-icons.cjs` is the one `.cjs` entrypoint in this set, so it binds its
 * lib with `const { a, b } = require("./x-lib.cjs")` rather than an import
 * declaration — `namedImportsFrom` sees nothing there and would report a
 * re-inlined helper as correctly wired. Local binding names are returned (the
 * `b` of `{ a: b }`), matching what `namedImportsFrom` reports for `a as b`, so
 * the shadow and call-site checks compose with either module system. A
 * whole-module binding (`const lib = require(...)`) contributes no names: this
 * asks which helpers are bound, not whether the file was touched.
 */
export function requiredNamesFrom(
  source: ts.SourceFile,
  moduleSpecifier: string
): string[] {
  const names: string[] = [];
  forEachNode(source, (node) => {
    if (!ts.isVariableDeclaration(node) || node.initializer === undefined) {
      return;
    }
    if (
      !(
        isRequireCallOf(node.initializer, moduleSpecifier) &&
        ts.isObjectBindingPattern(node.name)
      )
    ) {
      return;
    }
    for (const element of node.name.elements) {
      if (ts.isIdentifier(element.name)) {
        names.push(element.name.text);
      }
    }
  });
  return names.sort();
}

/**
 * Every `<objectName>.<prop>` read in the file, sorted and de-duplicated.
 *
 * Importing a const-object contract and then comparing against the WRONG member
 * of it is silent: the import assertion passes, the call assertion passes, and
 * the entrypoint's decision has changed. This is what pins which member the
 * shell actually branches on.
 */
export function accessedProperties(
  source: ts.SourceFile,
  objectName: string
): string[] {
  const properties = new Set<string>();
  forEachNode(source, (node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === objectName
    ) {
      properties.add(node.name.text);
    }
  });
  return [...properties].sort();
}

/**
 * Numeric literal arguments of each `calleeName(...)` call, one entry per call
 * site, in source order.
 *
 * Lets a lib test derive the inputs the entrypoint actually passes instead of
 * asserting against a second, hand-maintained copy of them — the difference
 * between "covered at some sizes" and "covered at every size this shell uses".
 */
export function numericArgumentsOf(
  source: ts.SourceFile,
  calleeName: string
): number[][] {
  const perCall: number[][] = [];
  forEachNode(source, (node) => {
    if (
      !(ts.isCallExpression(node) && ts.isIdentifier(node.expression)) ||
      node.expression.text !== calleeName
    ) {
      return;
    }
    const numbers: number[] = [];
    for (const argument of node.arguments) {
      if (ts.isNumericLiteral(argument)) {
        numbers.push(Number(argument.text));
      }
    }
    perCall.push(numbers);
  });
  return perCall;
}

/** Whether `node` is `require("<moduleSpecifier>")`. */
function isRequireCallOf(node: ts.Node, moduleSpecifier: string): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require" &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0]) &&
    node.arguments[0].text === moduleSpecifier
  );
}
