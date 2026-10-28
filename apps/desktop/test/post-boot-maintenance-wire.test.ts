/**
 * @file post-boot-maintenance-wire.test.ts
 * @description ISS-4824 / ISS-4823 — pin the PRODUCTION wire between the
 * dashboard runtime and the extracted post-boot maintenance chain.
 *
 * Every other test for this work drives the lower layers directly:
 * `createPostBootMaintenance` in isolation, `runDataRevisionRebuild`'s adaptive
 * pause in isolation, `DbHostClient.isUnderMemoryPressure` in isolation. That
 * leaves the seam between them untested — deleting the `createPostBootMaintenance`
 * call from the runtime, or dropping the `isDbHostUnderMemoryPressure` argument
 * from it, would keep the whole suite green while shipping a chain that never
 * runs and a pressure arm that is permanently false. That is the exact defect
 * ISS-4823 exists to fix (the gate declared an input NO production call site
 * supplied), so it must not be reintroducible silently.
 *
 * `createAgentDashboardDesignSystemRuntime` cannot be instantiated in a unit test
 * — it forks the db host, opens Electron windows, and starts collectors — so the
 * invariant is pinned structurally, per AGENTS.md → "Test Practices": parse the
 * module with the TypeScript compiler API and assert on the resolved AST, never
 * on the raw source text.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import ts from "typescript6";
import { test } from "vitest";
import { createMaintenanceSettleNotifier } from "../src/main/lifecycle/post-boot-maintenance-settle.js";
import { forEachNode, parseTypeScriptFile } from "./helpers/ts-ast.js";

const RUNTIME_PATH = join(
  import.meta.dirname,
  "../src/main/dashboard/agent-dashboard-design-system-runtime.ts"
);

const LIFECYCLE_PATH = join(
  import.meta.dirname,
  "../src/main/dashboard/agent-dashboard-db-host-lifecycle.ts"
);

const MAINTENANCE_PATH = join(
  import.meta.dirname,
  "../src/main/dashboard/post-boot-maintenance.ts"
);

test("the dashboard runtime WIRES the extracted post-boot maintenance chain", () => {
  const call = findCreatePostBootMaintenanceCall();
  assert.ok(
    call,
    "agent-dashboard-design-system-runtime.ts must call createPostBootMaintenance() — without it the DATA_REVISION rebuild, artifact-link backfill, and activity-segment re-tiling never run after boot"
  );
});

test("that wire supplies the ISS-4823 db-host memory-pressure arm", () => {
  const call = findCreatePostBootMaintenanceCall();
  assert.ok(call, "createPostBootMaintenance() call not found");
  const properties = objectArgumentPropertyNames(call);

  // The regression: the rebuild's gate declared `isDbHostUnderMemoryPressure`
  // and no production call site supplied it, so the disjunct was permanently
  // false in the shipped app.
  assert.ok(
    properties.has("isDbHostUnderMemoryPressure"),
    "the createPostBootMaintenance() wire must pass isDbHostUnderMemoryPressure — an unsupplied arm reads as 'no pressure' forever, which is the ISS-4823 defect"
  );
  // Its sibling arm, wired since ISS-4711; both must reach the rebuild or the
  // adaptive pause degrades to one input.
  assert.ok(
    properties.has("hasRecentRendererRead"),
    "the createPostBootMaintenance() wire must pass hasRecentRendererRead"
  );
});

test("the db-host lifecycle EXPOSES the pressure read the wire consumes", () => {
  // The runtime reads the level through the lifecycle that owns the
  // DbHostClient; if that accessor disappears the wire above cannot be honest.
  const source = parseTypeScriptFile(LIFECYCLE_PATH);
  let exposed = false;
  forEachNode(source, (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "isUnderMemoryPressure"
    ) {
      exposed = true;
    }
  });
  assert.ok(
    exposed,
    "agent-dashboard-db-host-lifecycle.ts must expose isUnderMemoryPressure() — it owns the DbHostClient the cached level lives on"
  );
});

test("the rebuild HANDS OFF its changed sessions to the sync enqueue + live inject", () => {
  // ISS-5135 (whitlockk, #4382): the helper suites drive
  // `runDataRevisionSyncEnqueueAndFeed` directly and the live-inject suites start
  // on the far side of it, so DELETING this call from the rebuild leaves both
  // green while every rebuilt session silently stops reaching the cloud. The
  // boundary cannot be instantiated here — reaching the call means driving
  // `runDataRevisionRebuild` (a direct import) to a non-empty
  // `summary.changedSessionIds` against a real db host — so the seam is pinned
  // structurally, exactly as the runtime wire above is.
  const call = findCall(MAINTENANCE_PATH, "runDataRevisionSyncEnqueueAndFeed");
  assert.ok(
    call,
    "post-boot-maintenance.ts must call runDataRevisionSyncEnqueueAndFeed() — without it a DATA_REVISION rebuild re-derives sessions locally and never enqueues them for sync"
  );
  const properties = objectArgumentPropertyNames(call);

  // Each of these carries a distinct guarantee the helper cannot supply itself:
  // the id set, the CAPTURED target the outbox row is keyed under, the live
  // re-resolve that detects a mid-rebuild target swap, the delegate that actually
  // writes, the live-queue feed, and the post-await cancellation re-check.
  for (const required of [
    "changedSessionIds",
    "capturedComputeTargetId",
    "enqueueOutboxEntries",
    "resolveLiveComputeTargetId",
    "injectSyncBackfillIds",
    "shouldContinue",
  ]) {
    assert.ok(
      properties.has(required),
      `the runDataRevisionSyncEnqueueAndFeed() hand-off must pass ${required} — dropping it silently disables the guard it carries`
    );
  }
});

test("ISS-8601: the runtime re-arms maintenance from the boot-import TIMEOUT arm", () => {
  // Without this the timed-out launch drops the DATA_REVISION rebuild for good:
  // deleting the call leaves every other suite green, because nothing else drives
  // the timeout arm.
  const arm = findPropertyInitializer(RUNTIME_PATH, "onBootImportTimeout");
  assert.ok(
    arm,
    "agent-dashboard-design-system-runtime.ts must define an onBootImportTimeout arm"
  );
  const call = findCallWithin(arm, "scheduleWhenRendererIdle");
  assert.ok(
    call,
    "agent-dashboard-design-system-runtime.ts must call scheduleWhenRendererIdle() from onBootImportTimeout — without it a wedged first launch never re-derives anything"
  );
  const properties = objectArgumentPropertyNames(call);
  for (const required of ["hasRecentRendererRead", "run", "log"]) {
    assert.ok(
      properties.has(required),
      `the scheduleWhenRendererIdle() wire must pass ${required} — an unsupplied renderer signal reads as permanently idle`
    );
  }
});

test("ISS-8601: the re-armed run does NOT claim the import complete", () => {
  // Structural half: the re-arm passes `false`. The BEHAVIOURAL half is the two
  // cases below — an assertion that the argument appears would not prove the call
  // is actually suppressed.
  const arm = findPropertyInitializer(RUNTIME_PATH, "onBootImportTimeout");
  assert.ok(
    arm,
    "agent-dashboard-design-system-runtime.ts must define an onBootImportTimeout arm"
  );
  let passesFalse = false;
  forEachNode(arm, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "schedulePostBootMaintenance" &&
      node.arguments.length === 1 &&
      node.arguments[0].kind === ts.SyntaxKind.FalseKeyword
    ) {
      passesFalse = true;
    }
  });
  assert.ok(
    passesFalse,
    "the timeout re-arm must call schedulePostBootMaintenance(false) — claiming readiness over sources that were never imported is the defect the watchdog exists to avoid"
  );
});

test("ISS-11610: timeout releases background work without opening session upload readiness", () => {
  const arm = findPropertyInitializer(RUNTIME_PATH, "onBootImportTimeout");
  assert.ok(arm, "onBootImportTimeout arm not found");
  let opensProjectionReadiness = false;
  forEachNode(arm, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "notifySessionProjectionSettled"
    ) {
      opensProjectionReadiness = true;
    }
  });

  assert.equal(
    opensProjectionReadiness,
    false,
    "the timeout arm must keep uploads closed until its re-armed maintenance settles"
  );
});

test("ISS-8601: claimImportComplete false SUPPRESSES the readiness claim", () => {
  let importComplete = 0;
  let settled = 0;
  createMaintenanceSettleNotifier({
    claimImportComplete: false,
    onImportComplete: () => {
      importComplete++;
    },
    onSettled: () => {
      settled++;
    },
  })();

  assert.equal(importComplete, 0, "the cloud-read readiness bit must not move");
  assert.equal(
    settled,
    1,
    "but the deferred startup work is still released — the timeout arm already did this"
  );
});

test("ISS-8601: the DEFAULT path still claims it, so a real completion is unchanged", () => {
  // The counterfactual for the case above: if suppression were unconditional, an
  // ordinary complete boot import would stop clearing the Dashboard throbber.
  let importComplete = 0;
  let settled = 0;
  createMaintenanceSettleNotifier({
    claimImportComplete: true,
    onImportComplete: () => {
      importComplete++;
    },
    onSettled: () => {
      settled++;
    },
  })();

  assert.equal(importComplete, 1);
  assert.equal(settled, 1);
});

test("ISS-8601: cancelCollectorMaintenance CANCELS the pending re-arm", () => {
  // `cancelCollectorMaintenance` is reached from stop(), close() AND
  // restartCollectors(). Deleting the cancel leaves the whole suite green while
  // an unref'd 60s poll survives a collector restart and re-enters
  // `schedulePostBootMaintenance(false)` on a superseded generation. The handle
  // cannot be reached from a unit test — the runtime closure is not
  // instantiable — so the wiring is pinned structurally, like its siblings here.
  const source = parseTypeScriptFile(RUNTIME_PATH);
  let cancelsInside = false;
  forEachNode(source, (node) => {
    if (
      !(
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "cancelCollectorMaintenance" &&
        node.initializer
      )
    ) {
      return;
    }
    forEachNode(node.initializer, (inner) => {
      if (
        ts.isCallExpression(inner) &&
        inner.expression.getText(source).includes("timedOutMaintenanceReArm")
      ) {
        cancelsInside = true;
      }
    });
  });
  assert.ok(
    cancelsInside,
    "cancelCollectorMaintenance must cancel the timed-out maintenance re-arm — otherwise a restart leaves a live timer that fires maintenance on a superseded generation"
  );
});

/** The `createPostBootMaintenance(...)` call in the dashboard runtime, if any. */
function findCreatePostBootMaintenanceCall(): ts.CallExpression | null {
  return findCall(RUNTIME_PATH, "createPostBootMaintenance");
}

