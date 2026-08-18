/**
 * @file db-host-identity-bootstrap-wire.test.ts
 * @description ISS-6243 — pin the PRODUCTION wire that points the db host's
 * identity subscription at a real source.
 *
 * `db-host-identity-propagation.test.ts` proves the lifecycle publishes whatever
 * its `subscribeUserIdentityChanged` option is wired to, but it builds that
 * option itself. `user-identity-change-sources.test.ts` proves the two sources
 * fire. Neither executes `buildRuntimeOptions`, which is the single line that
 * connects the two halves — and because the option is declared OPTIONAL and the
 * lifecycle consumes it optional-chained, deleting that line TYPECHECKS and
 * leaves both suites green while the db host is driven only by its one post-start
 * reconcile. On a cold start that reconcile reads null (the `/me` warm has not
 * landed), so the child would hold null for its whole lifetime and stamp a null
 * owner on every session — exactly the defect ISS-6243 exists to fix, silently
 * restored.
 *
 * `buildRuntimeOptions` cannot be instantiated in a unit test (its deps reach
 * Electron, the collectors, and the db host), so the seam is pinned structurally,
 * per AGENTS.md → "Test Practices" and exactly as
 * `agent-session-sync-event-pump-wire.test.ts` pins its neighbour in this same
 * function: parse with the TypeScript compiler API and assert on the resolved
 * AST, never on raw source text.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript6";
import { forEachNode, parseTypeScriptFile } from "./helpers/ts-ast.js";

const BOOTSTRAP_PATH = join(
  import.meta.dirname,
  "../src/main/dashboard/agent-dashboard-runtime-bootstrap.ts"
);

test("the runtime bootstrap POINTS the db-host identity option at a real source", () => {
  const source = parseTypeScriptFile(BOOTSTRAP_PATH);
  let wired = false;
  forEachNode(source, (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "subscribeUserIdentityChanged" &&
      readsDepNamed(node.initializer, "subscribeUserIdentityChanged")
    ) {
      wired = true;
    }
  });
  assert.ok(
    wired,
    "buildRuntimeOptions must map subscribeUserIdentityChanged to deps.subscribeUserIdentityChanged — an unwired option leaves the db host on its boot snapshot, which is null by construction on a cold start"
  );
});

/** Whether `root` reads `deps.<name>` — the option's actual destination. */
function readsDepNamed(root: ts.Node, name: string): boolean {
  let found = false;
  forEachNode(root, (node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "deps" &&
      node.name.text === name
    ) {
      found = true;
    }
  });
  return found;
}
