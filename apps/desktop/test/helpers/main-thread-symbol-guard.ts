import { existsSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";
import { collectTsFiles } from "./collect-ts-files.js";
import { parseTypeScriptFile } from "./ts-ast.js";

/**
 * AST plumbing for the guards that keep a blocking function off the Desktop
 * main thread (ISS-11596's binary resolvers, ISS-12120's Keychain probe).
 *
 * A guard names the blocking functions by the module basename that exports
 * them and the file that defines them. {@link collectSymbolUses} binds them the
 * way `scripts/lint/rules/no-desktop-main-sync-exec.ts` binds child-process
 * calls (a named import, aliased or not, a member access on a namespace import,
 * and, inside a defining module, the local declaration) and reports each use
 * with the function it sits in. {@link mainImportClosure} answers which source
 * files the Electron main process actually loads, so a guard can check that a
 * site it allows as "off the main thread" really is.
 */

/** Module basename (as imported, `.js` suffix) to the guarded names it exports. */
export type GuardedModules = Readonly<Record<string, readonly string[]>>;

export type SymbolUse = {
  /** Path under `src`, `/`-separated. */
  file: string;
  /** Name of the innermost named function around the use, or `<module>`. */
  enclosing: string;
  symbol: string;
  line: number;
};

/** Which uses to report: call sites only, or every value reference. */
export const SymbolUseKind = {
  Calls: "calls",
  References: "references",
} as const;
export type SymbolUseKind = (typeof SymbolUseKind)[keyof typeof SymbolUseKind];

type Bindings = {
  named: Map<string, string>;
  namespaces: Map<string, string>;
};

/** Local names bound to each guarded symbol in `source`, plus namespace bindings. */
function guardedBindings(
  source: ts.SourceFile,
  modules: GuardedModules,
  definedHere: readonly string[]
): Bindings {
  const named = new Map<string, string>();
  const namespaces = new Map<string, string>();
  for (const symbol of definedHere) {
    named.set(symbol, symbol);
  }
  for (const statement of source.statements) {
    if (
      !(
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      )
    ) {
      continue;
    }
    const moduleName = path.posix.basename(statement.moduleSpecifier.text);
    const exported = modules[moduleName];
    const clause = statement.importClause;
    if (exported === undefined || clause === undefined || clause.isTypeOnly) {
      continue;
    }
    const bindings = clause.namedBindings;
    if (bindings === undefined) {
      continue;
    }
    if (ts.isNamespaceImport(bindings)) {
      namespaces.set(bindings.name.text, moduleName);
      continue;
    }
    for (const element of bindings.elements) {
      const importedName = (element.propertyName ?? element.name).text;
      if (!element.isTypeOnly && exported.includes(importedName)) {
        named.set(element.name.text, importedName);
      }
    }
  }
  return { named, namespaces };
}

/** The guarded symbol `expression` names, if it names one. */
function guardedSymbol(
  expression: ts.Expression,
  bindings: Bindings,
  modules: GuardedModules
): string | undefined {
  if (ts.isIdentifier(expression)) {
    return bindings.named.get(expression.text);
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression)
  ) {
    const moduleName = bindings.namespaces.get(expression.expression.text);
    const exported = moduleName === undefined ? undefined : modules[moduleName];
    return exported?.find((name) => name === expression.name.text);
  }
  return undefined;
}

/** The name a function-like node is known by, if it has one. */
function functionName(node: ts.Node, parentName: string | null): string | null {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionExpression(node)) &&
    node.name !== undefined &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
  ) {
    return node.name.text;
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    parentName !== null
  ) {
    return parentName;
  }
  return null;
}

/**
 * Whether a child of `parent` can be a value reference. Type positions, import
 * and export clauses, declaration names, object-literal keys and the member
 * name of a property access are not.
 */
function childCanReference(parent: ts.Node, child: ts.Node): boolean {
  if (
    ts.isTypeNode(parent) ||
    ts.isImportDeclaration(parent) ||
    ts.isExportDeclaration(parent) ||
    ts.isInterfaceDeclaration(parent) ||
    ts.isTypeAliasDeclaration(parent)
  ) {
    return false;
  }
  if (ts.isPropertyAccessExpression(parent) && child === parent.name) {
    return false;
  }
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent)) &&
    child === parent.name
  ) {
    return false;
  }
  return !(
    (ts.isFunctionDeclaration(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent)) &&
    child === parent.name
  );
}

/**
 * Collect the uses of the guarded symbols in one parsed file. With
 * `SymbolUseKind.References`, a value passed along (`{ detect }`, `a ?? b`,
 * an argument) counts as well as a call, because a blocking function handed
 * to another module runs wherever that module calls it.
 */
