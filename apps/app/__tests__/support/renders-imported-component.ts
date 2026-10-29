import ts from "typescript6";

/**
 * Whether `code` renders the component `moduleSpecifier` exports as
 * `exportName`, resolving the IMPORTED BINDING rather than a literal tag name so
 * an aliased import cannot hide it.
 *
 * Read from the AST, not text-scanned: `no-raw-text-source-scan` bans scanning
 * implementation source and points at `ts.createSourceFile`. It matters beyond
 * compliance for the root layout, whose docstrings name components in prose —
 * exactly what a text scan false-positives on.
 *
 * Shared by the root-layout wiring suites (RUM view tracking, ISS-6383; query
 * cache identity, ISS-7442), which assert the same property about the same file
 * and would otherwise each carry their own copy of this walk.
 */
export function rendersImportedComponent(
  code: string,
  moduleSpecifier: string,
  exportName: string
): boolean {
  return renderedPositionOf(code, moduleSpecifier, exportName) !== undefined;
}

/**
 * Source offset of the first JSX tag rendering that imported binding, or
 * `undefined` when it is never rendered.
 *
 * Offsets order siblings: React renders them in source order, so a component
 * whose job is to run BEFORE its siblings can be pinned by comparing two of
 * these rather than by asserting a tag exists somewhere in the file.
 */
export function renderedPositionOf(
  code: string,
  moduleSpecifier: string,
  exportName: string
): number | undefined {
  const source = ts.createSourceFile(
    "layout.tsx",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const locals = localNamesFor(source, moduleSpecifier, exportName);
  let earliest: number | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName.getText(source);
      if (locals.has(tag)) {
        const start = node.getStart(source);
        if (earliest === undefined || start < earliest) {
          earliest = start;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return earliest;
}

/** Local binding names a module's named export is imported under, aliases included. */
export function localNamesFor(
  source: ts.SourceFile,
  moduleSpecifier: string,
  exportName: string
): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (
      !(
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) ||
      statement.moduleSpecifier.text !== moduleSpecifier
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!(bindings && ts.isNamedImports(bindings))) {
      continue;
    }
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === exportName) {
        names.add(element.name.text);
      }
    }
  }
  return names;
}
