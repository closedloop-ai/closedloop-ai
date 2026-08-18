import { basename, dirname, join, relative } from "node:path";
import ts from "typescript6";
import type { EndpointStringOnlyDateKeys } from "../endpoint-date-revival";
import {
  collectRoutePayloadTypes,
  indexContractDeclarations,
  type ParsedSources,
  ROUTE_ROOT,
  walkPayloads,
} from "./date-revival-discovery";

/**
 * Per-ENDPOINT date-key discovery for the revival guard (ISS-6208).
 *
 * `date-revival-discovery.ts` answers the repo-wide question — which keys does
 * ANY response contract declare a `Date`? — and that answer is what the key
 * allowlist encodes. It cannot see a collision: half those keys are declared
 * `Date` on one route's payload and `string` on another's, and the first use
 * legitimizes the key everywhere.
 *
 * This module re-asks the same question one served URL at a time, so a key's
 * `Date`-ness can be decided against the endpoint that actually produced the
 * body. It reuses the same walk, seeded with only that URL's payloads.
 */

/** The App Router file that makes a directory a served URL. */
const ROUTE_FILE = /^route\.tsx?$/;
/** An App Router dynamic segment, which matches any single request segment. */
const DYNAMIC_SEGMENT = /^\[.*\]$/;
/** The exports an App Router route file installs as request handlers. */
const HTTP_METHOD_EXPORTS = new Set([
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
]);
/** `@/…` resolves to `apps/api/…` — see the `paths` in `apps/api/tsconfig.json`. */
const API_ALIAS_PREFIX = "@/";
const API_ROOT = "apps/api";
/** The endings a TypeScript import specifier resolves through. */
const MODULE_SUFFIXES = [".ts", ".tsx", "/index.ts", "/index.tsx"];

/**
 * One served URL and the keys its own payloads resolve to, independent of every
 * other route.
 */
export type EndpointDateKeyProfile = {
  /** URL template mirroring the App Router directory, e.g. `/branches/[id]`. */
  route: string;
  /** Keys this endpoint's payloads declare as a `Date`. */
  dateKeys: ReadonlySet<string>;
  /** Keys this endpoint's payloads declare as a `string`. */
  stringKeys: ReadonlySet<string>;
};

/**
 * Group the declared route payloads by served URL and walk each group on its
 * own, so a key's `Date`-ness is answered per endpoint rather than repo-wide.
 *
 * Only a directory holding a `route.ts` is reported: without one there is no URL
 * the client can call, and guessing one would risk suppressing revival on a URL
 * whose real payload declares a `Date`.
 */
export function discoverEndpointDateKeyProfiles(
  sources: ParsedSources
): EndpointDateKeyProfile[] {
  const index = indexContractDeclarations(sources.contractSources);
  const { servedUrls, payloadsByUrl } = groupPayloadsByUrl(
    sources.routeSources
  );

  const profiles: EndpointDateKeyProfile[] = [];
  for (const [route, payloads] of payloadsByUrl) {
    if (!servedUrls.has(route)) {
      continue;
    }
    const walked = walkPayloads(payloads, index);
    profiles.push({
      dateKeys: walked.keys,
      route,
      stringKeys: walked.stringKeys,
    });
  }
  return profiles.sort((left, right) => left.route.localeCompare(right.route));
}

/**
 * The endpoint-scoped suppression table: for each served URL, the allowlisted
 * keys that URL's own payloads declare as a `string` and never as a `Date`.
 *
 * A key an endpoint declares BOTH ways is deliberately absent — the reviver sees
 * one key name per response and cannot tell the two apart, so suppressing it
 * would break the `Date` half. {@link discoverEndpointDateKeyConflicts} reports
 * those separately so they cannot grow unnoticed.
 *
 * `servedRoutes` is every URL the API serves, not only the ones with a payload,
 * because of SHADOWING: `/agent-sessions/usage` is a literal sibling of the
 * dynamic `/agent-sessions/[id]`, so without an entry of its own it would match
 * that dynamic row and lose `Date`s the sibling route never declared as strings.
 * Those siblings are emitted with NO keys, which is what makes them shadow.
 */
export function deriveEndpointStringOnlyDateKeys(
  profiles: readonly EndpointDateKeyProfile[],
  revivalKeys: ReadonlySet<string>,
  servedRoutes: readonly string[]
): EndpointStringOnlyDateKeys[] {
  const suppressions = collectEndpointKeys(
    profiles,
    revivalKeys,
    (profile, key) => profile.stringKeys.has(key) && !profile.dateKeys.has(key)
  );
  return [...suppressions, ...shadowRoutes(suppressions, servedRoutes)].sort(
    (left, right) => left.route.localeCompare(right.route)
  );
}