export function collectSymbolUses(
  source: ts.SourceFile,
  relativeFile: string,
  options: {
    modules: GuardedModules;
    definedHere?: readonly string[];
    kind: SymbolUseKind;
  }
): SymbolUse[] {
  const bindings = guardedBindings(
    source,
    options.modules,
    options.definedHere ?? []
  );
  const found: SymbolUse[] = [];
  const stack: string[] = [];
  const references = options.kind === SymbolUseKind.References;
  /** The guarded symbol `node` uses, if it is a use of the requested kind. */
  const symbolUsedBy = (node: ts.Node): string | undefined => {
    if (!references) {
      return ts.isCallExpression(node)
        ? guardedSymbol(node.expression, bindings, options.modules)
        : undefined;
    }
    if (ts.isShorthandPropertyAssignment(node)) {
      return bindings.named.get(node.name.text);
    }
    return ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)
      ? guardedSymbol(node, bindings, options.modules)
      : undefined;
  };
  // `parseTypeScriptFile` builds no parent pointers, so the walk carries the
  // variable name an arrow or function expression is assigned to.
  const visit = (node: ts.Node, assignedName: string | null): void => {
    const symbol = symbolUsedBy(node);
    if (symbol !== undefined) {
      found.push({
        file: relativeFile,
        enclosing: stack.at(-1) ?? "<module>",
        symbol,
        line:
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      });
      // A reference is a leaf; a call still has arguments to walk.
      if (references) {
        return;
      }
    }
    const name = functionName(node, assignedName);
    if (name !== null) {
      stack.push(name);
    }
    ts.forEachChild(node, (child) => {
      if (references && !childCanReference(node, child)) {
        return;
      }
      visit(
        child,
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
          ? node.name.text
          : null
      );
    });
    if (name !== null) {
      stack.pop();
    }
  };
  visit(source, null);
  return found;
}

/** Prisma-generated client code: machine-owned, and it never imports a guarded symbol. */
const GENERATED_SEGMENT = `${path.sep}generated${path.sep}`;
const DECLARATION_FILE = ".d.ts";

/** Parse every source file under `roots`, keyed by its `/`-separated path under `srcDir`. */
export function scanSourceFiles(
  srcDir: string,
  roots: readonly string[]
): { relativeFile: string; source: ts.SourceFile }[] {
  const files: { relativeFile: string; source: ts.SourceFile }[] = [];
  for (const root of roots) {
    for (const file of collectTsFiles(root)) {
      if (file.includes(GENERATED_SEGMENT) || file.endsWith(DECLARATION_FILE)) {
        continue;
      }
      files.push({
        relativeFile: path.relative(srcDir, file).split(path.sep).join("/"),
        source: parseTypeScriptFile(file),
      });
    }
  }
  return files;
}

const RESOLVABLE_EXTENSIONS = [".ts", ".tsx", "/index.ts"] as const;
const JS_SUFFIX = /\.js$/;

function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const base = path
    .resolve(path.dirname(fromFile), specifier)
    .replace(JS_SUFFIX, "");
  for (const extension of RESOLVABLE_EXTENSIONS) {
    if (existsSync(base + extension)) {
      return base + extension;
    }
  }
  return null;
}

/** Whether an import declaration loads its module at runtime. */
function importsAtRuntime(statement: ts.ImportDeclaration): boolean {
  const clause = statement.importClause;
  if (clause === undefined) {
    return true;
  }
  if (clause.isTypeOnly) {
    return false;
  }
  const bindings = clause.namedBindings;
  if (
    clause.name === undefined &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0
  ) {
    return bindings.elements.some((element) => !element.isTypeOnly);
  }
  return true;
}

/** Relative specifiers `source` loads at runtime, dynamic `import("…")` included. */
function runtimeSpecifiers(source: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      importsAtRuntime(node)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

/**
 * Every source file the module at `entry` loads at runtime, transitively,
 * following static imports, re-exports and literal dynamic `import("…")`, and
 * skipping type-only imports. The Desktop main entry loads almost everything
 * through `await import("./startup.js")`, so a static-only walk from it sees a
 * handful of files; this one follows that edge. Absolute paths.
 */
export function mainImportClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    for (const specifier of runtimeSpecifiers(parseTypeScriptFile(file))) {
      const resolved = resolveRelative(file, specifier);
      if (resolved !== null && !seen.has(resolved)) {
        pending.push(resolved);
      }
    }
  }
  return seen;
}
