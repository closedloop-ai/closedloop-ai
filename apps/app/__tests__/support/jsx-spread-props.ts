import { readFileSync } from "node:fs";
import ts from "typescript6";
import { resolveModuleFile } from "./resolve-workspace-module";

/**
 * ISS-9223 — the prop names a `{...expr}` on a JSX mount actually contributes.
 *
 * The host↔surface seam could refuse every spread, because no production host
 * had one. The surface→`GridTableV2` seam one layer down cannot: both list
 * surfaces spread, and for opposite reasons — Branches builds one `gridProps`
 * object and mounts twice off it, Sessions picks between two whole named prop
 * shapes per flag so the CLOSED shape is written down rather than implied. A
 * seam that refused both would be unguardable, and a seam that read them as
 * "supplies nothing" would report every capability as dropped.
 *
 * REFUSES RATHER THAN GUESSES, exactly as the differ around it does. Only four
 * shapes resolve — an object literal, an identifier bound to one, a ternary
 * between two, and those wrapped in `as const` or parentheses — and every other
 * expression throws. An under-read prop set is the failure this whole guard
 * exists to stop, so a reader that quietly returned the keys it happened to
 * understand would be the silence one level up.
 *
 * A CONDITIONAL contributes the INTERSECTION of its branches, matching the
 * differ's own rule for a host that mounts on several branches: a prop only one
 * branch carries is a prop the reader does not always get.
 */
export function spreadPropNames(
  expression: ts.Expression,
  source: ts.SourceFile,
  describeHost: () => string,
  // Names already followed on this chain. `var a = b; var b = a;` typechecks
  // (no TDZ on `var`), and without this the walk recurses until the stack
  // overflows with a RangeError instead of the refusal every other unresolvable
  // shape here produces.
  seen: ReadonlySet<string> = new Set()
): ReadonlySet<string> {
  const inner = unwrap(expression);
  if (ts.isObjectLiteralExpression(inner)) {
    return objectLiteralKeys(inner, source, describeHost, seen);
  }
  if (ts.isConditionalExpression(inner)) {
    return intersect(
      spreadPropNames(inner.whenTrue, source, describeHost, seen),
      spreadPropNames(inner.whenFalse, source, describeHost, seen)
    );
  }
  if (ts.isIdentifier(inner)) {
    if (seen.has(inner.text)) {
      throw new Error(
        `surface-capability-parity: ${describeHost()} spreads "${inner.text}", whose initializer refers back to itself, so which capabilities it supplies cannot be read. Pass them by name.`
      );
    }
    // ISS-11472 put a SHARED prop set behind one exported constant, so the band
    // that spreads it declares nothing locally. Follow the import when the
    // caller parsed with a real path; the declaring module is then read the same
    // way this one was, and every refusal below still applies inside it.
    const declaring = importedFrom(inner.text, source, describeHost) ?? {
      initializer: soleInitializerOf(inner.text, source, describeHost),
      source,
    };
    return spreadPropNames(
      declaring.initializer,
      declaring.source,
      describeHost,
      new Set([...seen, inner.text])
    );
  }
  throw new Error(
    `surface-capability-parity: ${describeHost()} spreads an expression the check cannot resolve to a prop set. Pass the props by name, or spread a named object literal declared in the same module.`
  );
}

function unwrap(expression: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expression)) {
    return unwrap(expression.expression);
  }
  if (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
    return unwrap(expression.expression);
  }
  return expression;
}

function objectLiteralKeys(
  literal: ts.ObjectLiteralExpression,
  source: ts.SourceFile,
  describeHost: () => string,
  seen: ReadonlySet<string>
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) {
      for (const name of spreadPropNames(
        property.expression,
        source,
        describeHost,
        seen
      )) {
        names.add(name);
      }
      continue;
    }
    if (!property.name || ts.isComputedPropertyName(property.name)) {
      throw new Error(
        `surface-capability-parity: ${describeHost()} spreads an object with a computed or unnamed key, so which capabilities it supplies cannot be read. Pass them by name.`
      );
    }
    names.add(property.name.getText(source));
  }
  return names;
}

/**
 * The ONE `const name = …` initializer in this module, at any scope.
 *
 * Two declarations of the same name is a refusal rather than a pick: one of
 * them shadows the other at the mount and nothing here knows which, so
 * answering with either would be a guess about the supplied set.
 */
function soleInitializerOf(
  name: string,
  source: ts.SourceFile,
  describeHost: () => string
): ts.Expression {
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      found.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  const [only] = found;
  if (!only || found.length > 1) {
    throw new Error(
      `surface-capability-parity: ${describeHost()} spreads "${name}", which this module declares ${found.length} times, so which capabilities it supplies cannot be read. Pass them by name.`
    );
  }
  return only;
}

function intersect(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>
): ReadonlySet<string> {
  const shared = new Set<string>();
  for (const name of left) {
    if (right.has(name)) {
      shared.add(name);
    }
  }
  return shared;
}

/**
 * The exported `const <name> = …` in the module `source` imports `name` from, or
 * nothing when the name is local, the specifier does not resolve, or the parse
 * carried no real path.
 *
 * Nothing is guessed: an unresolvable import returns `undefined` and the caller
 * falls back to the same-module lookup, whose refusal message is unchanged.
 */
function importedFrom(
  name: string,
  source: ts.SourceFile,
  describeHost: () => string
): { initializer: ts.Expression; source: ts.SourceFile } | undefined {
  const specifier = importSpecifierFor(name, source);
  if (!specifier) {
    return undefined;
  }
  const resolved = resolveModuleFile(source.fileName, specifier);
  if (!resolved) {
    return undefined;
  }
  const declaring = ts.createSourceFile(
    resolved,
    readFileSync(resolved, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const initializer = soleInitializerOf(name, declaring, describeHost);
  return { initializer, source: declaring };
}

/** The module specifier `name` is imported from in `source`, if it is. */
function importSpecifierFor(
  name: string,
  source: ts.SourceFile
): string | undefined {
  for (const statement of source.statements) {
    if (
      !(
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      )
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!(bindings && ts.isNamedImports(bindings))) {
      continue;
    }
    for (const element of bindings.elements) {
      if (element.name.text === name) {
        return statement.moduleSpecifier.text;
      }
    }
  }
  return undefined;
}
