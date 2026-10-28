import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

const EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  "/index.ts",
  "/index.tsx",
];
const SPACE = /\s+/g;
const EXCLUDED_SOURCE =
  /(?:^|\/)(?:node_modules|__tests__|__mocks__|test|tests|fixtures|storybook)(?:\/|$)|(?:^|[/.-])(?:test|spec|stories|fixtures|mocks?|sample)(?:[/.-]|$)/;

export function sourceResolver(root, read = readFileSync) {
  const files = new Map();
  function source(file, contents) {
    if (contents !== undefined || !files.has(file)) {
      files.set(
        file,
        ts.createSourceFile(
          file,
          contents ?? read(file, "utf8"),
          ts.ScriptTarget.Latest,
          true
        )
      );
    }
    return files.get(file);
  }
  function imported(specifier, from) {
    let base;
    if (specifier.startsWith(".")) {
      base = path.resolve(path.dirname(from), specifier);
    } else if (specifier.startsWith("@repo/")) {
      base = path.join(root, "packages", specifier.slice(6));
    } else if (specifier.startsWith("@/")) {
      const app = from
        .split(`${path.sep}apps${path.sep}`)[1]
        ?.split(path.sep)[0];
      if (!app) {
        return null;
      }
      base = path.join(
        root,
        "apps",
        app,
        app === "desktop" ? "src/renderer" : "",
        specifier.slice(2)
      );
    } else {
      return null;
    }
    return (
      EXTENSIONS.map((extension) => base + extension).find(
        (file) =>
          isProductLabelSource(file) && existsSync(file) && path.extname(file)
      ) ?? null
    );
  }
  function binding(name, node) {
    for (let scope = node.parent; scope; scope = scope.parent) {
      if (dynamicScopeBinds(scope, name)) {
        return null;
      }
      const parameter = parameterBinding(scope, name);
      if (parameter !== undefined) {
        return parameter;
      }
      const statements = scopeStatements(scope);
      for (const statement of statements) {
        const local = localBinding(statement, name);
        if (local !== undefined) {
          return local;
        }
        const importedValue = importBinding(statement, name, node);
        if (importedValue !== undefined) {
          return importedValue;
        }
      }
    }
    return null;
  }
  function parameterBinding(scope, name) {
    if (!ts.isFunctionLike(scope)) {
      return undefined;
    }
    const parameter = scope.parameters.find((item) =>
      boundNames(item.name).includes(name)
    );
    return parameter ? mapBinding(scope, parameter, name) : undefined;
  }
  function importBinding(statement, name, node) {
    if (!ts.isImportDeclaration(statement)) {
      return undefined;
    }
    const imports = statement.importClause?.namedBindings;
    if (!(imports && ts.isNamedImports(imports))) {
      return undefined;
    }
    const match = imports.elements.find(
      (element) => element.name.text === name
    );
    if (!match) {
      return undefined;
    }
    const file = imported(
      statement.moduleSpecifier.text,
      node.getSourceFile().fileName
    );
    if (!file) {
      return null;
    }
    return exported(source(file), match.propertyName?.text ?? match.name.text);
  }
  function mapBinding(callback, parameter, name) {
    const call = callback.parent;
    if (
      !ts.isCallExpression(call) ||
      call.arguments[0] !== callback ||
      callback.parameters[0] !== parameter ||
      !safeReferences(parameter.name, callback)
    ) {
      return null;
    }
    if (
      !ts.isPropertyAccessExpression(call.expression) ||
      call.expression.name.text !== "map"
    ) {
      return null;
    }
    const items = arrayItems(call.expression.expression, new Set([callback]));
    if (!items) {
      return null;
    }
    if (ts.isIdentifier(parameter.name)) {
      return items;
    }
    if (!ts.isObjectBindingPattern(parameter.name)) {
      return null;
    }
    const element = parameter.name.elements.find(
      (item) => ts.isIdentifier(item.name) && item.name.text === name
    );
    if (!element || element.dotDotDotToken || element.initializer) {
      return null;
    }
    const key = element.propertyName ?? element.name;
    if (!(ts.isIdentifier(key) || ts.isStringLiteral(key))) {
      return null;
    }
    return properties(items, [key.text], new Set());
  }
  function arrayItems(node, seen) {
    const arrays = materialize(node, seen);
    if (!arrays) {
      return null;
    }
    const results = [];
    for (const array of arrays) {
      if (!ts.isArrayLiteralExpression(array)) {
        return null;
      }
      for (const element of array.elements) {
        const items = ts.isSpreadElement(element)
          ? arrayItems(element.expression, seen)
          : [element];
        if (!items) {
          return null;
        }
        results.push(...items);
      }
    }
    return results;
  }
  function safeBinding(node) {
    return safeReferences(node, node.getSourceFile())
      ? binding(node.text, node)
      : null;
  }
  function materialize(node, seen = new Set()) {
    if (!node || seen.has(node)) {
      return null;
    }
    const next = new Set(seen).add(node);
    if (Array.isArray(node)) {
      return union(node.map((item) => materialize(item, next)));
    }
    if (ts.isIdentifier(node)) {
      return materialize(safeBinding(node), next);
    }
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node)
    ) {
      return materialize(node.expression, next);
    }
    if (ts.isConditionalExpression(node)) {
      return union([
        materialize(node.whenTrue, next),
        materialize(node.whenFalse, next),
      ]);
    }
    if (ts.isPropertyAccessExpression(node)) {
      return properties(
        materialize(node.expression, next),
        [node.name.text],
        next
      );
    }
    if (ts.isElementAccessExpression(node)) {
      return properties(
        materialize(node.expression, next),
        values(node.argumentExpression, next),
        next
      );
    }
    // A filter preserves provenance only when its callback cannot mutate or
    // expose its elements to unknown code.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "filter" &&
      safeArrayCallback(node)
    ) {
      return materialize(node.expression.expression, next);
    }
    return [node];
  }
  function properties(objects, keys, seen) {
    if (!(objects && keys) || keys.length === 0) {
      return null;
    }
    return union(
      objects.flatMap((object) =>
        keys.map((key) => property(object, key, seen))
      )
    );
  }
  function property(object, key, seen) {
    const resolved = materialize(object, seen);
    if (!resolved) {
      return null;
    }
    if (resolved.length !== 1 || resolved[0] !== object) {
      return properties(resolved, [key], seen);
    }
    if (!ts.isObjectLiteralExpression(object)) {
      return null;
    }
    for (const member of [...object.properties].reverse()) {
      const value = memberValue(member, key, seen);
      if (value !== undefined) {
        return value;
      }
    }
    return null;
  }
  function memberValue(member, key, seen) {
    if (ts.isSpreadAssignment(member) || !member.name) {
      return null;
    }
    const names = ts.isComputedPropertyName(member.name)
      ? values(member.name.expression, seen)
      : [member.name.text];
    if (!names) {
      return null;
    }
    if (!names.includes(key)) {
      return undefined;
    }
    if (ts.isPropertyAssignment(member)) {
      return materialize(member.initializer, seen);
    }
    if (ts.isShorthandPropertyAssignment(member)) {
      return materialize(member.name, seen);
    }
    return null;
  }
  function exported(file, name) {
    for (const statement of file.statements) {
      if (
        !(
          ts.isVariableStatement(statement) &&
          isConst(statement.declarationList)
        )
      ) {
        continue;
      }
      if (
        !statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
        )
      ) {
        continue;
      }
      const declaration = statement.declarationList.declarations.find(
        (item) => ts.isIdentifier(item.name) && item.name.text === name
      );
      if (declaration) {
        // Exported aggregate values can be mutated by other modules. Primitive
        // literal exports are immutable; aggregates fail closed.
        const initializer = declaration.initializer;
        return initializer && literalValues(unwrap(initializer)) !== undefined
          ? initializer
          : null;
      }
    }
    return null;
  }
  function values(node, seen = new Set()) {
    if (!node || seen.has(node)) {
      return null;
    }
    const next = new Set(seen).add(node);
    if (Array.isArray(node)) {
      return union(node.map((item) => values(item, next)));
    }
    const literal = literalValues(node);
    if (literal !== undefined) {
      return literal;
    }
    if (ts.isJsxExpression(node)) {
      return node.expression ? values(node.expression, next) : [""];
    }
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node)
    ) {
      return values(node.expression, next);
    }
    if (ts.isIdentifier(node)) {
      return values(binding(node.text, node), next);
    }
    return expressionValues(node, seen, next);
  }
  function expressionValues(node, seen, next) {
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const nodes = materialize(node, seen);
      return nodes ? union(nodes.map((item) => values(item, next))) : null;
    }
    if (ts.isConditionalExpression(node)) {
      const yes = values(node.whenTrue, next);
      const no = values(node.whenFalse, next);
      return yes && no ? [...new Set([...yes, ...no])] : null;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      return join(values(node.left, next), values(node.right, next));
    }
    return null;
  }
  return { source, values, dependencies: () => [...files.keys()] };
}

