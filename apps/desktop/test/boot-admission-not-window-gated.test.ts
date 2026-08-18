/**
 * @file boot-admission-not-window-gated.test.ts
 * @description ISS-5990: no boot-time admission decision may sit behind a RAW
 * window-reveal promise.
 *
 * `sync-lane-start-not-renderer-gated.test.ts` (ISS-4717) made the lane `start()`
 * unconditional and kept passing while the lanes still could not DELIVER. The
 * source they deliver from — `getSyncSource()` → `agentDashboardDesignSystem` —
 * is composed only by `ensureAgentDashboardDesignSystemRuntime()`, reachable at
 * boot only from `startAgentCapture()`, which runs only inside
 * `schedulePostInitialWindowBootTasks`'s deferral. That deferral was
 * `desktopWindow.whenInitiallyShown().then(...)`, a promise armed solely by
 * `InitialWindowRevealGate.requestReveal()` — i.e. by the renderer's
 * `desktop:renderer-ready` IPC or an explicit user/activate show. On a boot where
 * the renderer never signals and nobody opens the window, nothing arms it, so
 * all four lanes ticked every 5s against a null source for the life of the
 * process. The cloud socket, gated the same way, never started.
 *
 * `main/sync/AGENTS.md` invariant 9 is the rule, read at full width: not gated on
 * renderer or UI state covers EVERY step delivery depends on, not only `start()`.
 *
 * WHAT THIS PINS. `whenInitiallyShown()` is still called — the reveal is a
 * legitimate fast path, and background work should still yield to first paint
 * when there is a paint. What it may no longer be is the only way through. So
 * every one of its call sites in `app.ts` must be wrapped by
 * `whenBootAdmissionAllowed`, whose deadline the main process arms itself
 * (`lifecycle/boot-admission-deadline.ts`, behavior covered by
 * `boot-admission-deadline.test.ts`).
 *
 * WHY AST: `app.ts` statically imports `electron` and cannot be loaded from a
 * node test. See `support/app-module-ast.ts`.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CallExpression, Node, SourceFile } from "typescript6";
import { forEachChild, isCallExpression } from "typescript6";

import type { RendererReadinessGates } from "../src/main/lifecycle/renderer-readiness-gates.js";
import type { BoundedSlot } from "./support/app-module-ast.js";
import {
  calleeName,
  callPathFrom,
  callSitesOf,
  isInBoundedSlot,
  parseAppModule,
} from "./support/app-module-ast.js";

/** The raw window-reveal promise. Bounded by nothing the main process controls. */
const WINDOW_REVEAL_WAIT = "whenInitiallyShown";
/**
 * The owners allowed to receive the raw reveal promise, and the EXACT slot each
 * one bounds. Each is covered by a runnable headless test that drives the real
 * production entry point with a reveal that never settles:
 * `scheduleAfterBootAdmission` in `boot-admission-deadline.test.ts`,
 * `startAfterInitialUi` in `cloud-socket-startup.test.ts`.
 *
 * Slots, not bare names, because `scheduleAfterBootAdmission(reveal, bootWork)`
 * bounds only its FIRST argument — `bootWork` runs after admission with no bound.
 * Exempting the whole argument list would bless a raw wait smuggled into an
 * inlined `bootWork` callback, re-admitting the very defect this guards.
 */
const BOUNDED_SLOTS: readonly BoundedSlot[] = [
  { wrapper: "scheduleAfterBootAdmission", argumentIndex: 0 },
  {
    wrapper: "startAfterInitialUi",
    argumentIndex: 0,
    property: "waitForWindowReveal",
  },
];

/** The wrapper names, for the "still wired at all" assertions. */
const BOUNDED_OWNERS = BOUNDED_SLOTS.map((slot) => slot.wrapper);
/** Composes the agent-dashboard runtime — the thing that makes the source non-null. */
const RUNTIME_COMPOSITION_CALL = "ensureAgentDashboardDesignSystemRuntime";
/** Schedules the cloud socket start. */
const CLOUD_SOCKET_SCHEDULER = "scheduleCloudSocketStartAfterInitialUi";
/** The boot entry point every admission path must terminate at. */
const BOOT_METHOD = "boot";

