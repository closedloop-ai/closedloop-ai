/**
 * AST readers for `src/main/composition/desktop-services.ts`.
 *
 * The composition root statically imports `electron`, so it cannot be
 * constructed in a node test at all — which is why the links it owns are
 * guarded through `ts.createSourceFile` rather than by loading the module. This
 * is the sanctioned alternative to a raw text scan
 * (`scripts/lint/rules/no-raw-text-source-scan.ts`).
 *
 * Shared rather than re-declared per suite (ISS-9082): a second copy of these
 * readers is a second definition of what "the composition root passes X" means,
 * and two guards that disagree about that are worse than one.
 */
import { readFileSync } from "node:fs";
import type {
  CallExpression,
  Node,
  ObjectLiteralExpression,
  SourceFile,
} from "typescript6";
import {
  createSourceFile,
  forEachChild,
  isArrowFunction,
  isCallExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  ScriptKind,
  ScriptTarget,
} from "typescript6";

const DESKTOP_SERVICES_PATH = new URL(
  "../src/main/composition/desktop-services.ts",
  import.meta.url
);

export function desktopServicesSource(): SourceFile {
  return createSourceFile(
    "desktop-services.ts",
    readFileSync(DESKTOP_SERVICES_PATH, "utf-8"),
    ScriptTarget.Latest,
    true,
    ScriptKind.TS
  );
}

/** The object literal the first argument of the first `callee(...)` denotes. */
export function calleeArgument(
  callee: string
): ObjectLiteralExpression | undefined {
  let found: ObjectLiteralExpression | undefined;
  const visit = (node: Node): void => {
    if (
      !found &&
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === callee &&
      node.arguments.length > 0
    ) {
      found = objectLiteralArgument(node.arguments[0]);
    }
    forEachChild(node, visit);
  };
  forEachChild(desktopServicesSource(), visit);
  return found;
}

/** The first `callee(...)` call with a bare identifier callee. */
export function calleeCall(callee: string): CallExpression | undefined {
  let found: CallExpression | undefined;
  const visit = (node: Node): void => {
    if (
      !found &&
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === callee
    ) {
      found = node;
    }
    forEachChild(node, visit);
  };
  forEachChild(desktopServicesSource(), visit);
  return found;
}

/**
 * The object literal the first argument of the first `object.method(...)`
 * denotes.
 *
 * {@link calleeArgument} matches a bare identifier callee only, so it cannot
 * reach a static-class entry point such as `Observability.init(...)`.
 */
export function memberCalleeArgument(
  object: string,
  method: string
): ObjectLiteralExpression | undefined {
  let found: ObjectLiteralExpression | undefined;
  const visit = (node: Node): void => {
    if (
      !found &&
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      isIdentifier(node.expression.expression) &&
      node.expression.expression.text === object &&
      node.expression.name.text === method &&
      node.arguments.length > 0
    ) {
      found = objectLiteralArgument(node.arguments[0]);
    }
    forEachChild(node, visit);
  };
  forEachChild(desktopServicesSource(), visit);
  return found;
}

export function propertyInitializer(
  literal: ObjectLiteralExpression,
  name: string
): Node | undefined {
  for (const property of literal.properties) {
    if (
      isPropertyAssignment(property) &&
      isIdentifier(property.name) &&
      property.name.text === name
    ) {
      return property.initializer;
    }
  }
  return undefined;
}

export function propertyInitializerText(
  literal: ObjectLiteralExpression,
  name: string
): string | undefined {
  return propertyInitializer(literal, name)?.getText();
}

/**
 * The object literal an argument denotes: the argument itself, or the body of
 * the `() => ({ ... })` resolver the composition root passes.
 */
function objectLiteralArgument(
  argument: Node
): ObjectLiteralExpression | undefined {
  if (isObjectLiteralExpression(argument)) {
    return argument;
  }
  if (isArrowFunction(argument) && isParenthesizedExpression(argument.body)) {
    return isObjectLiteralExpression(argument.body.expression)
      ? argument.body.expression
      : undefined;
  }
  return undefined;
}

/**
 * What an initializer CALLS, read off the AST.
 *
 * ISS-9082 review: the alternative is `initializer.getText().includes(name)`,
 * and `getText()` carries the comments, so a comment naming the callee keeps
 * such an assertion green while the body returns something else entirely.
 * Nothing below can be satisfied by a comment.
 */
export type InitializerCall = {
  /** Whether the call is deferred behind `() => …` rather than evaluated once. */
  readonly deferred: boolean;
  /** The called function's own name — `a.b.c()` reports `c`. */
  readonly callee: string;
  /** Each argument's own name — `this.x` reports `x`; unnamed arguments drop. */
  readonly argumentNames: readonly string[];
};

/** The {@link InitializerCall} an initializer denotes, or undefined if it calls nothing. */
export function initializerCall(
  initializer: Node
): InitializerCall | undefined {
  const deferred = isArrowFunction(initializer);
  const call = deferred ? initializer.body : initializer;
  if (!isCallExpression(call)) {
    return undefined;
  }
  const callee = ownName(call.expression);
  if (!callee) {
    return undefined;
  }
  const argumentNames: string[] = [];
  for (const argument of call.arguments) {
    const name = ownName(argument);
    if (name) {
      argumentNames.push(name);
    }
  }
  return { deferred, callee, argumentNames };
}

/** An expression's own trailing name: `x` for `x`, and `c` for `a.b.c`. */
function ownName(node: Node): string | undefined {
  if (isIdentifier(node)) {
    return node.text;
  }
  if (isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  return undefined;
}
