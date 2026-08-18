import { readFileSync } from "node:fs";
import ts from "typescript6";

/**
 * TypeScript-AST plumbing shared by the desktop structural guardrail tests
 * (cloud-socket-presence, worker-entry-bundling).
 *
 * AGENTS.md → "Test Practices": a structural invariant that cannot be driven
 * behaviorally is pinned by parsing the module with the TypeScript compiler API
 * and asserting on the resolved AST — never by regexing the raw source text
 * (which breaks on reformatting and can be satisfied by a comment). Only the
 * parse + walk live here; each test keeps its own domain predicates.
 */

/**
 * Parse `filePath` into a `SourceFile`. Parent pointers are NOT set — callers
 * assert on structure via `forEachNode`, never via `node.getText()`.
 */
export function parseTypeScriptFile(filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    false
  );
}

/** Pre-order visit of `root` and every descendant. */
export function forEachNode(
  root: ts.Node,
  visit: (node: ts.Node) => void
): void {
  const walk = (node: ts.Node): void => {
    visit(node);
    ts.forEachChild(node, walk);
  };
  walk(root);
}
