/**
 * @file post-boot-maintenance-skill-inventory-order.test.ts
 * @description ISS-5260 — the post-boot chain must RUN the phantom-inventory
 * repair, and must run it BEFORE the data-revision rebuild.
 *
 * The repair's own suite
 * (`component-invocations-skill-inventory-repair.test.ts`) drives
 * `repairSkillShadowedCommandInventory` directly against a real store, so
 * deleting the `skillShadowInventory.repair` invoke from the maintenance chain
 * would leave it green while shipping a repair that never runs — the failure
 * mode AGENTS.md → "Test the production wiring, not only the unit" describes.
 *
 * Order is load-bearing, not cosmetic. The repair PARKS the affected sessions at
 * `DATA_REVISION_MAINTENANCE_STALE`; the rebuild is what re-derives them onto
 * the skill. Running the repair after the rebuild would leave every parked
 * session waiting a full extra boot, with its invocations pointing at a
 * component row that no longer exists.
 *
 * Driven behaviorally through `createPostBootMaintenance` with a recording
 * double, rather than pinned structurally — the chain is a plain factory over
 * injected deps, so the real call sequence is observable here.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import ts from "typescript6";
import { createPostBootMaintenance } from "../src/main/dashboard/post-boot-maintenance.js";
import { SKILL_SHADOW_INVENTORY_REPAIR_OP } from "../src/main/database/skill-shadow-inventory-repair-boundary.js";
import { forEachNode, parseTypeScriptFile } from "./helpers/ts-ast.js";

/** The rebuild's FIRST db touch — the marker for "the rebuild has begun". */
const REBUILD_STARTED = "listStaleRevisionSessions";
const REPAIR = SKILL_SHADOW_INVENTORY_REPAIR_OP;

describe("ISS-5260 post-boot chain runs the inventory repair before the rebuild", () => {
  test("the repair is invoked, and invoked before the rebuild reads stale sessions", async () => {
    const { calls, maintenance } = buildMaintenance();

    await maintenance.runPostBootMaintenance(1);

    assert.ok(
      calls.includes(REPAIR),
      `the post-boot chain must invoke the "${SKILL_SHADOW_INVENTORY_REPAIR_OP}" store op — without it a phantom command row survives every boot and the Commands tab keeps rendering a component with no definition and no invocations`
    );
    assert.ok(
      calls.includes(REBUILD_STARTED),
      "the rebuild must still run — this test is only meaningful if both passes execute"
    );
    assert.ok(
      calls.indexOf(REPAIR) < calls.indexOf(REBUILD_STARTED),
      `the repair must run BEFORE the rebuild so the sessions it parks are re-derived by the very next pass; observed order: ${calls.join(" -> ")}`
    );
  });

  // Cancellation between the two passes must stop the chain: the repair has
  // already parked sessions durably, and a superseded generation must not go on
  // to drive a rebuild the runtime no longer owns.
  test("a generation cancelled during the repair does not start the rebuild", async () => {
    const { calls, maintenance } = buildMaintenance({
      cancelAfterRepair: true,
    });

    await maintenance.runPostBootMaintenance(1);

    assert.ok(calls.includes(REPAIR));
    assert.ok(
      !calls.includes(REBUILD_STARTED),
      "a cancelled generation must not proceed into the rebuild"
    );
  });
});

describe("ISS-5260 the repair store op is registered in the db host", () => {
  // The chain invokes by KEY, and an unregistered key throws
  // `db-host store op not found` only at runtime, on a real boot — the recording
  // double above would stay green through a rename. `db-host-worker.ts` cannot be
  // imported here (it wires `process.parentPort` at module scope), so the
  // registration is pinned structurally against the resolved AST, exactly as
  // `post-boot-maintenance-wire.test.ts` pins the runtime wire.
  test("db-host-worker registers the key the boundary invokes", () => {
    const source = parseTypeScriptFile(
      join(
        import.meta.dirname,
        "../src/main/database/db-host/db-host-worker.ts"
      )
    );
    let registered = false;
    forEachNode(source, (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isStringLiteral(node.name) &&
        node.name.text === SKILL_SHADOW_INVENTORY_REPAIR_OP
      ) {
        registered = true;
      }
    });
    assert.ok(
      registered,
      `db-host-worker.ts must register the "${SKILL_SHADOW_INVENTORY_REPAIR_OP}" store op — the maintenance chain invokes it by key, and an unregistered key throws only on a real boot`
    );
  });
});

/**
 * The maintenance chain over a recording double. The rebuild is allowed to fail
 * against the stub (it is caught and logged by the chain, exactly as a real
 * rebuild failure would be) — this test asserts the ORDER of the two passes, not
 * the rebuild's own behavior, which its dedicated suites cover.
 */
function buildMaintenance(options: { cancelAfterRepair?: boolean } = {}): {
  calls: string[];
  maintenance: ReturnType<typeof createPostBootMaintenance>;
} {
  const calls: string[] = [];
  let cancelled = false;
  const agentDatabase = {
    listStaleRevisionSessions: () => {
      calls.push(REBUILD_STARTED);
      return Promise.resolve([]);
    },
    sessions: { invalidateHistoricalDetails: () => undefined },
  };
  const invokeStoreOp = (name: string): Promise<unknown> => {
    if (name !== REPAIR) {
      return Promise.resolve(undefined);
    }
    calls.push(REPAIR);
    if (options.cancelAfterRepair) {
      cancelled = true;
    }
    return Promise.resolve({ deletedComponents: 1, markedSessions: 2 });
  };
  const maintenance = createPostBootMaintenance({
    agentDatabase: agentDatabase as never,
    cooperativeDelay: () => Promise.resolve(),
    getCollectors: () => [],
    getHistoricalParseRunner: () => null,
    getWindow: () => null,
    invokeStoreOp,
    isDbHostUnderMemoryPressure: () => false,
    isMaintenanceActive: () => !cancelled,
    log: () => undefined,
    resolveComputeTargetId: () => null,
    setMaintenancePhase: () => undefined,
  });
  return { calls, maintenance };
}
