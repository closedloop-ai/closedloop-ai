/**
 * ISS-9089 AC2: every registered inverse is a REAL `apps/api` call.
 *
 * The registry lives in `@repo/api` and can only describe a route by path and
 * method. This suite is the half that can check the description is true: it
 * resolves each inverse's path against the App Router tree under `apps/api/app`
 * and parses the resolved `route.ts` with the TypeScript AST to confirm the
 * handler for that method is actually exported. A client-side rollback, or an
 * inverse pointed at a route that does not exist, fails here.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { API_KEY_SCOPES, ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  ARTIFACT_BULK_ACTION_SCOPE,
  ArtifactBulkAction,
} from "@repo/api/src/types/artifact-bulk-action";
import {
  isUndoableCommand,
  type UndoApiCall,
  UndoApiMethod,
  type UndoCommandContext,
  UndoEntityType,
  UndoMutationKind,
} from "@repo/api/src/types/undo-command";
import {
  UNDO_COMMAND_REGISTRY,
  undoRegistryEntryFor,
} from "@repo/api/src/types/undo-command-registry";
import ts from "typescript6";
import { describe, expect, it } from "vitest";

const APP_ROUTER_ROOT = path.resolve(import.meta.dirname, "../app");
const DYNAMIC_SEGMENT = /^\[.+\]$/;
/** A UUID path segment — the only shape allowed to fall back to `[param]`. */
const ENTITY_ID_SEGMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ARTIFACT_A = "11111111-1111-1111-1111-111111111111";
const ARTIFACT_B = "22222222-2222-2222-2222-222222222222";

const TAG_KINDS: ReadonlySet<UndoMutationKind> = new Set([
  UndoMutationKind.ArtifactTagApply,
  UndoMutationKind.ArtifactTagRemove,
  UndoMutationKind.ArtifactBulkTagApply,
  UndoMutationKind.ArtifactBulkTagRemove,
]);

const REMOVE_TAG_KINDS: ReadonlySet<UndoMutationKind> = new Set([
  UndoMutationKind.ArtifactTagRemove,
  UndoMutationKind.ArtifactBulkTagRemove,
]);

/**
 * Tag commands capture a boolean membership; the field-change commands capture
 * a status/priority/assignee string, so one shared fixture cannot serve both.
 * The tag pre-states are chosen so BOTH directions emit a request: an apply
 * inverts the id that was not yet a member, a remove inverts the id that was.
 */
function contextFor(kind: UndoMutationKind): UndoCommandContext {
  const entity = {
    type: UndoEntityType.Artifact,
    ids: [ARTIFACT_A, ARTIFACT_B],
  };
  const subject = {
    id: "33333333-3333-3333-3333-333333333333",
    label: "Blocked",
  };
  if (TAG_KINDS.has(kind)) {
    const applying = !REMOVE_TAG_KINDS.has(kind);
    return {
      entity,
      priorValue: { [ARTIFACT_A]: !applying, [ARTIFACT_B]: !applying },
      newValue: { [ARTIFACT_A]: applying, [ARTIFACT_B]: applying },
      subject,
      forwardChangedIds: [ARTIFACT_A, ARTIFACT_B],
    };
  }
  return {
    entity,
    priorValue: { [ARTIFACT_A]: "DRAFT", [ARTIFACT_B]: "IN_REVIEW" },
    newValue: { [ARTIFACT_A]: "APPROVED", [ARTIFACT_B]: "APPROVED" },
    subject,
    forwardChangedIds: [ARTIFACT_A, ARTIFACT_B],
  };
}

/**
 * Resolve one App Router segment: an exact directory wins, otherwise the single
 * dynamic `[param]` sibling. Returns null when neither exists, which is the
 * "this inverse names a route that is not there" failure.
 *
 * The dynamic fallback is gated on the segment LOOKING like an id. Falling back
 * for any unmatched segment would make the whole guard toothless: a misspelled
 * literal like `/documents/batch-update-statuz` would resolve to
 * `documents/[id]`, whose `route.ts` exports `PUT`, and the check would go green
 * on a route that does not exist.
 */
function resolveSegment(current: string, segment: string): string | null {
  const exact = path.join(current, segment);
  if (existsSync(exact) && statSync(exact).isDirectory()) {
    return exact;
  }
  if (!ENTITY_ID_SEGMENT.test(segment)) {
    return null;
  }
  const dynamic = readdirSync(current).filter(
    (entry) =>
      DYNAMIC_SEGMENT.test(entry) &&
      statSync(path.join(current, entry)).isDirectory()
  );
  return dynamic.length === 1 ? path.join(current, dynamic[0]) : null;
}

