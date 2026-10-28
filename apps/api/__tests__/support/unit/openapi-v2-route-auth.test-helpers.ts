/**
 * Which credential a shipped `/v2` route accepts, read off its handler's own
 * source (ISS-9464). Consumed by `openapi-batch-item-results.test.ts`, which
 * holds the spec's side of the comparison and nothing about routes.
 *
 * Through the TypeScript AST rather than the file's text, per AGENTS.md → Test
 * Practices and `scripts/lint/rules/no-raw-text-source-scan.ts`. The wrapper is
 * the only place the answer exists: `withAuth` takes a Clerk session and
 * nothing else, so an operation inheriting the document-level `bearerAuth`
 * publishes an API-key contract that route refuses (ISS-9464 review, impact).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  ARTIFACT_BULK_ACTION_SCOPE,
  ArtifactBulkAction,
} from "@repo/api/src/types/artifact-bulk-action";
import ts from "typescript6";

/**
 * Which credential a route accepts, as the auth wrappers express it.
 *
 * `api-key` has no `/v2` member today and is listed anyway: it shares the
 * contract `api-key-or-session` already exercises, so a route that drops the
 * session branch stays classified instead of becoming unrecognized.
 *
 * There is a FOURTH wrapper, `with-desktop-session-auth`, and it is
 * deliberately absent from the map below: no `/v2` route names it, and the
 * published document carries no scheme for that credential, so there is nothing
 * to pin it to. It therefore lands where any wrapper this reader has not been
 * taught lands — {@link routeAuth} THROWS rather than skipping the route, which
 * is the behavior to keep. A route whose credential nobody classified is the
 * one whose published contract is likeliest to be wrong, and a skip would wave
 * it through unchecked.
 */
export const RouteAuthMode = {
  Session: "session",
  ApiKeyOrSession: "api-key-or-session",
  ApiKey: "api-key",
} as const;
export type RouteAuthMode = (typeof RouteAuthMode)[keyof typeof RouteAuthMode];

/**
 * A route's credential and, on the two modes that accept a key, the scopes
 * whose absence is the only thing `withApiKeyAuth` 403s for. Session-only has
 * no key, so it has no scope to name.
 */
export type RouteAuth =
  | { mode: typeof RouteAuthMode.Session }
  | {
      mode: typeof RouteAuthMode.ApiKey | typeof RouteAuthMode.ApiKeyOrSession;
      requiredScopes: readonly string[];
    };

const API_KEY_SCOPE_NAME = "ApiKeyScope";
const BULK_ACTION_SCOPE_TABLE_NAME = "ARTIFACT_BULK_ACTION_SCOPE";
const BULK_ACTION_NAME = "ArtifactBulkAction";

const AUTH_WRAPPER_MODULES = new Map<string, RouteAuthMode>([
  ["@/lib/auth/with-auth", RouteAuthMode.Session],
  ["@/lib/auth/with-any-auth", RouteAuthMode.ApiKeyOrSession],
  ["@/lib/auth/with-api-key-auth", RouteAuthMode.ApiKey],
]);

/**
 * The credential `app<route>/route.ts` accepts and, when that credential is an
 * API key, the scopes it hands its wrapper.
 *
 * The two wrappers do not 403 alike, which is why the mode alone is not the
 * whole answer. `withAuth` answers 403 from `resolveOrgHeader` carrying
 * `code: org_forbidden` — session-level, deliberately coded (ISS-5095).
 * `withApiKeyAuth` answers one only when a VERIFIED key lacks a scope the route
 * required, with no code at all.
 */
export function routeAuth(apiRoot: string, route: string): RouteAuth {
  const file = path.join(apiRoot, "app", route, "route.ts");
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const wrappers = source.statements
    .filter(ts.isImportDeclaration)
    .flatMap(importedAuthWrappers);

  const [wrapper] = wrappers;
  if (wrappers.length !== 1 || !wrapper) {
    throw new Error(
      `app${route}/route.ts imports ${wrappers.length} auth wrappers; exactly one names the credential it accepts`
    );
  }
  if (wrapper.mode === RouteAuthMode.Session) {
    return { mode: wrapper.mode };
  }
  return {
    mode: wrapper.mode,
    requiredScopes: declaredApiKeyScopes(source, wrapper.localName, route),
  };
}

