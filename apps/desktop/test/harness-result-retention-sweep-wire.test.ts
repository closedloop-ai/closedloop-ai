/**
 * @file harness-result-retention-sweep-wire.test.ts
 * @description ISS-7332 — pin the PRODUCTION wire between app startup and the
 * boot-owned retention sweep.
 *
 * The sweep's own suite drives it directly, which leaves the seam untested:
 * deleting the `startHarnessResultRetentionSweep()` call from `startup.ts` — or
 * dropping the `will-quit` teardown that clears its interval — keeps every other
 * test green while shipping an app whose 90-day window is never enforced unless
 * a loop happens to finish, or whose timer outlives the app.
 *
 * `run()` cannot be driven in a unit test (it registers Electron protocol
 * handlers, acquires the single-instance lock, and constructs the application),
 * so the invariant is pinned structurally, per AGENTS.md → "Test Practices":
 * parse the module with the TypeScript compiler API and assert on the resolved
 * AST, never on the raw source text.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import ts from "typescript6";
import { test } from "vitest";
import { forEachNode, parseTypeScriptFile } from "./helpers/ts-ast.js";

const STARTUP_PATH = join(import.meta.dirname, "../src/main/startup.ts");
const SWEEP_STARTER = "startHarnessResultRetentionSweep";

test("startup WIRES the boot-owned retention sweep", () => {
  assert.ok(
    findCalleeNames().has(SWEEP_STARTER),
    `startup.ts must call ${SWEEP_STARTER}() — without it the 90-day window for retained plaintext envelopes is only ever enforced when another loop finishes`
  );
});

test("that wire imports the sweep from its owning module", () => {
  assert.ok(
    importedSpecifiers().some((specifier) =>
      specifier.endsWith("cost/harness-result-retention-sweep.js")
    ),
    `${SWEEP_STARTER} must come from the sweep module, so the call above cannot be satisfied by a local stub`
  );
});

test("the sweep is stopped on will-quit so its interval never outlives the app", () => {
  const stopped = findNodesWhere(
    (node) =>
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "stop" &&
      ts.isIdentifier(node.expression) &&
      node.expression.text.includes("RetentionSweep")
  );
  assert.ok(
    stopped.length > 0,
    "startup.ts must call stop() on the sweep handle — a superseded or app-lifetime timer must be cleared, not left running"
  );

  const quitListeners = findNodesWhere(
    (node) =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.name) &&
      node.expression.name.text === "on" &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "will-quit"
  );
  assert.equal(
    quitListeners.length,
    1,
    "exactly one will-quit listener must own that teardown"
  );
});

function findNodesWhere(predicate: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  forEachNode(parseTypeScriptFile(STARTUP_PATH), (node) => {
    if (predicate(node)) {
      found.push(node);
    }
  });
  return found;
}

function findCalleeNames(): Set<string> {
  const names = new Set<string>();
  forEachNode(parseTypeScriptFile(STARTUP_PATH), (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      names.add(node.expression.text);
    }
  });
  return names;
}

function importedSpecifiers(): string[] {
  const specifiers: string[] = [];
  forEachNode(parseTypeScriptFile(STARTUP_PATH), (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
  });
  return specifiers;
}
