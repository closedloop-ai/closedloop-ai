import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript6";
import { describe, expect, it } from "vitest";

// Match the real credential shape: tk_<20+> or sk_<20+>. Test fixtures use the
// short "tk_test"/"sk_test" placeholders, which must NOT match.
const SECRET_LIKE_RE = /(?:tk|sk)_[A-Za-z0-9]{20,}/;

/**
 * Collect every string/template-literal text value in a source file via the
 * TypeScript AST. AST-based (not raw-text) so it inspects only real string
 * values: a `tk_...`-shaped literal committed as a credential fails, while
 * the token being named in a comment or docstring does not. This is the
 * sanctioned mechanism for the "no committed secret" invariant (AGENTS.md:
 * source-text regex guards are banned; AST assertions are allowed).
 */
function collectStringLiteralValues(sourcePath: string): string[] {
  const sourceText = readFileSync(sourcePath, "utf8");
  const sourceFile = ts.createSourceFile(
    sourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true
  );
  const values: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      values.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      values.push(node.head.text);
      for (const span of node.templateSpans) {
        values.push(span.literal.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return values;
}

describe("no committed secret", () => {
  it("does not hardcode a Pensero tk_/sk_ token literal in keys.ts", () => {
    const sourcePath = fileURLToPath(new URL("../keys.ts", import.meta.url));
    const literals = collectStringLiteralValues(sourcePath);
    const offending = literals.filter((value) => SECRET_LIKE_RE.test(value));
    expect(offending).toEqual([]);
  });
});
