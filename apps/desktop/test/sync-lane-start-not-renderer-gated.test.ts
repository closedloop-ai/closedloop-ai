/**
 * @file sync-lane-start-not-renderer-gated.test.ts
 * @description ISS-4717: the desktop→cloud sync lanes must be STARTED
 * unconditionally, never behind a readiness signal.
 *
 * `main/sync/AGENTS.md` invariant 9 says lane progress must not depend on
 * renderer or UI state. That is usually read as being about what a lane does
 * once running — but the sharper failure is the moment of `start()`. A lane that
 * is never started cannot dead-letter, retry, or report; it silently stops
 * existing, and every row it would have delivered is stranded on the machine
 * with no diagnostic anywhere.
 *
 * WHAT WAS THERE. `startAgentCapture` carried a `startSessionSync` branch that
 * did `await this.rendererGates.whenInitialCollectorImportComplete()` before
 * `startAgentSessionSync`. That promise had exactly one producer — post-boot
 * maintenance settling for the still-active generation — so it never resolved
 * when the FEA-4156 boot-import watchdog gave up on a wedged harness, when the
 * runtime closed before maintenance settled, or when collectors never started.
 * Commit 12bd6c45e had already moved the real start to a direct, unconditional
 * call in `schedulePostInitialWindowBootTasks`, leaving that branch unreachable
 * (every caller passed `startSessionSync: false`) — but unreachable is not the
 * same as gone: restoring the argument, or adding a caller that omitted it,
 * would have re-parked all four upload lanes for the life of the process.
 * ISS-4717 deleted the branch, its two now-unused options, and the unbounded
 * `whenInitialCollectorImportComplete()` promise itself.
 *
 * WHAT WAS STILL THERE (codex, PR #4665). Deleting the INNER gate was not
 * enough, and the first version of this file could not see why: it only
 * inspected the direct `this.rendererGates.*` calls inside the owning method,
 * never the outer trigger that decides whether that method's body runs at all.
 * The lane start sat in `schedulePostInitialWindowBootTasks`'s local `start()`
 * closure, invoked ONLY from `desktopWindow.whenInitiallyShown().then(...)`.
 * That promise resolves off `InitialWindowRevealGate.markRevealed`, reached
 * only through `requestReveal()`, whose only callers are the renderer's
 * `desktop:renderer-ready` IPC and an explicit user/activate show. The gate's
 * readiness wait is bounded — but the bound is only ARMED by `requestReveal()`,
 * so a renderer that dies before its first readiness IPC, with no user open,
 * arms nothing and leaves `whenInitiallyShown()` pending for the life of the
 * process. Same stranded-local-data failure, displaced one level out. The fix
 * moved the start to `startSyncLanesAtBoot`, called straight from `boot()`, and
 * the `laneStartPath` walk below is what makes re-parenting it under any
 * renderer/window promise fail here instead of in the field.
 *
 * WHY AST. `app.ts` statically imports `electron`, so neither method can be
 * loaded — let alone driven — from a node test. This is the sanctioned
 * `ts.createSourceFile` guard (see `scripts/lint/rules/no-raw-text-source-scan.ts`
 * and the precedent in `initial-window-reveal-wiring.test.ts`). The assertions
 * are deliberately about STRUCTURE — which method calls what — because that is
 * exactly what a re-gating regression changes, and it is the one property no
 * runnable test in this package can observe. The walk itself now lives in
 * `support/app-module-ast.ts`, shared with the ISS-5990 guard.
 *
 * WHAT ISS-5990 THEN FIXED, and why this file did not catch it. Everything here
 * is about the lane `start()`. It went on passing while the lanes could not
 * DELIVER: `getSyncSource()` stayed null for the life of a headless boot because
 * the runtime that produces the source was itself composed behind
 * `whenInitiallyShown()`. See `boot-admission-not-window-gated.test.ts` — the
 * lesson is that "not gated" has to cover every step delivery depends on, not
 * just the one this file happens to name.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Node } from "typescript6";
import {
  forEachChild,
  isCallExpression,
  isPropertyAccessExpression,
} from "typescript6";

import { RendererReadinessGates } from "../src/main/lifecycle/renderer-readiness-gates.js";
import {
  callPathFrom,
  callSitesOf,
  callsInside,
  findMethod,
  parseAppModule,
} from "./support/app-module-ast.js";

/** The method that owns the real, unconditional sync-lane start. */
const LANE_OWNER_METHOD = "startSyncLanesAtBoot";
/** The capture-startup method, which awaits renderer readiness gates. */
const RENDERER_GATED_METHOD = "startAgentCapture";
/** The window-deferred boot block. Its body runs only after boot admission. */
const WINDOW_DEFERRED_METHOD = "schedulePostInitialWindowBootTasks";
/** The method that must reach the lane start with nothing in between. */
const BOOT_METHOD = "boot";
/** The call every lane start goes through. */
const LANE_START_CALL = "startAgentSessionSync";

