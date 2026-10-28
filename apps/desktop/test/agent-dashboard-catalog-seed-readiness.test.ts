/**
 * @file agent-dashboard-catalog-seed-readiness.test.ts
 * @description ISS-6170 — the catalog-seeded signal must mean the catalog is
 * actually POPULATED.
 *
 * `seedAgentDashboardCatalog` swallows its own failure so a bad seed can never
 * break boot (ISS-4771), and the runtime then announced catalog readiness
 * unconditionally. ISS-4428 wires that announcement to
 * `RequiredPluginInstaller.notifyRuntimeReady()`, and ISS-6170 made it the gate
 * that permits a permanent give-up. So on a fresh store whose seed FAILED, the
 * next ordinary `ENOTFOUND` — which at that moment means "the catalog is still
 * empty", the one case that is transient — was latched as a pack this build can
 * never install, removing the retry path the gate exists to preserve. Reported
 * by whitlockk on #5882.
 *
 * The seed helper's own contract is driven directly below. The runtime's use of
 * it is pinned structurally, for the reason `post-boot-maintenance-wire.test.ts`
 * states for the same module: `createAgentDashboardDesignSystemRuntime` forks
 * the db host, opens Electron windows and starts collectors, so the branch
 * cannot be executed in a unit test. Per AGENTS.md → "Test Practices" the
 * fallback is the resolved TypeScript AST, never a raw-source scan.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import ts from "typescript6";
import { describe, test } from "vitest";
import { seedAgentDashboardCatalog } from "../src/main/dashboard/agent-dashboard-startup-maintenance.js";
import { forEachNode, parseTypeScriptFile } from "./helpers/ts-ast.js";

const RUNTIME_PATH = join(
  import.meta.dirname,
  "../src/main/dashboard/agent-dashboard-design-system-runtime.ts"
);

const SEED_OP = "catalog.seed";

describe("seedAgentDashboardCatalog — ISS-6170 readiness contract", () => {
  test("a seed that lands reports success", async () => {
    const ops: string[] = [];
    const seeded = await seedAgentDashboardCatalog(
      (op) => {
        ops.push(op);
        return Promise.resolve(undefined);
      },
      () => undefined
    );

    assert.equal(seeded, true);
    assert.deepEqual(ops, [SEED_OP]);
  });

  test("a seed that fails reports failure instead of throwing", async () => {
    const logged: string[] = [];
    // Boot must survive the failure — that is why the catch exists — but the
    // caller has to be able to tell the two outcomes apart, which is what a
    // swallowed failure took away.
    const seeded = await seedAgentDashboardCatalog(
      () => Promise.reject(new Error("db host is gone")),
      (_scope, message) => {
        logged.push(message);
      }
    );

    assert.equal(
      seeded,
      false,
      "a swallowed seed failure still leaves `pack_catalog` empty; reporting success there is what let the installer latch a legitimately installable pack"
    );
    assert.ok(
      logged.some((message) => message.includes("db host is gone")),
      "the failure must stay legible in the log"
    );
  });
});

describe("the dashboard runtime GATES catalog readiness on that contract", () => {
  test("onCatalogSeeded fires only inside a branch testing the seed result", () => {
    const source = parseTypeScriptFile(RUNTIME_PATH);
    const seedResultNames = new Set<string>();
    forEachNode(source, (node) => {
      // `const <name> = await seedAgentDashboardCatalog(...)` — the result has
      // to be captured at all before anything can branch on it.
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        callsSeedCatalog(node.initializer)
      ) {
        seedResultNames.add(node.name.text);
      }
    });

    assert.ok(
      seedResultNames.size > 0,
      "agent-dashboard-design-system-runtime.ts must capture seedAgentDashboardCatalog()'s result — discarding it is what made a failed seed indistinguishable from a good one"
    );

    const guardedCalls = countGuardedCatalogSeededCalls(
      source,
      seedResultNames
    );
    assert.equal(
      guardedCalls.total,
      1,
      "expected exactly one onCatalogSeeded call site to reason about"
    );
    assert.equal(
      guardedCalls.guarded,
      1,
      "the onCatalogSeeded announcement must sit inside an `if` whose condition reads the seed result — announcing readiness after a failed seed tells the required-plugin installer the catalog is populated when it is empty, and it then latches a transient ENOTFOUND as permanent"
    );
  });
});

/** True when `node` is (or awaits) a `seedAgentDashboardCatalog(...)` call. */
function callsSeedCatalog(node: ts.Expression): boolean {
  const inner = ts.isAwaitExpression(node) ? node.expression : node;
  return (
    ts.isCallExpression(inner) &&
    ts.isIdentifier(inner.expression) &&
    inner.expression.text === "seedAgentDashboardCatalog"
  );
}

/** True when `node` mentions any identifier in `names`. */
function mentionsAny(node: ts.Node, names: Set<string>): boolean {
  let found = false;
  forEachNode(node, (child) => {
    if (ts.isIdentifier(child) && names.has(child.text)) {
      found = true;
    }
  });
  return found;
}

/** True when `node` contains an `onCatalogSeeded` call. */
function containsCatalogSeededCall(node: ts.Node): boolean {
  let found = false;
  forEachNode(node, (child) => {
    if (
      ts.isCallExpression(child) &&
      mentionsPropertyNamed(child.expression, "onCatalogSeeded")
    ) {
      found = true;
    }
  });
  return found;
}

/** True when `node` is a property access ending in `name` (optional or not). */
function mentionsPropertyNamed(node: ts.Node, name: string): boolean {
  return (
    (ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node)) &&
    ts.isIdentifier(node.name) &&
    node.name.text === name
  );
}

/**
 * How many `onCatalogSeeded` calls exist, and how many of those sit inside an
 * `if` whose CONDITION reads one of `seedResultNames`. Counting both is what
 * stops the assertion passing vacuously on a module that stopped calling it.
 */
function countGuardedCatalogSeededCalls(
  source: ts.SourceFile,
  seedResultNames: Set<string>
): { guarded: number; total: number } {
  let total = 0;
  let guarded = 0;
  forEachNode(source, (node) => {
    if (
      ts.isCallExpression(node) &&
      mentionsPropertyNamed(node.expression, "onCatalogSeeded")
    ) {
      total++;
    }
    if (
      ts.isIfStatement(node) &&
      mentionsAny(node.expression, seedResultNames) &&
      containsCatalogSeededCall(node.thenStatement)
    ) {
      guarded++;
    }
  });
  return { guarded, total };
}
