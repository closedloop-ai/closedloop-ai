/**
 * @file import-health-shutdown-order.test.ts
 * @description ISS-6336 (whitlockk review) — pin the ORDER of the two teardown
 * awaits in the dashboard runtime.
 *
 * `importHealth.shutdown()` drains the tally and then disposes the tracker, and
 * `noteIngestFailure` no-ops once disposed. So while the flush ran first, every
 * ingest failure raised by the still-running collector pass — the pass that
 * `cancelCollectorMaintenance()` is what ends — landed after the drain and was
 * dropped. Stopping the collectors first also settles the import generation, so
 * the rejections `historicalParseRunner.stop()` raises unwind through the
 * `isImportActive` gate in `collector-manager-source-parse.ts` rather than being
 * counted as a burst of `source_parse_threw` at every quit.
 *
 * Pinned structurally because `createAgentDashboardDesignSystemRuntime` cannot
 * be instantiated in a unit test — it forks the db host, opens Electron windows,
 * and starts collectors. Per AGENTS.md → "Test Practices", that means parsing
 * the module with the TypeScript compiler API and asserting on the resolved AST,
 * never on the raw source text (see the sibling `post-boot-maintenance-wire`
 * test for the same technique). Ordering is not otherwise observable: a
 * reordering back leaves every behavioral suite green while silently reopening
 * the drop.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import ts from "typescript6";
import { test } from "vitest";
import { forEachNode, parseTypeScriptFile } from "./helpers/ts-ast.js";

const RUNTIME_PATH = join(
  import.meta.dirname,
  "../src/main/dashboard/agent-dashboard-design-system-runtime.ts"
);

const CANCEL_MAINTENANCE = "cancelCollectorMaintenance";
const IMPORT_HEALTH = "importHealth";
const SHUTDOWN = "shutdown";

test("every teardown path stops the collectors BEFORE the final import-health flush (ISS-6336)", () => {
  const orderings = teardownAwaitOrderings();

  // Both `stop` and `close` tear the runtime down, and both used to flush
  // first. Asserting a count as well as the order keeps a future third path —
  // or a deleted one — from passing this vacuously.
  assert.equal(
    orderings.length,
    2,
    `expected the two teardown paths that await both ${CANCEL_MAINTENANCE}() and ${IMPORT_HEALTH}.${SHUTDOWN}(), found ${orderings.length}`
  );
  for (const ordering of orderings) {
    assert.deepEqual(
      ordering,
      [CANCEL_MAINTENANCE, `${IMPORT_HEALTH}.${SHUTDOWN}`],
      `a teardown path flushes import health before stopping the collectors, so a parse that fails while the pass winds down is dropped: got ${ordering.join(" then ")}`
    );
  }
});

/**
 * The relative order of the two awaited calls, once per function body that
 * awaits both. A body awaiting only one is not a teardown path and is skipped,
 * which is what keeps `restartCollectors` (collectors only) out of the set.
 */
function teardownAwaitOrderings(): string[][] {
  const source = parseTypeScriptFile(RUNTIME_PATH);
  const orderings: string[][] = [];
  forEachNode(source, (node) => {
    if (!(ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
      return;
    }
    const awaited = awaitedTeardownCalls(node.body);
    if (awaited.length === 2) {
      orderings.push(awaited);
    }
  });
  return orderings;
}

/**
 * The two calls of interest, in source order, awaited directly in `body`.
 *
 * The walk stops at a nested function so `close: () => lifecycle.close(async
 * () => {...})` reports its awaits once, against the inner body that owns them,
 * rather than a second time against the wrapper that merely encloses it.
 */
function awaitedTeardownCalls(body: ts.Node | undefined): string[] {
  if (!body) {
    return [];
  }
  const found: string[] = [];
  const walk = (node: ts.Node): void => {
    if (node !== body && isFunctionLike(node)) {
      return;
    }
    if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression)) {
      const name = calleeName(node.expression.expression);
      if (name !== null && !found.includes(name)) {
        found.push(name);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(body);
  return found;
}

/** Any construct that opens a new function body the walk must not enter. */
function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node)
  );
}

/** `cancelCollectorMaintenance` or `importHealth.shutdown`, else null. */
function calleeName(callee: ts.Expression): string | null {
  if (ts.isIdentifier(callee) && callee.text === CANCEL_MAINTENANCE) {
    return CANCEL_MAINTENANCE;
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === IMPORT_HEALTH &&
    callee.name.text === SHUTDOWN
  ) {
    return `${IMPORT_HEALTH}.${SHUTDOWN}`;
  }
  return null;
}