/**
 * Every promise in `app.ts` whose resolution depends on the renderer or the
 * window — i.e. every wait the lane start must not sit behind, transitively.
 *
 * `whenInitiallyShown` is the one that mattered on PR #4665, and it reads as
 * safe because the reveal gate's readiness wait is bounded. It is not: that
 * bound is armed by `requestReveal()`, and only the renderer-ready IPC and an
 * explicit show call reach that (ISS-5990 gave the ADMISSION sites a
 * main-process-armed deadline instead; the lane start still sits behind none of
 * these at all). The rest are listed because they are the same shape — a signal
 * the main process cannot produce for itself.
 */
const RENDERER_OR_WINDOW_WAITS = new Set([
  "whenInitiallyShown",
  "whenInitialRendererMounted",
  "whenInitialDashboardDataServed",
  "whenInitialRendererLiveDbIdle",
  "whenInitialDashboardBackgroundWorkAllowed",
  "whenInitialCollectorImportComplete",
  "waitForInitialWindowRevealReadiness",
  "waitForInitialDashboardDataServedOrTimeout",
  "waitForInitialRendererLiveDbIdleOrTimeout",
  "waitForDashboardReadinessBeforeCloudSocket",
  "waitForRendererBackgroundSlot",
  "waitForReadiness",
]);

/** Every `this.rendererGates.<name>()` call inside `methodName`. */
function rendererGateCallsInside(methodName: string): string[] {
  const sourceFile = parseAppModule();
  const method = findMethod(methodName, sourceFile);
  const names: string[] = [];
  const visit = (node: Node): void => {
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(sourceFile) === "this.rendererGates"
    ) {
      names.push(node.expression.name.getText(sourceFile));
    }
    forEachChild(node, visit);
  };
  forEachChild(method, visit);
  return names;
}

/** The ISS-4717 walk: renderer/window waits between `boot()` and the lane start. */
function laneStartPath(): { waits: string[]; roots: string[] } {
  return callPathFrom(LANE_START_CALL, RENDERER_OR_WINDOW_WAITS);
}

