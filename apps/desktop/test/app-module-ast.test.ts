/**
 * @file app-module-ast.test.ts
 * @description The ISS-4717/ISS-5990 boot-wiring guards, driven against
 * FIXTURES instead of only against `app.ts`.
 *
 * Both guards are AST walks over one real file, so their own suites can only
 * ever show that the file passes today. They cannot show that the walk WOULD
 * catch a re-gating — and one of them did not: `waitsAround` inspected only the
 * ancestor chain of the call site, so it saw `whenInitiallyShown().then(() =>
 * start())` (the wait is an ancestor) and missed the ordinary sequential shape
 *
 *     await this.rendererGates.whenInitialRendererMounted();
 *     this.startSyncLanesAtBoot();
 *
 * where the wait is a preceding SIBLING and defers everything after it in the
 * block just as completely. The guard stayed green while `main/sync/AGENTS.md`
 * invariant 9 was broken (ISS-5990 review).
 *
 * So the fixtures below are the counterfactual the guard suites structurally
 * cannot run: each one is a shape the walk must catch, or must NOT catch, fed in
 * as source text.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { BoundedSlot } from "./support/app-module-ast.js";
import { callPathFrom, parseModuleSource } from "./support/app-module-ast.js";

/** The lane start every fixture below routes to, as in the real `app.ts`. */
const LANE_START_CALL = "startAgentSessionSync";
/** The boot entry point every fixture's walk must terminate at. */
const BOOT_METHOD = "boot";

/** A representative sample of the waits the two guards watch. */
const WATCHED_WAITS = new Set([
  "whenInitiallyShown",
  "whenInitialRendererMounted",
]);

/** The ISS-5990 admission wrapper, whose FIRST argument is the bounded slot. */
const BOUNDED_SLOTS: readonly BoundedSlot[] = [
  { wrapper: "scheduleAfterBootAdmission", argumentIndex: 0 },
];

/** The lane-start owner every fixture shares, verbatim across shapes. */
const LANE_OWNER = `
  private startSyncLanesAtBoot(): void {
    this.startAgentSessionSync({});
  }
`;

/** A fixture module in the shape of `app.ts`: a class with a `boot()` method. */
function appModuleFixture(bootBody: string): string {
  return `
class DesktopApplication {
  async boot(): Promise<void> {
${bootBody}
  }
${LANE_OWNER}
}
`;
}

/** The waits the guard walk finds between `boot()` and the lane start. */
function laneStartWaits(
  bootBody: string,
  slots: readonly BoundedSlot[] = []
): string[] {
  return callPathFrom(
    LANE_START_CALL,
    WATCHED_WAITS,
    slots,
    parseModuleSource(appModuleFixture(bootBody))
  ).waits;
}