export function join(left, right) {
  if (!(left && right) || left.length * right.length > 64) {
    return null;
  }
  return [...new Set(left.flatMap((a) => right.map((b) => a + b)))];
}

function boundNames(name) {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }
  return name.elements.flatMap((element) =>
    ts.isBindingElement(element) ? boundNames(element.name) : []
  );
}

function scopeStatements(scope) {
  if (ts.isSourceFile(scope) || ts.isBlock(scope)) {
    return scope.statements;
  }
  if (ts.isCaseBlock(scope)) {
    return scope.clauses.flatMap((clause) => [...clause.statements]);
  }
  return [];
}

function union(groups) {
  if (groups.some((group) => group === null)) {
    return null;
  }
  return [...new Set(groups.flat())];
}

function isConst(declarations) {
  // biome-ignore lint/suspicious/noBitwiseOperators: TypeScript exposes declaration kind as a flag mask.
  return (declarations.flags & ts.NodeFlags.Const) !== 0;
}

function localBinding(statement, name) {
  if (
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
    statement.name?.text === name
  ) {
    return null;
  }
  if (!ts.isVariableStatement(statement)) {
    return undefined;
  }
  const declaration = statement.declarationList.declarations.find((item) =>
    boundNames(item.name).includes(name)
  );
  if (!declaration) {
    return undefined;
  }
  return ts.isIdentifier(declaration.name) && isConst(statement.declarationList)
    ? (declaration.initializer ?? null)
    : null;
}