describe("ISS-4717 the sync lanes are started, always", () => {
  test("the lane owner starts them", () => {
    assert.ok(
      callsInside(LANE_OWNER_METHOD).includes("startAgentSessionSync"),
      `${LANE_OWNER_METHOD} is the only place the four upload lanes are started; dropping this call strands every locally captured row`
    );
  });

  test("the lane owner consults NO renderer readiness gate", () => {
    // The teeth of invariant 9. Any `this.rendererGates.*()` here would make the
    // lane start depend on renderer state — and the two unbounded gates on that
    // object would make it depend on a signal that may never arrive.
    assert.deepEqual(
      rendererGateCallsInside(LANE_OWNER_METHOD),
      [],
      "sync lane startup must not consult renderer readiness"
    );
  });

  test("capture startup does NOT start the lanes", () => {
    // startAgentCapture awaits renderer readiness gates, so anything started
    // from it inherits a renderer dependency. Keep the lanes out of it.
    assert.equal(
      callsInside(RENDERER_GATED_METHOD).includes("startAgentSessionSync"),
      false,
      `${RENDERER_GATED_METHOD} awaits renderer gates; starting the lanes here re-gates them on the renderer`
    );
  });

  test("nothing awaits an unbounded collector-import promise", () => {
    assert.equal(
      callsInside(RENDERER_GATED_METHOD).includes(
        "whenInitialCollectorImportComplete"
      ),
      false,
      "whenInitialCollectorImportComplete never fires on a timed-out boot import"
    );
  });

  test("the window-deferred boot block does NOT start the lanes", () => {
    // schedulePostInitialWindowBootTasks defers its body behind the window
    // reveal. Hosting the lane start there is the outer gate codex found on PR
    // #4665; ISS-5990 bounded that deferral on a main-process clock, which makes
    // it late rather than never — still the wrong home for a lane start.
    assert.equal(
      callsInside(WINDOW_DEFERRED_METHOD).includes(LANE_START_CALL),
      false,
      `${WINDOW_DEFERRED_METHOD} runs only after the window reveal; starting the lanes there strands every row when the renderer dies before its first readiness IPC`
    );
  });

  test("the lane start has exactly ONE call site", () => {
    // AGENTS.md invariant 9: "start a new lane from there, and nowhere else".
    // It is also what lets the path walk below insist that EVERY route to the
    // lane start is wait-free rather than merely one of them.
    assert.equal(
      callSitesOf(LANE_START_CALL, parseAppModule()).length,
      1,
      `${LANE_START_CALL} must have a single caller (${LANE_OWNER_METHOD}); a second one is a second policy for when the lanes start`
    );
  });

  test("NO renderer/window promise sits anywhere on the path to the lane start", () => {
    // The outer-trigger check. Walks every caller frame from the
    // startAgentSessionSync call outward, so an `await` or `.then(...)` on a
    // renderer/window signal fails here no matter how many hops away it is.
    assert.deepEqual(
      laneStartPath().waits,
      [],
      "the lane start must not be re-parented under a renderer- or window-readiness promise; those resolve off signals the main process cannot produce for itself"
    );
  });

  test("the lane start is reachable from boot() itself", () => {
    // Pairs with the check above: "no waits found" would also be true of a lane
    // start nothing calls at all. The walk must terminate at boot().
    assert.deepEqual(laneStartPath().roots, [BOOT_METHOD]);
  });
});

describe("ISS-4717 RendererReadinessGates exposes no unbounded import wait", () => {
  test("the collector-import signal is a boolean, not a promise", () => {
    // Removing the promise is what makes the guards above unnecessary to trust:
    // there is no longer an unbounded wait for a future caller to find. A
    // reintroduced `whenInitialCollectorImportComplete()` fails here first.
    const gates = new RendererReadinessGates({
      info: () => undefined,
      warn: () => undefined,
    });
    assert.equal(
      "whenInitialCollectorImportComplete" in gates,
      false,
      "read isInitialCollectorImportComplete(); do not reintroduce an unbounded promise"
    );
    assert.equal(typeof gates.isInitialCollectorImportComplete, "function");
  });

  test("the boolean still reports the genuine completion it gates cloud reads on", () => {
    // `getCloudReadReadiness().importComplete` reads this to decide whether the
    // renderer may cut over to reading the cloud, so it must stay false until a
    // real completion and true after one.
    const gates = new RendererReadinessGates({
      info: () => undefined,
      warn: () => undefined,
    });
    assert.equal(gates.isInitialCollectorImportComplete(), false);
    gates.notifyInitialCollectorImportComplete();
    assert.equal(gates.isInitialCollectorImportComplete(), true);
  });
});
