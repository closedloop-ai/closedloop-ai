import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript6";
import {
  classifyZodScalar,
  type PendingAttribution,
  type ScalarKind,
  scalarAliasName,
  scalarKindOfType,
  ZOD_DATE_CALLEE,
  ZOD_STRING_CALLEE,
} from "./date-revival-scalar-aliases";

/**
 * Response-contract discovery for the date-revival guard (ISS-5771).
 *
 * Answers one question from source: WHICH property keys does a type an
 * `apps/api` route serializes resolve to a `Date`? `date-revival-keys-covered.test.ts`
 * asserts that answer against `DATE_REVIVAL_KEYS` in both directions, and the
 * fixture suite there drives these functions with synthetic sources.
 *
 * ## How a "response contract" is identified
 *
 * NOT "every property signature under the contract directories" — that was the
 * bug in the first cut of this guard. Those directories also hold parsed-query
 * models, helper inputs and dead detail types that never cross the wire, and
 * collecting them put `date`, `from`, `to`, `sessionStartedAt` and the Branch
 * View sync timestamps on the revive side even though the shapes actually
 * SERVED under those names declare them `string`. See `date-revival-keys.ts`
 * for the full accounting.
 *
 * Discovery is instead seeded from the payload each route declares it
 * serializes — the first type argument of its route-auth wrapper, which is the
 * server's own explicit statement of the response body — and then walks every
 * type reachable from those payloads through the shared contract packages.
 *
 * ## Both ways a contract spells a `Date`
 *
 * A property signature (`createdAt: Date`) is only one of them. A payload may
 * equally be `z.infer<typeof Schema>` over a `z.coerce.date()` field, which has
 * no property signature anywhere. The walk therefore follows a `z.infer` alias
 * through its `typeof Schema` into the schema value and reads the Zod date
 * forms there, so an inferred `Date` key cannot slip past the guard and ship as
 * a string.
 *
 * ## A scalar named somewhere else
 *
 * Neither spelling has to be inline. `createdAt: IsoTimestamp` and `createdAt:
 * TimestampSchema` both defer to a declaration elsewhere, and following the
 * reference structurally loses the owning key on the way. The walk therefore
 * carries the property name across that hop — see
 * `date-revival-scalar-aliases.ts` — so an aliased contract is classified as
 * the scalar it really is rather than omitted from both sides at once.
 *
 * Everything here is a pure function over parsed sources, which is what lets
 * the fixture suite prove each supported form against key names minted for the
 * test rather than against the repo's own data.
 *
 * Source is read through the TypeScript AST rather than raw text, per the
 * `no-raw-text-source-scan` gate.
 */

/**
 * Walk up to the workspace root rather than counting `..` segments, so moving
 * this file cannot silently reduce the scan to nothing.
 */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    dir = resolve(dir, "..");
  }
  throw new Error("could not locate the workspace root from this test file");
}

const REPO_ROOT = findRepoRoot();

/** Where route handlers declare the payload they serialize. */
export const ROUTE_ROOT = "apps/api/app";

/**
 * Where the types those payloads are built from live. Reachability from a route
 * payload — not residence in one of these directories — is what makes a
 * declaration a response contract.
 */
const CONTRACT_ROOTS = ["packages/api/src/types", "packages/loops-api/src"];

/**
 * The route-auth wrappers whose FIRST type argument is the response payload
 * (`withAnyAuth<TResponse, TRoute>` and siblings). A route that stops using one
 * of these stops declaring its payload here, which the guard's floor assertions
 * catch as a collapsed scan rather than a silently narrowed one.
 */
const ROUTE_AUTH_WRAPPERS = new Set([
  "withAnyAuth",
  "withApiKeyAuth",
  "withAuth",
  "withDesktopSessionAuth",
]);

const SKIPPED_DIRS = new Set(["node_modules", "dist", "generated", ".turbo"]);
const SOURCE_FILE = /\.tsx?$/;
const NON_CONTRACT_FILE = /\.(test|spec|stories)\.tsx?$/;

function listSourceFiles(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    throw new Error(`date-revival guard: cannot read source directory ${dir}`);
  }
  for (const entry of entries) {
    if (SKIPPED_DIRS.has(entry)) {
      continue;
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      listSourceFiles(path, out);
      continue;
    }
    if (SOURCE_FILE.test(entry) && !NON_CONTRACT_FILE.test(entry)) {
      out.push(path);
    }
  }
}

