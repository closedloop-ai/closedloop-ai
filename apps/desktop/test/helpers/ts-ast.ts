import { readFileSync } from "node:fs";
import ts from "typescript6";

/**
 * TypeScript-AST plumbing shared by the desktop structural guardrail tests
 * (cloud-socket-presence, worker-entry-bundling).
 *
 * AGENTS.md → "Test Practices": a structural invariant that cannot be driven
 * behaviorally is pinned by parsing the module with the TypeScript compiler API
 * and asserting on the resolved AST — never by regexing the raw source text
 * (which breaks on reformatting and can be satisfied by a comment). Only
 * language-level plumbing lives here — the parse, the walk, and the shape
 * readers over them; each test keeps its own domain predicates.
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

/**
 * The initializer of the first `<name>:` property assignment under `root`.
 *
 * Shared rather than re-declared per suite: two guards over the same wiring
 * that disagree about what "the options literal passes X" means are worse than
 * one, and the ISS-8600 seam is read by more than one of them.
 */
export function propertyInitializer(
  root: ts.Node,
  name: string
): ts.Expression | undefined {
  let initializer: ts.Expression | undefined;
  forEachNode(root, (node) => {
    if (
      initializer === undefined &&
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      initializer = node.initializer;
    }
  });
  return initializer;
}

/**
 * `<receiver>.<member>` as a pair, when `node` is exactly that.
 *
 * Shared rather than re-declared per suite (ISS-10110): two guards over the same
 * runtime that disagree about what "this expression is `app.isPackaged`" means
 * are worse than one, and the packaging-gate pin asserts the same shape the
 * ISS-8600 seam pin does.
 */
export function propertyAccessPair(
  node: ts.Node
): { receiver: string; member: string } | undefined {
  if (
    !(ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression))
  ) {
    return undefined;
  }
  return { receiver: node.expression.text, member: node.name.text };
}