/**
 * The waits an admission path may NOT sit behind.
 *
 * Every name here is a RAW resolver-set promise in
 * `lifecycle/renderer-readiness-gates.ts` with no timer of its own, settled only
 * by a renderer IPC the main process cannot produce for itself. What is
 * deliberately ABSENT is their bounded twins —
 * `waitForInitialDashboardDataServedOrTimeout`,
 * `waitForInitialRendererLiveDbIdleOrTimeout`,
 * `waitForDashboardReadinessBeforeCloudSocket` — which race a main-process
 * fail-open timer and so degrade a slow boot rather than stranding a headless
 * one. Those are what an admission path must call; the bare promises are not.
 *
 * `whenInitialRendererMounted` is the one that reads safest and is not. Its only
 * bounded use is the `Promise.race` INSIDE `waitForInitialWindowRevealReadiness`,
 * armed solely by `requestReveal()` — the same unarmed bound as
 * `whenInitiallyShown` itself. Awaited directly on an admission path it strands a
 * headless boot byte-for-byte as ISS-5990 did, and the sibling ISS-4717 guard
 * cannot catch it: that walk watches these same names but only along the
 * `startAgentSessionSync` path, which does not run through `startAgentCapture()`.
 * The earlier one-name set called all three "bounded AND armed at the moment they
 * are awaited"; that was false, and the mutation it let through was executed
 * against the real `app.ts` and stayed green (ISS-5990 review).
 *
 * Typed against `RendererReadinessGates` rather than written as bare strings.
 * These three are that class's public methods, so it owns the names; as string
 * literals a rename at the class and its call sites left `tsc` green while this
 * guard went on watching a name that no longer existed, matched nothing, and
 * passed. The same guard-cannot-fail defect, reached by rename instead of by a
 * blind spot in the walk. `whenInitiallyShown` stays a plain literal
 * deliberately — it belongs to `desktopWindow`, a different owner.
 */
const UNARMED_RENDERER_GATE_WAITS: readonly (keyof RendererReadinessGates)[] = [
  "whenInitialRendererMounted",
  "whenInitialDashboardDataServed",
  "whenInitialRendererLiveDbIdle",
];

const UNARMED_WINDOW_WAITS = new Set<string>([
  WINDOW_REVEAL_WAIT,
  ...UNARMED_RENDERER_GATE_WAITS,
]);

/** Every `whenInitiallyShown()` call site in `app.ts`. */
function windowRevealCallSites(sourceFile: SourceFile): CallExpression[] {
  return callSitesOf(WINDOW_REVEAL_WAIT, sourceFile);
}

/** A bounded slot, named the way the failure message needs to name it. */
function describeSlot(slot: BoundedSlot): string {
  const argument = `argument ${slot.argumentIndex}`;
  return slot.property === undefined
    ? `${slot.wrapper}() ${argument}`
    : `${slot.wrapper}() ${argument}.${slot.property}`;
}

/** Every named call appearing anywhere in `app.ts`. */
function allCalleeNames(sourceFile: SourceFile): string[] {
  const names: string[] = [];
  const visit = (node: Node): void => {
    if (isCallExpression(node)) {
      names.push(calleeName(node, sourceFile));
    }
    forEachChild(node, visit);
  };
  forEachChild(sourceFile, visit);
  return names;
}