function resolveRouteFile(apiPath: string): string | null {
  const [withoutQuery] = apiPath.split("?");
  const segments = withoutQuery.split("/").filter((segment) => segment !== "");
  let current = APP_ROUTER_ROOT;
  for (const segment of segments) {
    const next = resolveSegment(current, segment);
    if (next === null) {
      return null;
    }
    current = next;
  }
  const routeFile = path.join(current, "route.ts");
  return existsSync(routeFile) ? routeFile : null;
}

function isExportedStatement(statement: ts.Statement): boolean {
  return Boolean(
    ts.canHaveModifiers(statement) &&
      ts
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function parseRoute(routeFile: string): ts.SourceFile {
  return ts.createSourceFile(
    routeFile,
    readFileSync(routeFile, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
}

/**
 * The HTTP method handlers a route module exports, read off the AST rather than
 * the raw text — a comment mentioning `PUT` must not satisfy this check.
 *
 * Both declaration forms count. `export const POST = withAnyAuth(…)` is what the
 * routes this registry targets happen to use, but `export async function GET(…)`
 * is just as common in this app-router tree, and reading only variable
 * statements would fail a future inverse against a route that genuinely exports
 * its handler.
 */
function exportedHandlerNames(routeFile: string): Set<string> {
  const source = parseRoute(routeFile);
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!isExportedStatement(statement)) {
      continue;
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      names.add(statement.name.text);
      continue;
    }
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        names.add(declaration.name.text);
      }
    }
  }
  return names;
}

/**
 * `withAnyAuth`'s own fallback for a route that passes no `requiredScopes`.
 * Only DELETE differs from the write default across the methods an inverse can
 * use; `withAnyAuth` also maps GET/HEAD to `read`, which no inverse issues.
 */
const FALLBACK_SCOPE_BY_METHOD: ReadonlyMap<UndoApiMethod, ApiKeyScope> =
  new Map([[UndoApiMethod.Delete, ApiKeyScope.Delete]]);

function exportedHandlerInitializer(
  source: ts.SourceFile,
  method: UndoApiMethod
): ts.Expression | null {
  for (const statement of source.statements) {
    if (
      !(isExportedStatement(statement) && ts.isVariableStatement(statement))
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === method &&
        declaration.initializer
      ) {
        return declaration.initializer;
      }
    }
  }
  return null;
}

function scopesFromAuthOptions(
  options: ts.Expression
): readonly ApiKeyScope[] | null {
  if (!ts.isObjectLiteralExpression(options)) {
    return null;
  }
  for (const property of options.properties) {
    if (
      !(
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "requiredScopes" &&
        ts.isArrayLiteralExpression(property.initializer)
      )
    ) {
      continue;
    }
    const literals = property.initializer.elements.flatMap((element) => {
      if (ts.isStringLiteralLike(element)) {
        return [element.text];
      }
      if (
        ts.isElementAccessExpression(element) &&
        ts.isIdentifier(element.expression) &&
        element.expression.text === "ARTIFACT_BULK_ACTION_SCOPE" &&
        element.argumentExpression &&
        ts.isPropertyAccessExpression(element.argumentExpression) &&
        element.argumentExpression.expression.getText() === "ArtifactBulkAction"
      ) {
        const memberName = element.argumentExpression.name.text;
        const action = Object.entries(ArtifactBulkAction).find(
          ([name]) => name === memberName
        )?.[1];
        if (action) {
          return [ARTIFACT_BULK_ACTION_SCOPE[action]];
        }
      }
      return [];
    });
    return API_KEY_SCOPES.filter((scope) => literals.includes(scope));
  }
  return null;
}

/**
 * The scopes `apps/api` actually enforces for one method on one route — read
 * off the route's own `withAnyAuth(…, { requiredScopes })`, falling back to
 * `withAnyAuth`'s method default when the route passes none.
 *
 * Throws on a shape it cannot read rather than returning an empty list: a
 * silent `[]` would make the agreement assertion below pass on every route it
 * failed to parse.
 */