describe("app-module-ast: waits the boot-wiring walk must CATCH", () => {
  test("a preceding sibling await in the same block", () => {
    // The shape the walk was blind to. Nothing here is an ancestor of the lane
    // start — the await is the statement BEFORE the call — and yet a renderer
    // that never mounts strands the lanes exactly as completely as the callback
    // shape does.
    assert.deepEqual(
      laneStartWaits(
        `    await this.rendererGates.whenInitialRendererMounted();
    this.startSyncLanesAtBoot();`
      ),
      ["whenInitialRendererMounted"],
      "an await of a watched wait in a statement BEFORE the call defers that call; a walk that only inspects ancestors reports nothing and the guard passes while invariant 9 is broken"
    );
  });

  test("a preceding sibling await, several statements back", () => {
    // Adjacency is not the property that matters — order is. Unrelated work
    // between the await and the call changes nothing about the deferral.
    assert.deepEqual(
      laneStartWaits(
        `    await this.rendererGates.whenInitiallyShown();
    this.tray.init();
    this.registerHandlers();
    this.startSyncLanesAtBoot();`
      ),
      ["whenInitiallyShown"]
    );
  });

  test("the ancestor callback shape the walk already caught", () => {
    // The ISS-4717 regression case, kept runnable so the statement-order work
    // cannot quietly cost the coverage it was added alongside.
    assert.deepEqual(
      laneStartWaits(
        `    this.desktopWindow.whenInitiallyShown().then(() => {
      this.startSyncLanesAtBoot();
    });`
      ),
      ["whenInitiallyShown"]
    );
  });

  test("a preceding await in the caller's caller, one hop out", () => {
    // The walk crosses frames, and statement order has to travel with it: the
    // deferring await sits in `boot()` while the lane start is two calls down.
    const source = `
class DesktopApplication {
  async boot(): Promise<void> {
    await this.rendererGates.whenInitialRendererMounted();
    this.startCaptureStack();
  }

  private startCaptureStack(): void {
    this.startSyncLanesAtBoot();
  }
${LANE_OWNER}
}
`;
    const { waits, roots } = callPathFrom(
      LANE_START_CALL,
      WATCHED_WAITS,
      [],
      parseModuleSource(source)
    );

    assert.deepEqual(waits, ["whenInitialRendererMounted"]);
    assert.deepEqual(roots, [BOOT_METHOD]);
  });

  test("a preceding await reached through one variable of indirection", () => {
    // The walk matches on the awaited EXPRESSION's text, so binding the call to
    // a local and awaiting the local evaded it entirely — same deferral, no
    // report (ISS-5990 review). Only the RENDERER-gate names make this load
    // bearing: for `whenInitiallyShown` the "EVERY window-reveal wait is
    // wrapped" test still fails on the unwrapped call site, but no such
    // per-call-site backstop exists for the gates.
    assert.deepEqual(
      laneStartWaits(
        `    const mounted = this.rendererGates.whenInitialRendererMounted();
    await mounted;
    this.startSyncLanesAtBoot();`
      ),
      ["whenInitialRendererMounted"]
    );
  });

  test("a CALLBACK-position wait reached through one variable of indirection", () => {
    // The shape that matters, and the one the first pass at alias resolution
    // missed: it threaded the alias map through the preceding-sibling branch
    // only, so it caught the hypothetical `await mounted;` re-gating and missed
    // the HISTORICAL one. `app.ts` has always deferred boot in callback
    // position — `whenInitiallyShown().then(() => …)` — so binding that call to
    // a local is one keystroke from the shape that actually shipped, and the
    // walk reported nothing (ISS-5990 review, round 2).
    assert.deepEqual(
      laneStartWaits(
        `    const mounted = this.rendererGates.whenInitialRendererMounted();
    void mounted.then(() => {
      this.startSyncLanesAtBoot();
    });`
      ),
      ["whenInitialRendererMounted"],
      "a callback handed to an aliased wait is deferred exactly as one handed to the wait's own call; only the sibling-await branch resolving aliases catches the first and not this"
    );
  });

  test("a preceding await reached through a CHAIN of local bindings", () => {
    // One hop was an arbitrary stopping point: `const b = a` costs the author
    // nothing and cost the guard everything.
    assert.deepEqual(
      laneStartWaits(
        `    const gate = this.rendererGates.whenInitialRendererMounted();
    const mounted = gate;
    await mounted;
    this.startSyncLanesAtBoot();`
      ),
      ["whenInitialRendererMounted"]
    );
  });

  test("a preceding await whose binding is declared in a NESTED block", () => {
    // `await` inside an `if` suspends the whole method, so everything after the
    // block is deferred — but the declaration is not a statement of the block
    // being walked, so a flat scan of one statement list resolved nothing.
    assert.deepEqual(
      laneStartWaits(
        `    if (this.headless) {
      const mounted = this.rendererGates.whenInitialRendererMounted();
      await mounted;
    }
    this.startSyncLanesAtBoot();`
      ),
      ["whenInitialRendererMounted"]
    );
  });

  test("an unbounded wait smuggled into the wrapper's UNBOUNDED argument slot", () => {
    // Slot precision has to survive the sibling path too:
    // `scheduleAfterBootAdmission` bounds only argument 0, so a raw wait in the
    // `bootWork` argument is not exempt and must still be reported.
    assert.deepEqual(
      laneStartWaits(
        `    await scheduleAfterBootAdmission(
      () => this.other.tick(),
      () => this.desktopWindow.whenInitiallyShown()
    );
    this.startSyncLanesAtBoot();`,
        BOUNDED_SLOTS
      ),
      ["whenInitiallyShown"]
    );
  });

  test("a wait in a SIBLING argument of the awaited call", () => {
    // The one shape only the `await` arm of `deferringAncestorExpression` sees.
    // The call arm scans `parent.expression` — the callee — so a watched wait
    // sitting in a sibling ARGUMENT of the same call is invisible to it; the
    // `await` arm scans the whole awaited expression, which is where that
    // sibling lives. Deleting the arm leaves every other fixture green, and the
    // three renderer-gate names have no per-call-site backstop to catch it
    // (ISS-5990 review, round 3).
    assert.deepEqual(
      laneStartWaits(
        `    await gateOn(
      this.rendererGates.whenInitialRendererMounted(),
      () => this.startSyncLanesAtBoot()
    );`
      ),
      ["whenInitialRendererMounted"]
    );
  });
});

