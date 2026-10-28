import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript6";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * `readGitHubRouteOutcome` in `route.ts` parses the handler's body with
 * `response.clone().json()` and has no fallback: a bodyless 2xx would reject
 * there and escalate an already-handled webhook to a 500. `NextResponse<Body>`
 * cannot carry that invariant — its constructor never constrains `Body`, so
 * `new NextResponse(null, { status: 204 })` satisfies any annotation a handler
 * declares. This guard is the enforcement instead: inside the webhook tree the
 * only way to produce a `Response` is `NextResponse.json(...)`, which always
 * writes a JSON body.
 */
describe("github webhook handlers answer with a JSON body", () => {
  it("scans every handler module route.ts routes through", () => {
    const scanned = new Set(collectScannedModules());
    const routed = collectRoutedHandlerModules();

    expect(routed.length).toBeGreaterThan(0);
    for (const module of routed) {
      expect(
        scanned.has(module),
        `route.ts imports ${module} but this guard does not scan it`
      ).toBe(true);
    }
  });

  it("produces responses only through NextResponse.json", () => {
    let jsonCalls = 0;

    for (const module of collectScannedModules()) {
      const producers = collectResponseProducers(join(HERE, module));
      jsonCalls += producers.members.filter((name) => name === "json").length;

      expect(
        producers.constructed,
        `${module} constructs a Response directly; a bodyless body would reject in readGitHubRouteOutcome`
      ).toEqual([]);
      for (const member of producers.members) {
        expect(
          member,
          `${module} reaches for NextResponse.${member}, which need not write a JSON body`
        ).toBe("json");
      }
    }

    expect(jsonCalls).toBeGreaterThan(0);
  });
});

/** Every non-test module in the webhook tree, repo-relative to this file. */
function collectScannedModules(): string[] {
  const modules: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
        modules.push(relative(HERE, absolute));
      }
    }
  };
  walk(HERE);
  return modules.sort();
}

/** The `./handlers/*` value imports route.ts actually routes events to. */
function collectRoutedHandlerModules(): string[] {
  const source = parse(join(HERE, "route.ts"));
  const modules: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    if (statement.importClause?.isTypeOnly !== false) {
      continue;
    }
    if (!ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    if (specifier.startsWith("./handlers/")) {
      modules.push(`${specifier.slice(2)}.ts`);
    }
  }
  return modules;
}

/** Response constructor calls and `Response`/`NextResponse` static members. */
function collectResponseProducers(filePath: string): {
  constructed: string[];
  members: string[];
} {
  const constructed: string[] = [];
  const members: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      isResponseNamespace(node.expression.text)
    ) {
      constructed.push(node.expression.text);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      isResponseNamespace(node.expression.text)
    ) {
      members.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(filePath));
  return { constructed, members };
}

function parse(filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
}

function isResponseNamespace(name: string): boolean {
  return name === "Response" || name === "NextResponse";
}