/** The last `<name>(...)` call expression in `path`, if any. */
function findCall(path: string, name: string): ts.CallExpression | null {
  const source = parseTypeScriptFile(path);
  let found: ts.CallExpression | null = null;
  forEachNode(source, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      found = node;
    }
  });
  return found;
}

/** The property names of a call's single object-literal argument. */
function objectArgumentPropertyNames(call: ts.CallExpression): Set<string> {
  const names = new Set<string>();
  const argument = call.arguments[0];
  if (!(argument && ts.isObjectLiteralExpression(argument))) {
    return names;
  }
  for (const property of argument.properties) {
    if (property.name && ts.isIdentifier(property.name)) {
      names.add(property.name.text);
    }
  }
  return names;
}

/**
 * The initializer subtree of one object-literal property, so a structural
 * assertion can be scoped to the arm it names.
 *
 * ISS-8601 (Codex review, #6909): {@link findCall} answers "does this module
 * call X anywhere", which stays green if the call MOVES OUT of the arm under
 * test and an unrelated one is added elsewhere. The two re-arm assertions above
 * search inside `onBootImportTimeout` only, so deleting the call from that arm
 * fails even while the identifier survives further down the file.
 */
function findPropertyInitializer(path: string, name: string): ts.Node | null {
  const source = parseTypeScriptFile(path);
  let found: ts.Node | null = null;
  forEachNode(source, (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = node.initializer;
    }
  });
  return found;
}

/** {@link findCall}, bounded to `root`'s subtree. */
function findCallWithin(root: ts.Node, name: string): ts.CallExpression | null {
  let found: ts.CallExpression | null = null;
  forEachNode(root, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      found = node;
    }
  });
  return found;
}