describe("app-module-ast: shapes the walk must NOT report", () => {
  test("an await that comes AFTER the call defers nothing", () => {
    // The counterpart that keeps the rule about ORDER rather than mere
    // co-location: a walk that scanned the whole enclosing block would fail
    // here, and would have condemned the real `boot()`.
    assert.deepEqual(
      laneStartWaits(
        `    this.startSyncLanesAtBoot();
    await this.rendererGates.whenInitialRendererMounted();`
      ),
      []
    );
  });

  test("an await inside a callback a preceding statement merely DEFINES", () => {
    // Registering a handler that will await later does not suspend `boot()`.
    // Counting it would make the guard fire on wiring that is already correct.
    assert.deepEqual(
      laneStartWaits(
        `    this.registerHandler(async () => {
      await this.rendererGates.whenInitialRendererMounted();
    });
    this.startSyncLanesAtBoot();`
      ),
      []
    );
  });

  test("a preceding wait that is NOT awaited defers nothing", () => {
    // Fire-and-forget: the statement returns immediately, so the lane start is
    // not behind it. Only the `await` makes the order load-bearing.
    assert.deepEqual(
      laneStartWaits(
        `    this.desktopWindow.whenInitiallyShown();
    this.startSyncLanesAtBoot();`
      ),
      []
    );
  });

  test("a local binding that is declared but never awaited defers nothing", () => {
    // The counterpart to the indirection case: alias resolution must key off the
    // `await`, not the declaration, or holding a promise in a variable to pass
    // along later would read as a gate.
    assert.deepEqual(
      laneStartWaits(
        `    const mounted = this.rendererGates.whenInitialRendererMounted();
    this.register(mounted);
    this.startSyncLanesAtBoot();`
      ),
      []
    );
  });

  test("a same-named local in an UNRELATED block does not resolve", () => {
    // Alias resolution is scoped to the one statement list being walked. A
    // file-wide name lookup would let an unrelated method's local condemn
    // correct wiring here.
    const source = `
class DesktopApplication {
  async boot(): Promise<void> {
    const mounted = this.readyFlag;
    await mounted;
    this.startSyncLanesAtBoot();
  }

  private async other(): Promise<void> {
    const mounted = this.rendererGates.whenInitialRendererMounted();
    await mounted;
  }
${LANE_OWNER}
}
`;
    assert.deepEqual(
      callPathFrom(
        LANE_START_CALL,
        WATCHED_WAITS,
        [],
        parseModuleSource(source)
      ).waits,
      []
    );
  });

  test("a binding from a SIBLING block is not in scope and does not resolve", () => {
    // The bound on walking outward for aliases. Reaching a nested declaration
    // must mean "enclosing statement lists, innermost first" — not "every
    // declaration anywhere under a preceding statement", which would let a
    // binding that is not in scope at the await condemn correct wiring.
    assert.deepEqual(
      laneStartWaits(
        `    if (this.headless) {
      const mounted = this.rendererGates.whenInitialRendererMounted();
      this.register(mounted);
    }
    if (this.ready) {
      await mounted;
    }
    this.startSyncLanesAtBoot();`
      ),
      []
    );
  });

  test("a preceding await handed to the wrapper's BOUNDED slot is exempt", () => {
    // The ISS-5990 fix itself. Without this exemption the guard would forbid
    // the very wrapper that closes the defect it guards.
    assert.deepEqual(
      laneStartWaits(
        `    await scheduleAfterBootAdmission(
      () => this.desktopWindow.whenInitiallyShown(),
      () => this.warmCaches()
    );
    this.startSyncLanesAtBoot();`,
        BOUNDED_SLOTS
      ),
      []
    );
  });
});