/** Every URL the API serves — one per App Router directory holding a route file. */
export function discoverServedRouteUrls(sources: ParsedSources): string[] {
  return [...groupPayloadsByUrl(sources.routeSources).servedUrls].sort();
}

/**
 * Endpoints that declare an allowlisted key BOTH as a `string` and as a `Date`
 * within one response surface. These are the collisions a key-only reviver
 * cannot resolve at all.
 */
export function discoverEndpointDateKeyConflicts(
  profiles: readonly EndpointDateKeyProfile[],
  revivalKeys: ReadonlySet<string>
): EndpointStringOnlyDateKeys[] {
  return collectEndpointKeys(
    profiles,
    revivalKeys,
    (profile, key) => profile.stringKeys.has(key) && profile.dateKeys.has(key)
  );
}

/** The URL an App Router route file serves, mirroring its directory. */
function routeUrlForSourceFile(fileName: string): string {
  const dir = dirname(relative(ROUTE_ROOT, fileName));
  return dir === "." ? "/" : `/${dir}`;
}

/**
 * Every served URL, and the payloads the route file at that URL installs.
 *
 * Attribution follows the INSTALL, not the directory a declaration happens to
 * sit in. A route need not declare its own payload: the six trace-comment
 * endpoints under `/agent-sessions/[id]` and `/branches/[id]`, and the four
 * `custom-field-settings` endpoints, all export handlers built by factories in
 * a shared module, and giving those payloads to the factory's own directory
 * left every one of those real endpoints without a suppression row — still
 * reviving its `string` timestamps into `Date`s — while minting a row on a URL
 * (`/custom-fields`) that never serves the field at all.
 */
function groupPayloadsByUrl(routeSources: readonly ts.SourceFile[]): {
  servedUrls: Set<string>;
  payloadsByUrl: Map<string, ts.TypeNode[]>;
} {
  const byFileName = new Map(
    routeSources.map((source) => [source.fileName, source] as const)
  );
  const servedUrls = new Set<string>();
  const payloadsByUrl = new Map<string, ts.TypeNode[]>();
  for (const source of routeSources) {
    if (!ROUTE_FILE.test(basename(source.fileName))) {
      continue;
    }
    const url = routeUrlForSourceFile(source.fileName);
    servedUrls.add(url);
    const payloads = collectRoutePayloadTypes(
      installedHandlerModules(source, byFileName)
    );
    if (payloads.length > 0) {
      payloadsByUrl.set(url, payloads);
    }
  }
  return { payloadsByUrl, servedUrls };
}

/**
 * The served URLs that a suppression row would capture but does not describe.
 *
 * A request path is matched segment by segment, so a dynamic row swallows every
 * literal sibling of the same length. Emitting those siblings with no keys makes
 * them win the match — the same literal-over-dynamic precedence the App Router
 * applies — so suppression never leaks onto a route whose payload was never
 * examined for it.
 */
function shadowRoutes(
  suppressions: readonly EndpointStringOnlyDateKeys[],
  servedRoutes: readonly string[]
): EndpointStringOnlyDateKeys[] {
  const described = new Set(suppressions.map((row) => row.route));
  const patterns = suppressions.map((row) => toSegments(row.route));
  return servedRoutes
    .filter((route) => !described.has(route))
    .filter((route) => {
      const segments = toSegments(route);
      return patterns.some((pattern) => capturesRoute(pattern, segments));
    })
    .map((route) => ({ keys: [], route }));
}

/**
 * Whether a suppression row's segments could match SOME request served by
 * another route. A dynamic segment on either side is a wildcard: on the row
 * because it matches any value, and on the route because its real value is a
 * parameter that may happen to equal the row's literal. `/documents/by-slug/…`
 * is the case that forces the second half — a document slugged `attachments`
 * would otherwise be matched by `/documents/[id]/attachments`.
 */
function capturesRoute(
  pattern: readonly string[],
  segments: readonly string[]
): boolean {
  return (
    pattern.length === segments.length &&
    pattern.every(
      (segment, index) =>
        DYNAMIC_SEGMENT.test(segment) ||
        DYNAMIC_SEGMENT.test(segments[index]) ||
        segment === segments[index]
    )
  );
}

function toSegments(route: string): string[] {
  return route.split("/").filter((segment) => segment.length > 0);
}

/**
 * A route file plus every module it installs its handlers from, transitively.
 *
 * A factory chain this cannot follow costs a suppression, never a wrong one:
 * the endpoint falls back to the unscoped allowlist, which is exactly the
 * behavior before this table existed.
 */
