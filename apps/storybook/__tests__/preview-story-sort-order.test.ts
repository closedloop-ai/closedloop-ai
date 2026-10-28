import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";
import { describe, expect, it } from "vitest";
import { buildStorySortOrder } from "../story-group-order";

/**
 * `.storybook/preview.tsx`'s `storySort.order` has to be a literal — Storybook's
 * story-index build statically parses that file's AST and errors on a
 * `CallExpression`, so it cannot just call `buildStorySortOrder()` the way the
 * Start Here/Catalog page does. That literal has drifted from the function
 * twice already (PR #7510 review): once when a taxonomy level's own subgroup
 * list changed, and once when two new Surfaces (PRDs, Implementation Plans)
 * were added to `story-group-order.ts` without the copy in `preview.tsx`
 * being regenerated. Both landed the sidebar order and the Catalog page's own
 * order (which DOES call the function) silently disagreeing.
 *
 * This test is the fix the review asked for: parse the literal back out of
 * `preview.tsx` and deep-equal it against the function's live output, so the
 * next group added anywhere in `story-group-order.ts` fails HERE instead of
 * shipping a silent sidebar/Catalog disagreement.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PREVIEW_PATH = path.join(REPO_ROOT, ".storybook/preview.tsx");

type OrderNode = string | readonly OrderNode[];

function evaluateOrderLiteral(node: ts.Expression): OrderNode {
  if (ts.isStringLiteralLike(node)) {
    return node.text;
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map(evaluateOrderLiteral);
  }
  throw new Error(
    `Unexpected node kind ${ts.SyntaxKind[node.kind]} in storySort.order — this evaluator only understands string and array literals.`
  );
}

/** Finds the (sole) `order:` property assignment anywhere in the file. */
function findOrderLiteral(source: ts.SourceFile): ts.Expression {
  let found: ts.Expression | undefined;

  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "order" &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      if (found) {
        throw new Error(
          "Multiple `order:` array-literal properties found in preview.tsx — this test assumed exactly one."
        );
      }
      found = node.initializer;
    }
    node.forEachChild(visit);
  };
  visit(source);

  if (!found) {
    throw new Error("No `order:` array-literal property found in preview.tsx");
  }
  return found;
}

describe("preview.tsx's inlined storySort.order", () => {
  it("matches buildStorySortOrder()'s live output", () => {
    const source = ts.createSourceFile(
      PREVIEW_PATH,
      readFileSync(PREVIEW_PATH, "utf8"),
      ts.ScriptTarget.Latest,
      true
    );

    const inlined = evaluateOrderLiteral(findOrderLiteral(source));

    expect(inlined).toEqual(buildStorySortOrder());
  });
});