function parseSourcesUnder(roots: readonly string[]): ts.SourceFile[] {
  const paths: string[] = [];
  for (const root of roots) {
    listSourceFiles(join(REPO_ROOT, root), paths);
  }
  return paths.map((path) =>
    ts.createSourceFile(
      relative(REPO_ROOT, path),
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true
    )
  );
}

export type ParsedSources = {
  routeSources: ts.SourceFile[];
  contractSources: ts.SourceFile[];
};

export function loadRepoSources(): ParsedSources {
  return {
    contractSources: parseSourcesUnder(CONTRACT_ROOTS),
    routeSources: parseSourcesUnder([ROUTE_ROOT]),
  };
}

/**
 * The payload type node each route declares it serializes: the first type
 * argument of a `withAnyAuth<TResponse, …>`-style call.
 */
export function collectRoutePayloadTypes(
  sources: ts.SourceFile[]
): ts.TypeNode[] {
  const payloads: ts.TypeNode[] = [];
  for (const source of sources) {
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ROUTE_AUTH_WRAPPERS.has(node.expression.text)
      ) {
        const payload = node.typeArguments?.[0];
        if (payload) {
          payloads.push(payload);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return payloads;
}

export type ContractIndex = {
  types: Map<string, ts.Node[]>;
  values: Map<string, ts.Expression[]>;
};

function addTo<T>(index: Map<string, T[]>, name: string, node: T) {
  const existing = index.get(name);
  if (existing) {
    existing.push(node);
    return;
  }
  index.set(name, [node]);
}

/**
 * Named type declarations AND named value declarations from the contract
 * packages. Values are indexed because a Zod schema is a `const`, not a type —
 * a `z.infer<typeof Schema>` payload is only readable by following the alias
 * into that const's initializer.
 */
export function indexContractDeclarations(
  sources: ts.SourceFile[]
): ContractIndex {
  const types = new Map<string, ts.Node[]>();
  const values = new Map<string, ts.Expression[]>();
  for (const source of sources) {
    const visit = (node: ts.Node) => {
      if (
        (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
        node.name
      ) {
        addTo(types, node.name.text, node);
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer
      ) {
        addTo(values, node.name.text, node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { types, values };
}

/**
 * A callback prop (`onUpdateDueDate: (value: Date) => void`) mentions `Date` in
 * its signature but never carries one over the wire, so it must not widen the
 * revival allowlist.
 */
function isCallbackType(type: ts.TypeNode): boolean {
  if (ts.isFunctionTypeNode(type)) {
    return true;
  }
  if (ts.isUnionTypeNode(type)) {
    return type.types.some(isCallbackType);
  }
  return false;
}

function referencesDate(type: ts.TypeNode): boolean {
  let found = false;
  const walk = (node: ts.Node) => {
    if (ts.isTypeReferenceNode(node) && node.typeName.getText() === "Date") {
      found = true;
    }
    ts.forEachChild(node, walk);
  };
  walk(type);
  return found;
}

function declaresDateArray(type: ts.TypeNode): boolean {
  let found = false;
  const walk = (node: ts.Node) => {
    if (ts.isArrayTypeNode(node) && referencesDate(node.elementType)) {
      found = true;
    }
    if (
      ts.isTypeReferenceNode(node) &&
      node.typeName.getText() === "Array" &&
      node.typeArguments?.some(referencesDate)
    ) {
      found = true;
    }
    ts.forEachChild(node, walk);
  };
  walk(type);
  return found;
}

/** Whether an expression builds a Zod schema that infers to `Date`. */
function isZodDateExpression(expression: ts.Expression): boolean {
  let found = false;
  const walk = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ZOD_DATE_CALLEE.test(node.expression.getText())
    ) {
      found = true;
    }
    ts.forEachChild(node, walk);
  };
  walk(expression);
  return found;
}

/**
 * The names a TYPE declaration refers to. Covers type references, `interface X
 * extends Y` heritage (not a `TypeReferenceNode`), and the `typeof Schema`
 * inside a `z.infer<…>` alias, which is the bridge from the type world into the
 * schema value that actually carries the Zod date.
 */
function referencedTypeNames(node: ts.Node, out: string[]): void {
  const walk = (child: ts.Node) => {
    if (ts.isTypeReferenceNode(child)) {
      out.push(child.typeName.getText());
    }
    if (
      ts.isExpressionWithTypeArguments(child) &&
      ts.isIdentifier(child.expression)
    ) {
      out.push(child.expression.text);
    }
    if (ts.isTypeQueryNode(child)) {
      out.push(child.exprName.getText());
    }
    ts.forEachChild(child, walk);
  };
  walk(node);
}

/**
 * The names a schema VALUE refers to: a nested schema used as a field
 * (`nested: OtherSchema`), a spread field set (`...sharedFields`), and the base
 * of a `OtherSchema.shape.field` reuse.
 *
 * Deliberately narrower than "every identifier". Following identifiers out of
 * type declarations too was tried and re-admitted the dead `BranchDetail` /
 * `SessionDetail` types this change exists to exclude — a name mentioned in a
 * type guard's body is not a field of the response.
 */
function referencedValueNames(node: ts.Node, out: string[]): void {
  const walk = (child: ts.Node) => {
    if (ts.isIdentifier(child) && !isNamePosition(child)) {
      out.push(child.text);
    }
    ts.forEachChild(child, walk);
  };
  walk(node);
}

/** Whether an identifier is the NAME of its parent rather than a reference. */
function isNamePosition(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  if (
    ts.isPropertyAssignment(parent) ||
    ts.isPropertyAccessExpression(parent)
  ) {
    return parent.name === node;
  }
  return false;
}

export type DiscoveredDateKeys = {
  keys: ReadonlySet<string>;
  stringKeys: ReadonlySet<string>;
  arrayKeys: string[];
  routePayloadCount: number;
  reachedDeclarationCount: number;
};

/**
 * Walk out from a set of declared route payloads and collect every property key
 * the reached declarations resolve to a `Date` — and, separately, every key they
 * resolve to a `string`. A key in BOTH sets is declared both ways somewhere in
 * the walked surface, which is exactly the collision the endpoint-scoped guard
 * exists to find (ISS-6208).
 */
export function walkPayloads(
  payloads: readonly ts.TypeNode[],
  index: ContractIndex
): DiscoveredDateKeys {
  const sink: KeySink = {
    aliases: [],
    arrayKeys: new Set<string>(),
    keys: new Set<string>(),
    stringKeys: new Set<string>(),
  };
  const pending: string[] = [];
  const visited = new Set<string>();
  const visitedAliases = new Set<string>();
  let reachedDeclarationCount = 0;

  const scanTypeDeclaration = (node: ts.Node) => {
    const walk = (child: ts.Node) => {
      collectExplicitProperty(child, sink);
      ts.forEachChild(child, walk);
    };
    walk(node);
    referencedTypeNames(node, pending);
  };

  const scanSchemaValue = (node: ts.Node) => {
    const walk = (child: ts.Node) => {
      collectZodProperty(child, sink);
      ts.forEachChild(child, walk);
    };
    walk(node);
    referencedValueNames(node, pending);
  };

  for (const payload of payloads) {
    scanTypeDeclaration(payload);
  }
  while (pending.length > 0 || sink.aliases.length > 0) {
    const name = pending.pop();
    if (name === undefined) {
      resolvePendingAttribution(sink, index, visitedAliases);
      continue;
    }
    if (visited.has(name)) {
      continue;
    }
    visited.add(name);
    for (const declaration of index.types.get(name) ?? []) {
      reachedDeclarationCount += 1;
      scanTypeDeclaration(declaration);
    }
    for (const declaration of index.values.get(name) ?? []) {
      reachedDeclarationCount += 1;
      scanSchemaValue(declaration);
    }
  }

  return {
    arrayKeys: [...sink.arrayKeys].sort(),
    keys: sink.keys,
    reachedDeclarationCount,
    routePayloadCount: payloads.length,
    stringKeys: sink.stringKeys,
  };
}

/**
 * Walk out from the declared route payloads and collect every property key the
 * reached declarations resolve to a `Date`, in either spelling.
 */
export function discoverResponseContractDateKeys(
  sources: ParsedSources
): DiscoveredDateKeys {
  return walkPayloads(
    collectRoutePayloadTypes(sources.routeSources),
    indexContractDeclarations(sources.contractSources)
  );
}

function collectExplicitProperty(node: ts.Node, sink: KeySink): void {
  if (
    !(
      ts.isPropertySignature(node) &&
      node.type &&
      ts.isIdentifier(node.name) &&
      !isCallbackType(node.type)
    )
  ) {
    return;
  }
  if (referencesDate(node.type)) {
    sink.keys.add(node.name.text);
    if (declaresDateArray(node.type)) {
      sink.arrayKeys.add(node.name.text);
    }
    return;
  }
  if (referencesString(node.type)) {
    sink.stringKeys.add(node.name.text);
    return;
  }
  enqueueAlias(scalarAliasName(node.type), node.name.text, sink);
}

function collectZodProperty(node: ts.Node, sink: KeySink): void {
  if (!(ts.isPropertyAssignment(node) && ts.isIdentifier(node.name))) {
    return;
  }
  if (isZodDateExpression(node.initializer)) {
    sink.keys.add(node.name.text);
    return;
  }
  if (isZodStringExpression(node.initializer)) {
    sink.stringKeys.add(node.name.text);
    return;
  }
  const classified = classifyZodScalar(node.initializer);
  if (classified && "alias" in classified) {
    enqueueAlias(classified.alias, node.name.text, sink);
  }
}

/**
 * Run discovery over one synthetic contract module served by one synthetic
 * route, so a fixture proves the discovery rule rather than the repo's data.
 */
export function discoverFixtureSources(
  contractSource: string
): DiscoveredDateKeys {
  const routeSource = ts.createSourceFile(
    "fixture-route.ts",
    'export const GET = withAnyAuth<FixturePayload, "/fixture">(handler);',
    ts.ScriptTarget.Latest,
    true
  );
  return discoverResponseContractDateKeys({
    contractSources: [
      ts.createSourceFile(
        "fixture-contract.ts",
        contractSource,
        ts.ScriptTarget.Latest,
        true
      ),
    ],
    routeSources: [routeSource],
  });
}

export function discoverFixtureKeys(
  contractSource: string
): ReadonlySet<string> {
  return discoverFixtureSources(contractSource).keys;
}

function referencesString(type: ts.TypeNode): boolean {
  let found = false;
  const walk = (node: ts.Node) => {
    if (node.kind === ts.SyntaxKind.StringKeyword) {
      found = true;
    }
    ts.forEachChild(node, walk);
  };
  walk(type);
  return found;
}

/**
 * What one walk collects: the two key sets, the array-of-`Date` report, and the
 * property names still waiting on a name declared elsewhere to resolve.
 */
type KeySink = {
  keys: Set<string>;
  stringKeys: Set<string>;
  arrayKeys: Set<string>;
  aliases: PendingAttribution[];
};

function enqueueAlias(
  name: string | undefined,
  ownerKey: string,
  sink: KeySink
): void {
  if (name) {
    sink.aliases.push({ name, ownerKey });
  }
}

/**
 * Resolve one deferred property against the contract index and record the
 * scalar it turns out to be under the ORIGINAL property key. An alias that
 * points at a further alias re-queues itself, so a chain resolves; the visited
 * marker is per name AND owner, so a shared alias still classifies every
 * property that uses it while a cycle cannot spin.
 */
function resolvePendingAttribution(
  sink: KeySink,
  index: ContractIndex,
  visitedAliases: Set<string>
): void {
  const attribution = sink.aliases.pop();
  if (!attribution) {
    return;
  }
  const marker = `${attribution.name} ${attribution.ownerKey}`;
  if (visitedAliases.has(marker)) {
    return;
  }
  visitedAliases.add(marker);
  for (const declaration of index.types.get(attribution.name) ?? []) {
    if (!ts.isTypeAliasDeclaration(declaration)) {
      continue;
    }
    if (
      applyScalarKind(scalarKindOfType(declaration.type), attribution, sink)
    ) {
      continue;
    }
    enqueueAlias(scalarAliasName(declaration.type), attribution.ownerKey, sink);
  }
  for (const initializer of index.values.get(attribution.name) ?? []) {
    resolveSchemaAttribution(initializer, attribution, sink);
  }
}

function resolveSchemaAttribution(
  initializer: ts.Expression,
  attribution: PendingAttribution,
  sink: KeySink
): void {
  const classified = classifyZodScalar(initializer);
  if (!classified) {
    return;
  }
  if ("alias" in classified) {
    enqueueAlias(classified.alias, attribution.ownerKey, sink);
    return;
  }
  applyScalarKind(classified.kind, attribution, sink);
}

function applyScalarKind(
  kind: ScalarKind | undefined,
  attribution: PendingAttribution,
  sink: KeySink
): boolean {
  if (kind === "date") {
    sink.keys.add(attribution.ownerKey);
    return true;
  }
  if (kind === "string") {
    sink.stringKeys.add(attribution.ownerKey);
    return true;
  }
  return false;
}

/** Whether an expression builds a Zod schema that infers to `string`. */
function isZodStringExpression(expression: ts.Expression): boolean {
  let found = false;
  const walk = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ZOD_STRING_CALLEE.test(node.expression.getText())
    ) {
      found = true;
    }
    ts.forEachChild(node, walk);
  };
  walk(expression);
  return found;
}