function dynamicScopeBinds(scope, name) {
  if (ts.isCatchClause(scope)) {
    return (
      scope.variableDeclaration &&
      boundNames(scope.variableDeclaration.name).includes(name)
    );
  }
  if (
    !(
      ts.isForStatement(scope) ||
      ts.isForOfStatement(scope) ||
      ts.isForInStatement(scope)
    )
  ) {
    return false;
  }
  if (!(scope.initializer && ts.isVariableDeclarationList(scope.initializer))) {
    return false;
  }
  return scope.initializer.declarations.some((item) =>
    boundNames(item.name).includes(name)
  );
}

function literalValues(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [node.text];
  }
  if (ts.isJsxText(node)) {
    return [node.text.replace(SPACE, " ")];
  }
  if (
    [
      ts.SyntaxKind.NullKeyword,
      ts.SyntaxKind.FalseKeyword,
      ts.SyntaxKind.TrueKeyword,
    ].includes(node.kind)
  ) {
    return [""];
  }
  return undefined;
}

export function isProductLabelSource(file) {
  return !EXCLUDED_SOURCE.test(file.replaceAll(path.sep, "/"));
}

function unwrap(input) {
  let node = input;
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

function safeArrayCallback(call) {
  const callback = call.arguments[0];
  return (
    !!callback &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
    callback.parameters.every((parameter) =>
      safeReferences(parameter.name, callback)
    )
  );
}

// A const binding does not make its objects immutable. Reject writes, aliases,
// exports and unknown calls anywhere in the binding's file (including closures).
// This deliberately fails closed on shadowed names rather than guessing identity.
function safeReferences(bindingName, scope) {
  const names = new Set(boundNames(bindingName));
  let safe = true;
  function visit(node) {
    if (!safe) {
      return;
    }
    if (ts.isIdentifier(node) && names.has(node.text) && !safeReference(node)) {
      safe = false;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(scope);
  return safe;
}

function safeReference(node) {
  const parent = node.parent;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent)) &&
    parent.name === node
  ) {
    return !(
      ts.isVariableDeclaration(parent) &&
      parent.parent.parent.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
      )
    );
  }
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    ts.isImportSpecifier(parent)
  ) {
    return true;
  }
  const access = referenceAccess(node);
  const use = access.parent;
  if (
    ts.isBinaryExpression(use) &&
    use.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    use.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return false;
  }
  if (
    ts.isDeleteExpression(use) ||
    ts.isPostfixUnaryExpression(use) ||
    ts.isPrefixUnaryExpression(use)
  ) {
    return false;
  }
  if (ts.isCallExpression(use) && use.expression === access) {
    return (
      ts.isPropertyAccessExpression(access) &&
      ["map", "filter"].includes(access.name.text) &&
      safeArrayCallback(use)
    );
  }
  if (
    ts.isBinaryExpression(use) &&
    [
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(use.operatorToken.kind)
  ) {
    return false;
  }
  return safeReadContext(use);
}

function safeReadContext(use) {
  // Filter consumes predicate results as booleans; returning a nested object
  // here cannot expose it outside the callback as a map/ordinary return can.
  if (
    ts.isArrowFunction(use) &&
    ts.isCallExpression(use.parent) &&
    ts.isPropertyAccessExpression(use.parent.expression) &&
    use.parent.expression.name.text === "filter"
  ) {
    return true;
  }
  // Reads inside JSX and predicates are safe. Passing even a property to an
  // unknown function may expose a nested object, so aliases/arguments fail closed.
  return !(
    ts.isCallExpression(use) ||
    ts.isNewExpression(use) ||
    ts.isVariableDeclaration(use) ||
    ts.isPropertyAssignment(use) ||
    ts.isShorthandPropertyAssignment(use) ||
    ts.isSpreadAssignment(use) ||
    ts.isSpreadElement(use) ||
    ts.isArrayLiteralExpression(use) ||
    ts.isJsxSpreadAttribute(use) ||
    (ts.isJsxExpression(use) && ts.isJsxAttribute(use.parent)) ||
    ts.isReturnStatement(use) ||
    ts.isArrowFunction(use) ||
    ts.isYieldExpression(use) ||
    ts.isTaggedTemplateExpression(use) ||
    ts.isExportSpecifier(use) ||
    ts.isExportAssignment(use)
  );
}

function referenceAccess(node) {
  let access = node;
  while (
    ((ts.isPropertyAccessExpression(access.parent) ||
      ts.isElementAccessExpression(access.parent)) &&
      access.parent.expression === access) ||
    ts.isParenthesizedExpression(access.parent) ||
    ts.isAsExpression(access.parent) ||
    ts.isSatisfiesExpression(access.parent) ||
    ts.isConditionalExpression(access.parent)
  ) {
    access = access.parent;
  }
  return access;
}
