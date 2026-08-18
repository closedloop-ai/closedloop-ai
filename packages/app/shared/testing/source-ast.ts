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
  /** The module specifier exactly as written. */
  specifier: string;
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
 * sidestepped by switching import form.
 */
export function importsOf(sourceFile: ts.SourceFile): SourceImport[] {
  return collectPreOrder(sourceFile, (node) => {
    const specifier = moduleSpecifierOf(node);
    return specifier === undefined
      ? undefined
      : { specifier, names: importedNamesOf(node) };
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
 * Every string-literal VALUE in the file, including template-literal chunks and
 * module specifiers. Use this for tokens that only make sense as a substring of
 * a literal (route paths, IPC channel names).
 */
export function stringLiteralsIn(sourceFile: ts.SourceFile): string[] {
  return collectPreOrder(sourceFile, (node) =>
    isTextLiteral(node) ? node.text : undefined
  );
}

function moduleSpecifierOf(node: ts.Node): string | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return literalTextOf(node.moduleSpecifier);
  }
  if (isModuleLoadCall(node)) {
    return literalTextOf(node.arguments[0]);
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
