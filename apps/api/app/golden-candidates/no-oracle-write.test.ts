import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GOLDEN_CANDIDATES_PATH } from "@repo/api/src/types/golden-candidate";
import ts from "typescript6";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * FEA-4171 golden rule guard: the candidate pipeline surfaces CANDIDATES only —
 * it must never create, write, or otherwise touch a `packages/golden-sessions/`
 * oracle file. These tests prove that boundary structurally (via the module's
 * import graph / AST, the sanctioned mechanism) rather than by scanning text, so
 * a future edit that reaches for the filesystem or the golden-sessions package
 * fails here instead of silently corrupting the frozen oracle.
 */
describe("golden-candidate pipeline is candidates-only (no oracle write)", () => {
  it("exposes candidates at the non-oracle /golden-candidates route, not a golden-sessions path", () => {
    expect(GOLDEN_CANDIDATES_PATH).toBe("/golden-candidates");
    expect(GOLDEN_CANDIDATES_PATH).not.toContain("golden-sessions");
  });

  it("imports neither the golden-sessions package nor any filesystem-write module", () => {
    for (const file of ["service.ts", "route.ts"]) {
      const importSpecifiers = collectImportSpecifiers(join(HERE, file));
      for (const specifier of importSpecifiers) {
        expect(
          specifier.includes("golden-sessions"),
          `${file} must not import golden-sessions (${specifier})`
        ).toBe(false);
        // The pipeline is a pure DB read; it has no business writing files.
        expect(
          specifier === "node:fs" || specifier === "node:fs/promises",
          `${file} must not import a filesystem module (${specifier})`
        ).toBe(false);
      }
    }
  });
});

/** Parse a source file and return every static/dynamic import module specifier. */
function collectImportSpecifiers(filePath: string): string[] {
  const source = ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}
