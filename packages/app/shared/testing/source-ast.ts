// gardener-support: test and story data, not shipped
/**
 * AST primitives for structural source guards (FEA-4112).
 *
 * AGENTS.md → "Test Practices": a unit test must not read TypeScript source and
 * assert on the raw text. Parsing the file with `ts.createSourceFile` and
 * asserting on the resolved AST is the sanctioned mechanism for structural
 * boundary invariants ("module X must not import Y") — it is immune to comments
 * and resilient to reformatting, neither of which is true of a regex over the
 * file text.
 *
 * Test-only: this module pulls `node:fs` and the TypeScript compiler, so it must
 * never be imported from shipped component code.
 */
import { readFileSync } from "node:fs";
import ts from "typescript6";

export type SourceImport = {
  /**
   * For a string-literal specifier, its VALUE. For a computed one
   * (`import(moduleName)`), the source text of the expression instead — which
   * can never equal a real module path, so a "must not import Y" guard is
   * unaffected while a "declares no edges" guard still sees the edge.
   */
  specifier: string;
  /**
   * True when the specifier is not a string literal, so no module path can be
   * resolved from the source alone. A computed load is still reported: dropping
   * it would let `import(moduleName)` sail past a no-edges guard.
   */
  computed: boolean;
  /**
   * Imported binding names. Aliased named imports report the ORIGINAL name
   * (`import { a as b }` → `a`), since that is the contract being guarded.
   * Empty for `export … from` and bare/dynamic loads.
   */
  names: string[];
};

/** Parse a `.ts`/`.tsx` file into a `ts.SourceFile`. */
export function parseSourceFileAt(absolutePath: string): ts.SourceFile {
  const scriptKind = absolutePath.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  return ts.createSourceFile(
    absolutePath,
    readFileSync(absolutePath, "utf8"),
    ts.ScriptTarget.Latest,
    false,
    scriptKind
  );
}

/**
 * Every module edge the file declares: static imports, `export … from`
 * re-exports, dynamic `import(…)`, and `require(…)` — so a guard cannot be
 * sidestepped by switching import form, nor by computing the target
 * (`import(moduleName)`), which is reported with `computed: true`.
 */
export function importsOf(sourceFile: ts.SourceFile): SourceImport[] {
  return collectPreOrder(sourceFile, (node) => {
    const specifier = moduleSpecifierOf(node, sourceFile);
    return specifier === undefined
      ? undefined
      : { ...specifier, names: importedNamesOf(node) };
  });
}

/**
 * Every identifier the file mentions, including property-access names
 * (`process.env` → `process`, `env`), JSX attribute names, and type references.
 * Names inside comments are — by construction — not here.
 */
export function identifierNamesIn(sourceFile: ts.SourceFile): string[] {
  return collectPreOrder(sourceFile, (node) =>
    ts.isIdentifier(node) ? node.text : undefined
  );
}

/**
 * Every identifier the file REFERENCES — {@link identifierNamesIn} minus the
 * positions where an identifier is a member NAME rather than a reference to a
 * binding: the right-hand side of a property access, a property or method name
 * in an object literal, type literal, interface, or enum, and a JSX attribute
 * name.
 *
 * Use this for "this module must not touch global X" guards. `identifierNamesIn`
 * reports `process` for `metadata.process` and for `{ process: string }`, so a
 * guard built on it fails a module that never named the Node global at all
 * (whitlockk). `process.env` still reports `process`, because there the identifier
 * IS the reference — only `env` is a member name.
 *
 * It does NOT resolve shadowing: a module declaring its own `const process`
 * still reports the name, because that needs a binder rather than a walk. A
 * guard whose subject is a global should read that as the remaining gap.
 */
export function referencedIdentifierNamesIn(
  sourceFile: ts.SourceFile
): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      names.push(node.text);
      return;
    }
    const memberName = memberNameOf(node);
    node.forEachChild((child) => {
      if (child !== memberName) {
        visit(child);
      }
    });
  };
  visit(sourceFile);
  return names;
}

/**
 * Every string-literal VALUE in the file, including template-literal chunks and
 * module specifiers. Use this for tokens that only make sense as a substring of
 * a literal (route paths, IPC channel names).
 */
export function stringLiteralsIn(sourceFile: ts.SourceFile): string[] {
  return collectPreOrder(sourceFile, (node) =>
    isTextLiteral(node) ? node.text : undefined
  );
}