/** The auth wrappers one import declaration binds, if it names one at all. */
function importedAuthWrappers(
  statement: ts.ImportDeclaration
): { mode: RouteAuthMode; localName: string }[] {
  if (!ts.isStringLiteral(statement.moduleSpecifier)) {
    return [];
  }
  const mode = AUTH_WRAPPER_MODULES.get(statement.moduleSpecifier.text);
  const bindings = statement.importClause?.namedBindings;
  if (
    !(mode && bindings) ||
    statement.importClause?.isTypeOnly ||
    !ts.isNamedImports(bindings)
  ) {
    return [];
  }
  // A type-only specifier binds no wrapper: a route can import `AuthContext`
  // from a module it never wraps its handler with.
  return bindings.elements
    .filter((element) => !element.isTypeOnly)
    .map((element) => ({ mode, localName: element.name.text }));
}

/**
 * The API-key scopes a route hands its wrapper. `withApiKeyAuth`'s 403 is only
 * ever about these, so they are what its published 403 has to name.
 *
 * Absent options are a refusal rather than a guess: `with-any-auth` falls back
 * to a scope derived from the request method, and restating that rule here
 * would be a second copy of it, free to disagree with the wrapper.
 */
function declaredApiKeyScopes(
  source: ts.SourceFile,
  wrapperName: string,
  route: string
): readonly string[] {
  const scopes: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === wrapperName
    ) {
      scopes.push(...callRequiredScopes(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (scopes.length === 0) {
    throw new Error(
      `app${route}/route.ts hands \`${wrapperName}\` no \`requiredScopes\`, so this reader cannot say which scope its 403 reports. Declare the scopes on the route.`
    );
  }
  return scopes;
}

/** The scope members of one wrapper call's `requiredScopes` option. */
function callRequiredScopes(call: ts.CallExpression): string[] {
  const options = call.arguments[1];
  if (!(options && ts.isObjectLiteralExpression(options))) {
    return [];
  }
  return options.properties
    .filter(ts.isPropertyAssignment)
    .filter(
      (property) =>
        ts.isIdentifier(property.name) &&
        property.name.text === "requiredScopes"
    )
    .flatMap((property) =>
      ts.isArrayLiteralExpression(property.initializer)
        ? property.initializer.elements.map(scopeElementValue)
        : []
    );
}

/**
 * One `requiredScopes` element as the scope it names: a string literal, an
 * `ApiKeyScope` member, or an `ARTIFACT_BULK_ACTION_SCOPE[ArtifactBulkAction.X]`
 * lookup (ISS-11409: `batch-move/v2` reads v1's shared table). Anything else
 * throws: a skipped element would publish a 403 that names too few scopes.
 */
function scopeElementValue(element: ts.Expression): string {
  if (ts.isStringLiteral(element)) {
    return element.text;
  }
  if (
    ts.isPropertyAccessExpression(element) &&
    ts.isIdentifier(element.expression) &&
    element.expression.text === API_KEY_SCOPE_NAME
  ) {
    return lookupMember(ApiKeyScope, element.name.text, element);
  }
  if (
    ts.isElementAccessExpression(element) &&
    ts.isIdentifier(element.expression) &&
    element.expression.text === BULK_ACTION_SCOPE_TABLE_NAME &&
    ts.isPropertyAccessExpression(element.argumentExpression) &&
    ts.isIdentifier(element.argumentExpression.expression) &&
    element.argumentExpression.expression.text === BULK_ACTION_NAME
  ) {
    const action = lookupMember(
      ArtifactBulkAction,
      element.argumentExpression.name.text,
      element
    );
    return lookupMember(ARTIFACT_BULK_ACTION_SCOPE, action, element);
  }
  throw new Error(
    `cannot read the scope \`${element.getText()}\`; name it as a string literal, an \`${API_KEY_SCOPE_NAME}\` member, or an \`${BULK_ACTION_SCOPE_TABLE_NAME}\` lookup.`
  );
}

function lookupMember(
  table: Readonly<Record<string, string>>,
  key: string,
  element: ts.Expression
): string {
  const value = table[key];
  if (value === undefined) {
    throw new Error(`\`${element.getText()}\` names no member \`${key}\``);
  }
  return value;
}
