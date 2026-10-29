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

/**
 * Argument identifiers of each `calleeName(...)` call, one entry per call site
 * in source order. A non-identifier argument — a literal, a member access, a
 * nested call — is `null`, which no variable name can collide with.
 *
 * The counterpart to {@link calledIdentifiers}: that one proves a helper is
 * still CALLED, this one proves where its result is still USED. A shell can
 * keep calling a helper and quietly pass a literal on to the consumer, which
 * reads as fully wired from a call count alone.
 *
 * Identifier text only, never `getText()` — parent pointers are off on these
 * source files (see the module header).
 */
export function callArgumentIdentifiers(
  source: ts.SourceFile,
  calleeName: string
): (string | null)[][] {
  const perCall: (string | null)[][] = [];
  forEachNode(source, (node) => {
    if (
      !(ts.isCallExpression(node) && ts.isIdentifier(node.expression)) ||
      node.expression.text !== calleeName
    ) {
      return;
    }
    perCall.push(
      node.arguments.map((argument) =>
        ts.isIdentifier(argument) ? argument.text : null
      )
    );
  });
  return perCall;
}

/**
 * Map of `const x = callee(...)` variable name to the callee's name, for every
 * variable in `source` initialized by a direct call.
 *
 * Resolves what an argument NAME was actually bound from, so an assertion can
 * follow a value from its producer to its consumer instead of trusting that a
 * well-named identifier holds what its name suggests.
 */
export function variableInitializerCallees(
  source: ts.SourceFile
): Record<string, string> {
  const byName: Record<string, string> = Object.create(null);
  forEachNode(source, (node) => {
    if (
      !(
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression)
      )
    ) {
      return;
    }
    byName[node.name.text] = node.initializer.expression.text;
  });
  return byName;
}

/**
 * Method names invoked on `receiverPath` — a dotted path such as
 * `process.stdout` or `child.stdout` — sorted and de-duplicated.
 *
 * Which stream API forwards a child's output IS a behaviour: `pipe` pauses the
 * source when the sink stops accepting, a `write` inside a `data` handler
 * queues without a bound. The difference is only observable at runtime as an
 * ABSENCE (bytes that do not arrive, memory that does not grow), which cannot
 * be asserted without a wall-clock wait, so it is pinned structurally instead.
 */
export function methodsCalledOn(
  source: ts.SourceFile,
  receiverPath: string
): string[] {
  const methods = new Set<string>();
  forEachNode(source, (node) => {
    if (
      !(
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      )
    ) {
      return;
    }
    if (dottedName(node.expression.expression) === receiverPath) {
      methods.add(node.expression.name.text);
    }
  });
  return [...methods].sort();
}

/** `a.b.c` as a string, or `null` for anything that is not a plain dotted path. */
function dottedName(node: ts.Node): string | null {
  if (ts.isIdentifier(node)) {
    return node.text;
  }
  if (!(ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name))) {
    return null;
  }
  const receiver = dottedName(node.expression);
  return receiver === null ? null : `${receiver}.${node.name.text}`;
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