function moduleSpecifierOf(
  node: ts.Node,
  sourceFile: ts.SourceFile
): ModuleSpecifier | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    // A specifier-less `export { a }` re-exports nothing and is not an edge.
    return node.moduleSpecifier === undefined
      ? undefined
      : specifierOf(node.moduleSpecifier, sourceFile);
  }
  if (isModuleLoadCall(node)) {
    // An argument-less `require()` is still module-load syntax; fall back to
    // the callee so the edge is reported rather than dropped.
    return specifierOf(node.arguments[0] ?? node.expression, sourceFile);
  }
  return undefined;
}

function isModuleLoadCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) {
    return false;
  }
  return (
    node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(node.expression) && node.expression.text === "require")
  );
}

function literalTextOf(node: ts.Node | undefined): string | undefined {
  if (node !== undefined && ts.isStringLiteralLike(node)) {
    return node.text;
  }
  return undefined;
}

function importedNamesOf(node: ts.Node): string[] {
  if (!ts.isImportDeclaration(node)) {
    return [];
  }
  const clause = node.importClause;
  if (clause === undefined) {
    return [];
  }
  const names = clause.name === undefined ? [] : [clause.name.text];
  const bindings = clause.namedBindings;
  if (bindings === undefined) {
    return names;
  }
  if (ts.isNamespaceImport(bindings)) {
    names.push(bindings.name.text);
    return names;
  }
  names.push(
    ...bindings.elements.map(
      (element) => (element.propertyName ?? element.name).text
    )
  );
  return names;
}

function isTextLiteral(node: ts.Node): node is ts.LiteralLikeNode {
  return (
    ts.isStringLiteralLike(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  );
}

/**
 * The one pre-order walk every collector above shares: visit a node, keep
 * whatever `pick` returns for it, then recurse. Pre-order and depth-first, so
 * results come back in source order — which is what the guards read like.
 */
function collectPreOrder<T>(
  sourceFile: ts.SourceFile,
  pick: (node: ts.Node) => T | undefined
): T[] {
  const collected: T[] = [];
  const visit = (node: ts.Node): void => {
    const picked = pick(node);
    if (picked !== undefined) {
      collected.push(picked);
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return collected;
}

/** A resolved module edge before its imported names are attached. */
type ModuleSpecifier = Omit<SourceImport, "names">;

/**
 * Reads one specifier position. A string literal reports its value; anything
 * else — an identifier, a template with substitutions, a call — reports its
 * source text and is flagged `computed`, because the alternative is dropping
 * the edge and letting the load form defeat the guard.
 */
function specifierOf(
  node: ts.Node,
  sourceFile: ts.SourceFile
): ModuleSpecifier {
  const literal = literalTextOf(node);
  return literal === undefined
    ? { computed: true, specifier: node.getText(sourceFile) }
    : { computed: false, specifier: literal };
}

/**
 * The child of `node` that is a member NAME rather than a reference to a
 * binding, or `undefined` when the node has none.
 *
 * A SHORTHAND property (`{ process }`) is deliberately absent: there the single
 * identifier is both the key and the reference, so skipping it would drop a real
 * use of the binding.
 *
 * A COMPUTED name (`{ [process]: v }`) is absent for the same reason: the
 * brackets are evaluated, so every identifier inside them READS a binding. The
 * name positions that ARE member names — `a.b`, a qualified type name, a JSX
 * attribute — cannot be computed, so this only arises on the property, method,
 * and enum-member branch.
 */
function memberNameOf(node: ts.Node): ts.Node | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name;
  }
  if (ts.isQualifiedName(node)) {
    return node.right;
  }
  if (ts.isJsxAttribute(node)) {
    return node.name;
  }
  if (
    ts.isPropertyAssignment(node) ||
    ts.isPropertySignature(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isEnumMember(node)
  ) {
    // Returning the `ComputedPropertyName` wrapper would make the walk skip the
    // bracketed expression with it, silently dropping a real read of the
    // binding. Yielding it instead lets the walk descend, where `[Foo.bar]`
    // resolves through the property-access branch above and a LITERAL key
    // (`["process"]`, `[0]`) contributes nothing, because only identifiers are
    // collected (tamsinb review on PR #7206).
    return ts.isComputedPropertyName(node.name) ? undefined : node.name;
  }
  return undefined;
}