function installedHandlerModules(
  route: ts.SourceFile,
  byFileName: ReadonlyMap<string, ts.SourceFile>
): ts.SourceFile[] {
  const modules = [route];
  const visited = new Set([route.fileName]);
  const queue: { source: ts.SourceFile; isRoute: boolean }[] = [
    { isRoute: true, source: route },
  ];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      break;
    }
    for (const fileName of installedModuleFiles(
      current.source,
      current.isRoute
    )) {
      const next = byFileName.get(fileName);
      if (!next || visited.has(fileName)) {
        continue;
      }
      visited.add(fileName);
      modules.push(next);
      queue.push({ isRoute: false, source: next });
    }
  }
  return modules;
}

/**
 * The candidate files a module's own exported handlers are built from. On a
 * route file only the HTTP-method exports count — that is what "the route that
 * installs it" means — while inside a handler module every export is followed,
 * so a factory split across modules still resolves.
 */
function installedModuleFiles(
  source: ts.SourceFile,
  isRoute: boolean
): string[] {
  const imports = importedBindingModules(source);
  const names: string[] = [];
  for (const initializer of exportedHandlerNodes(source, isRoute)) {
    collectIdentifierNames(initializer, names);
  }
  const files: string[] = [];
  for (const name of names) {
    const specifier = imports.get(name);
    const base = specifier && routeModuleBase(specifier, source.fileName);
    if (!base) {
      continue;
    }
    files.push(...MODULE_SUFFIXES.map((suffix) => `${base}${suffix}`));
  }
  return files;
}

/** The extension-less path an import specifier names, when it stays in the API app. */
function routeModuleBase(
  specifier: string,
  fromFile: string
): string | undefined {
  if (specifier.startsWith(API_ALIAS_PREFIX)) {
    return join(API_ROOT, specifier.slice(API_ALIAS_PREFIX.length));
  }
  if (specifier.startsWith(".")) {
    return join(dirname(fromFile), specifier);
  }
  return undefined;
}

/** Each imported binding name mapped to the module specifier it came from. */
function importedBindingModules(source: ts.SourceFile): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const statement of source.statements) {
    if (
      !(
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.importClause
      )
    ) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause.name) {
      bindings.set(clause.name.text, specifier);
    }
    for (const name of boundNames(clause.namedBindings)) {
      bindings.set(name, specifier);
    }
  }
  return bindings;
}

function boundNames(bindings: ts.NamedImportBindings | undefined): string[] {
  if (!bindings) {
    return [];
  }
  if (ts.isNamespaceImport(bindings)) {
    return [bindings.name.text];
  }
  return bindings.elements.map((element) => element.name.text);
}

/** The exported declarations whose bodies name the handlers a module installs. */
function exportedHandlerNodes(
  source: ts.SourceFile,
  isRoute: boolean
): ts.Node[] {
  const nodes: ts.Node[] = [];
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      if (!isRoute && hasExportModifier(statement)) {
        nodes.push(statement);
      }
      continue;
    }
    if (!(ts.isVariableStatement(statement) && hasExportModifier(statement))) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.initializer && isInstalledExport(declaration, isRoute)) {
        nodes.push(declaration.initializer);
      }
    }
  }
  return nodes;
}

function isInstalledExport(
  declaration: ts.VariableDeclaration,
  isRoute: boolean
): boolean {
  if (!isRoute) {
    return true;
  }
  return (
    ts.isIdentifier(declaration.name) &&
    HTTP_METHOD_EXPORTS.has(declaration.name.text)
  );
}

function hasExportModifier(
  statement: ts.VariableStatement | ts.FunctionDeclaration
): boolean {
  return (statement.modifiers ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
  );
}

function collectIdentifierNames(node: ts.Node, out: string[]): void {
  const walk = (child: ts.Node) => {
    if (ts.isIdentifier(child)) {
      out.push(child.text);
    }
    ts.forEachChild(child, walk);
  };
  walk(node);
}

function collectEndpointKeys(
  profiles: readonly EndpointDateKeyProfile[],
  revivalKeys: ReadonlySet<string>,
  matches: (profile: EndpointDateKeyProfile, key: string) => boolean
): EndpointStringOnlyDateKeys[] {
  const rows: EndpointStringOnlyDateKeys[] = [];
  for (const profile of profiles) {
    const keys = [...revivalKeys].filter((key) => matches(profile, key)).sort();
    if (keys.length > 0) {
      rows.push({ keys, route: profile.route });
    }
  }
  return rows;
}