describe("ISS-5990 boot admission is bounded by the main process, not the renderer", () => {
  test("EVERY window-reveal wait in app.ts is wrapped by the bounded admission helper", () => {
    // The teeth. A new admission site that awaits `whenInitiallyShown()`
    // directly — or a revert of either wrapped site — fails here rather than in
    // the field,
    // where the symptom is a silent process that captures and never delivers.
    const sourceFile = parseAppModule();
    const sites = windowRevealCallSites(sourceFile);

    assert.ok(
      sites.length > 0,
      `${WINDOW_REVEAL_WAIT} disappeared from app.ts; the reveal fast path is meant to be KEPT, only bounded`
    );
    const unwrapped = sites.filter(
      (site) => !isInBoundedSlot(site, BOUNDED_SLOTS, sourceFile)
    );
    assert.equal(
      unwrapped.length,
      0,
      `${unwrapped.length} call(s) to ${WINDOW_REVEAL_WAIT}() are handed to no bounding owner (${BOUNDED_OWNERS.join(", ")}); that promise is armed only by the renderer-ready IPC or an explicit show, so a headless boot never passes it`
    );
  });

  test("both admission sites are still wired, not just one", () => {
    // Runtime composition and the cloud socket were gated independently, and
    // fixing one while leaving the other still strands half the boot.
    const called = allCalleeNames(parseAppModule());
    for (const owner of BOUNDED_OWNERS) {
      assert.ok(
        called.includes(owner),
        `${owner} must still be wired from app.ts; dropping it re-strands one half of a headless boot`
      );
    }
  });

  test("runtime composition is reachable from boot() with no raw window wait on the path", () => {
    // The stranded-data path, walked end to end: boot() → …  →
    // ensureAgentDashboardDesignSystemRuntime(). A raw window wait anywhere on
    // it is what made `getSyncSource()` return null forever.
    const { waits, roots } = callPathFrom(
      RUNTIME_COMPOSITION_CALL,
      UNARMED_WINDOW_WAITS,
      BOUNDED_SLOTS
    );

    assert.deepEqual(
      waits,
      [],
      "the agent-dashboard runtime must not be composed behind an unarmed window promise; a null sync source is indistinguishable from having nothing to send"
    );
    // Exact, not `includes`: with the walk now receiver- and reference-aware,
    // `boot` is the ONLY root. The earlier `includes` was tolerating the extra
    // roots that unrelated `.start()` name collisions dragged in — which is what
    // made this assertion pass while the real wiring was severed (ISS-5990 review).
    assert.deepEqual(
      roots,
      [BOOT_METHOD],
      `runtime composition must stay reachable from ${BOOT_METHOD}(); found roots: ${roots.join(", ")}`
    );
  });

  test("the cloud-socket start has no raw window wait on its path from boot()", () => {
    const { waits, roots } = callPathFrom(
      CLOUD_SOCKET_SCHEDULER,
      UNARMED_WINDOW_WAITS,
      BOUNDED_SLOTS
    );

    assert.deepEqual(waits, []);
    assert.deepEqual(roots, [BOOT_METHOD]);
  });

  test("the reveal is still consulted at EACH bounded site, not dropped", () => {
    // Criterion 3 read the other way: the fix must not become "admit everything
    // immediately". The reveal stays the fast path, so heavy boot work still
    // keeps off the loop during first paint on a healthy launch — it is only no
    // longer the sole way through. Deleting the reveal hop would pass every
    // other test in this file.
    //
    // Attributed PER SLOT, not counted globally. A total compares a number
    // against a number and cannot see WHICH owner produced it: two reveal calls
    // under one bounded owner satisfied `>= BOUNDED_SLOTS.length` while the
    // other owner had stopped consulting the reveal altogether, and the whole
    // file stayed green on exactly that mutation (ISS-5990 review).
    const sourceFile = parseAppModule();
    for (const slot of BOUNDED_SLOTS) {
      const consulted = windowRevealCallSites(sourceFile).filter((site) =>
        isInBoundedSlot(site, [slot], sourceFile)
      );
      // `>=`, not `===`: dropping this owner's reveal hop must fail, but an
      // owner that legitimately consults it more than once must not.
      assert.ok(
        consulted.length >= 1,
        `${describeSlot(slot)} no longer receives ${WINDOW_REVEAL_WAIT}(); that owner has stopped yielding to first paint, and a reveal call under a DIFFERENT owner does not cover it`
      );
    }
  });
});