function enforcedScopes(
  routeFile: string,
  method: UndoApiMethod
): readonly ApiKeyScope[] {
  const initializer = exportedHandlerInitializer(parseRoute(routeFile), method);
  if (initializer === null) {
    throw new Error(`${routeFile}: no exported ${method} handler to read`);
  }
  if (!ts.isCallExpression(initializer)) {
    throw new Error(`${routeFile}: ${method} is not an auth-wrapper call`);
  }
  const options = initializer.arguments[1];
  const declared = options ? scopesFromAuthOptions(options) : null;
  return (
    declared ?? [FALLBACK_SCOPE_BY_METHOD.get(method) ?? ApiKeyScope.Write]
  );
}

const undoableKinds = Object.values(UNDO_COMMAND_REGISTRY)
  .filter(isUndoableCommand)
  .map((entry) => entry.kind);

function inverseCallsFor(kind: UndoMutationKind): readonly UndoApiCall[] {
  const entry = undoRegistryEntryFor(kind);
  if (!isUndoableCommand(entry)) {
    throw new Error(`${kind} is not declared undoable`);
  }
  return entry.inverse(contextFor(kind));
}

describe("undo registry inverses resolve to real apps/api routes", () => {
  it("has at least one undoable command to check", () => {
    expect(undoableKinds.length).toBeGreaterThan(0);
  });

  it.each(undoableKinds)("%s: inverse issues at least one request", (kind) => {
    expect(inverseCallsFor(kind).length).toBeGreaterThan(0);
  });

  it.each(undoableKinds)(
    "%s: every inverse request resolves to an exported apps/api handler",
    (kind) => {
      for (const call of inverseCallsFor(kind)) {
        const routeFile = resolveRouteFile(call.path);
        if (routeFile === null) {
          throw new Error(
            `${kind}: no apps/api route for ${call.method} ${call.path}`
          );
        }
        expect(
          [...exportedHandlerNames(routeFile)],
          `${kind}: ${path.relative(APP_ROUTER_ROOT, routeFile)} exports no ${call.method} handler`
        ).toContain(call.method);
      }
    }
  );

  it.each(undoableKinds)(
    "%s: every inverse declares the scope its route enforces",
    (kind) => {
      for (const call of inverseCallsFor(kind)) {
        const routeFile = resolveRouteFile(call.path);
        if (routeFile === null) {
          throw new Error(
            `${kind}: no apps/api route for ${call.method} ${call.path}`
          );
        }
        expect(
          enforcedScopes(routeFile, call.method),
          `${kind}: ${call.method} ${call.path} is declared as ${call.requiredScope}`
        ).toContain(call.requiredScope);
      }
    }
  );

  it("reads the enforced scope off the route, not off the registry", () => {
    // The pair that makes the declaration worth carrying: applying a tag is a
    // `write`, undoing it is a `delete`. A key with write-only scope can run
    // the forward and gets a 403 on the inverse, so the two must not be read as
    // one permission. This also proves the reader distinguishes them at all —
    // a resolver that returned the same list for both would satisfy every
    // agreement assertion above.
    const entityTags = path.join(APP_ROUTER_ROOT, "entity-tags/route.ts");
    expect(enforcedScopes(entityTags, UndoApiMethod.Post)).toEqual([
      ApiKeyScope.Write,
    ]);
    expect(enforcedScopes(entityTags, UndoApiMethod.Delete)).toEqual([
      ApiKeyScope.Delete,
    ]);
  });

  it("refuses to read a scope from a method the route does not export", () => {
    const batch = path.join(APP_ROUTER_ROOT, "entity-tags/batch/route.ts");
    expect(() => enforcedScopes(batch, UndoApiMethod.Delete)).toThrow(
      "no exported DELETE handler"
    );
  });

  it("fails a path that names no route (guard is not vacuous)", () => {
    expect(
      resolveRouteFile("/documents/definitely-not-a-route/nope")
    ).toBeNull();
  });

  it("does not let a misspelled literal fall through to a dynamic route", () => {
    // The positive sibling: the correctly-spelled path DOES resolve, so this
    // pair pins the spelling rather than the resolver simply refusing both.
    expect(resolveRouteFile("/documents/batch-update-status")).not.toBeNull();
    expect(resolveRouteFile("/documents/batch-update-statuz")).toBeNull();
  });

  it("reads a handler declared as an exported function, not only a const", () => {
    const functionDeclared = path.join(
      APP_ROUTER_ROOT,
      "documents/by-slug/[slug]/meta/route.ts"
    );
    const constDeclared = path.join(APP_ROUTER_ROOT, "documents/[id]/route.ts");
    expect([...exportedHandlerNames(functionDeclared)]).toContain("GET");
    expect([...exportedHandlerNames(constDeclared)]).toContain("PUT");
  });
});
