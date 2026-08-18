import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript6";
import { describe, expect, it } from "vitest";

/**
 * ISS-5983: `/preview-schemas/ensure` SPAWNS the Prisma CLI, and Next's file
 * tracing follows imports — it cannot see a `spawnSync`. Every file the spawned
 * CLI needs therefore reaches the bundle ONLY through the explicit
 * `outputFileTracingIncludes` entry this test pins.
 *
 * Deleting or renaming any of these globs breaks the route on the NEXT deploy,
 * silently and greenly: nothing in the unit suite spawns a real CLI, and the
 * route's own runtime layout probe would then correctly report a bundle it
 * cannot use. Guarding the config is the only pre-deploy signal available.
 *
 * `next.config.ts` is TypeScript source, so it is parsed to an AST rather than
 * text-matched (AGENTS.md → Test Practices, no-raw-text-source-scan), matching
 * `__tests__/typecheck-owns-route-types.test.ts`.
 */

const NEXT_CONFIG_PATH = join(
  import.meta.dirname,
  "..",
  "..",
  "next.config.ts"
);
const ENSURE_ROUTE_KEY = "/preview-schemas/ensure";

function parseNextConfig(): ts.SourceFile {
  return ts.createSourceFile(
    NEXT_CONFIG_PATH,
    readFileSync(NEXT_CONFIG_PATH, "utf-8"),
    ts.ScriptTarget.Latest,
    true
  );
}

/** Finds `nextConfig.<property> = <expression>` and returns the right-hand side. */
function findAssignedExpression(
  source: ts.SourceFile,
  property: string
): ts.Expression | undefined {
  let found: ts.Expression | undefined;

  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === property
    ) {
      found = node.right;
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return found;
}

function readEnsureRouteIncludes(): string[] {
  const assigned = findAssignedExpression(
    parseNextConfig(),
    "outputFileTracingIncludes"
  );
  if (!(assigned && ts.isObjectLiteralExpression(assigned))) {
    return [];
  }

  for (const property of assigned.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      ts.isStringLiteral(property.name) &&
      property.name.text === ENSURE_ROUTE_KEY &&
      ts.isArrayLiteralExpression(property.initializer)
    ) {
      return property.initializer.elements
        .filter((element) => ts.isStringLiteral(element))
        .map((element) => element.text);
    }
  }
  return [];
}

/** The `".."` literals in `nextConfig.outputFileTracingRoot = path.join(…)`. */
function readTracingRootSegments(): string[] {
  const assigned = findAssignedExpression(
    parseNextConfig(),
    "outputFileTracingRoot"
  );
  if (!(assigned && ts.isCallExpression(assigned))) {
    return [];
  }
  return assigned.arguments
    .filter((argument) => ts.isStringLiteral(argument))
    .map((argument) => argument.text);
}

/** Every named binding `next.config.ts` imports. */
function readImportedNames(): string[] {
  const names: string[] = [];
  for (const statement of parseNextConfig().statements) {
    const bindings =
      ts.isImportDeclaration(statement) &&
      statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      names.push(...bindings.elements.map((element) => element.name.text));
    }
  }
  return names;
}

/** Names of the functions spread into the ensure route's include array. */
function readEnsureRouteSpreadCalls(): string[] {
  const assigned = findAssignedExpression(
    parseNextConfig(),
    "outputFileTracingIncludes"
  );
  if (!(assigned && ts.isObjectLiteralExpression(assigned))) {
    return [];
  }

  const names: string[] = [];
  for (const property of assigned.properties) {
    if (
      !(
        ts.isPropertyAssignment(property) &&
        ts.isStringLiteral(property.name) &&
        property.name.text === ENSURE_ROUTE_KEY &&
        ts.isArrayLiteralExpression(property.initializer)
      )
    ) {
      continue;
    }
    for (const element of property.initializer.elements) {
      if (
        ts.isSpreadElement(element) &&
        ts.isCallExpression(element.expression) &&
        ts.isIdentifier(element.expression.expression)
      ) {
        names.push(element.expression.expression.text);
      }
    }
  }
  return names;
}

