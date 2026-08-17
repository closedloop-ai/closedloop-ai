/**
 * @file agent-session-sync-event-pump-wire.test.ts
 * @description Goal stage 3 (ISS-5993) — pin the PRODUCTION wire of the
 * event-driven sync pump.
 *
 * `agent-session-sync-event-pump.test.ts` drives
 * `AgentSessionSyncService.notifyLocalSessionActivity()` directly, which proves
 * the pump's behaviour but nothing about whether anything in production ever
 * calls it. Deleting either half of the wire — the collector import's post-write
 * tee, or the bootstrap option that points that tee at the sync service — would
 * leave that whole suite green while shipping a lane that is back to waiting on
 * the 5s fallback sweep, i.e. silently un-fixing ISS-5993.
 *
 * Neither boundary can be instantiated in a unit test
 * (`createAgentDashboardDesignSystemRuntime` forks the db host, opens Electron
 * windows, and starts collectors), so the seam is pinned structurally, per
 * AGENTS.md → "Test Practices" and exactly as `post-boot-maintenance-wire.test.ts`
 * pins its own: parse with the TypeScript compiler API and assert on the
 * resolved AST, never on raw source text.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript6";
import { forEachNode, parseTypeScriptFile } from "./helpers/ts-ast.js";

const RUNTIME_PATH = join(
  import.meta.dirname,
  "../src/main/dashboard/agent-dashboard-design-system-runtime.ts"
);
const BOOTSTRAP_PATH = join(
  import.meta.dirname,
  "../src/main/dashboard/agent-dashboard-runtime-bootstrap.ts"
);

test("the collector import's post-write emit TEES into the sync pump", () => {
  // Half one of the wire: without this call the pump has no work-arrival
  // trigger at all and every pass is back to the 5s fallback sweep.
  assert.ok(
    callsMethodNamed(parseTypeScriptFile(RUNTIME_PATH), {
      method: "onLocalSessionDataChanged",
    }),
    "agent-dashboard-design-system-runtime.ts must call options.onLocalSessionDataChanged() from the CollectorManager emit — it is the work-arrival signal the event-driven lane runs on"
  );
});

test("the runtime bootstrap POINTS that tee at the sync service's pump", () => {
  // Half two: the option can be wired to nothing and the tee above becomes a
  // no-op (it is optional-chained), so the destination is asserted too.
  const source = parseTypeScriptFile(BOOTSTRAP_PATH);
  let wired = false;
  forEachNode(source, (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "onLocalSessionDataChanged" &&
      callsMethodNamed(node.initializer, {
        method: "notifyLocalSessionActivity",
      })
    ) {
      wired = true;
    }
  });
  assert.ok(
    wired,
    "buildRuntimeOptions must map onLocalSessionDataChanged to agentSessionSync.notifyLocalSessionActivity() — an unwired option leaves the pump permanently untriggered"
  );
});

/** Whether `root` contains a `<something>.<method>(...)` call. */
function callsMethodNamed(root: ts.Node, options: { method: string }): boolean {
  let found = false;
  forEachNode(root, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === options.method
    ) {
      found = true;
    }
  });
  return found;
}
