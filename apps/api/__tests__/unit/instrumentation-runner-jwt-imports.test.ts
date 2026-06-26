import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../../..");
const AUTH_ROOT = path.join(REPO_ROOT, "packages/auth");
const INSTRUMENTATION_PATH = path.join(
  REPO_ROOT,
  "apps/api/instrumentation.ts"
);
const NODE_ONLY_JWT_MODULES = new Set([
  path.join(AUTH_ROOT, "loop-runner-jwt.ts"),
  path.join(AUTH_ROOT, "chat-runner-jwt.ts"),
]);

function getImportSpecifiers(filePath: string): string[] {
  const source = ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const imports: string[] = [];

  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      imports.push(statement.moduleSpecifier.text);
    }
  }

  return imports;
}

function resolveAuthModule(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith("@repo/auth/")) {
    const modulePath = path.join(
      AUTH_ROOT,
      `${specifier.slice("@repo/auth/".length)}.ts`
    );
    return existsSync(modulePath) ? modulePath : null;
  }

  if (specifier.startsWith(".") && fromFile.startsWith(AUTH_ROOT)) {
    const modulePath = path.resolve(path.dirname(fromFile), `${specifier}.ts`);
    return existsSync(modulePath) ? modulePath : null;
  }

  return null;
}

function collectReachableAuthImports(entryPath: string): {
  nodeImports: string[];
  visitedAuthModules: Set<string>;
} {
  const visitedAuthModules = new Set<string>();
  const nodeImports: string[] = [];
  const stack = [entryPath];
  const seen = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);

    for (const specifier of getImportSpecifiers(current)) {
      if (specifier.startsWith("node:")) {
        nodeImports.push(
          `${path.relative(REPO_ROOT, current)} -> ${specifier}`
        );
        continue;
      }

      const authModule = resolveAuthModule(specifier, current);
      if (authModule) {
        visitedAuthModules.add(authModule);
        stack.push(authModule);
      }
    }
  }

  return { nodeImports, visitedAuthModules };
}

describe("api instrumentation runner JWT imports", () => {
  it("does not pull Node-only runner JWT issuers into the instrumentation import graph", () => {
    const { nodeImports, visitedAuthModules } =
      collectReachableAuthImports(INSTRUMENTATION_PATH);

    expect(
      [...visitedAuthModules].map((filePath) =>
        path.relative(REPO_ROOT, filePath)
      )
    ).not.toEqual(
      expect.arrayContaining(
        [...NODE_ONLY_JWT_MODULES].map((filePath) =>
          path.relative(REPO_ROOT, filePath)
        )
      )
    );
    expect(nodeImports).toEqual([]);
  });
});