describe("the ensure route's spawned Prisma CLI is traced into its bundle", () => {
  it("collects from the monorepo root, two levels above apps/api", () => {
    // Asserting the VALUE, not merely that something is assigned: a root left at
    // the app directory cannot collect a single one of these paths, and every
    // other assertion in this file would stay green.
    expect(readTracingRootSegments()).toEqual(["..", ".."]);
  });

  it("writes the globs relative to apps/api, not to the tracing root", () => {
    // The two bases are DIFFERENT. Next matches include globs with
    // `glob(pattern, { cwd: dir })` where `dir` is the Next project directory
    // (apps/api) — `outputFileTracingRoot` does not move it. Repo-root-relative
    // globs match nothing, silently, and the route 500s on every deploy.
    const includes = readEnsureRouteIncludes();
    const outsideApp = includes.filter((glob) =>
      glob.includes("packages/database")
    );

    expect(outsideApp.length).toBeGreaterThan(0);
    for (const glob of outsideApp) {
      expect(glob.startsWith("../../")).toBe(true);
    }
  });

  it("carries the migrations, schema and dependency-free runtime config", () => {
    const includes = readEnsureRouteIncludes();

    expect(includes).toContain("../../packages/database/prisma/schema.prisma");
    expect(includes).toContain("../../packages/database/prisma/migrations/**");
    expect(includes).toContain("../../packages/database/prisma-runtime/**");
  });

  it("computes the CLI's dependency closure and no longer carries the bin shim", () => {
    const includes = readEnsureRouteIncludes();

    // The CLI's own closure is walked at build time rather than enumerated; see
    // preview-schemas-ensure-cli-tracing.test.ts for what that walk guarantees.
    expect(readEnsureRouteSpreadCalls()).toContain("prismaCliTracingIncludes");

    /*
     * ISS-6403 deliberately INVERTED the shim half of this expectation. It used
     * to require `node_modules/.bin/prisma`, on the reasoning that pnpm writes
     * the shim into apps/api's own `.bin`. True, and useless: the shim
     * `require`s `<bin>/../prisma/build/index.js` through a symlink that
     * node-glob will not follow and no glob here matched, so the traced shim
     * could not load the CLI it launches and every `migrate deploy` on stage
     * died MODULE_NOT_FOUND.
     *
     * The route now names the store entrypoint through `PRISMA_CLI_ENTRY` and
     * nothing resolves through `PATH`, so tracing the shim would ship a
     * launcher no code invokes — and, worse, would let this suite keep implying
     * the CLI is reachable. Asserting its ABSENCE is what stops the shim from
     * being re-added as a "fix" the next time the route fails.
     */
    expect(includes).not.toContain("node_modules/.bin/prisma");
  });

  it("imports every helper it spreads into the include list", () => {
    // `next build` evaluates this config: an unimported identifier is a
    // ReferenceError that fails the whole api build, and every other assertion
    // in this file passes on the source text without ever resolving it.
    const imported = readImportedNames();

    for (const name of readEnsureRouteSpreadCalls()) {
      expect(imported).toContain(name);
    }
  });

  it("scopes the CLI's ~204 MB closure to the ensure route alone", () => {
    const assigned = findAssignedExpression(
      parseNextConfig(),
      "outputFileTracingIncludes"
    );
    const keys =
      assigned && ts.isObjectLiteralExpression(assigned)
        ? assigned.properties
            .filter((property) => ts.isPropertyAssignment(property))
            .map((property) =>
              ts.isStringLiteral(property.name) ? property.name.text : null
            )
        : [];

    // Tracing is keyed by route glob: a broader key here would put the CLI and
    // its native engines into every api function instead of this one.
    expect(keys).toEqual([ENSURE_ROUTE_KEY]);
  });
});
