/**
 * ISS-5990: boot admission must not hinge on a renderer readiness signal.
 *
 * The decisive case is a boot where `desktop:renderer-ready` NEVER arrives and
 * nobody opens the window. `DesktopWindow.whenInitiallyShown()` then stays
 * pending for the life of the process — the reveal gate's 2s fail-open is only
 * ARMED by `requestReveal()`, which that IPC (or an explicit show) is the only
 * thing that reaches — so everything behind it was admitted never. That included
 * the ONLY boot path to `startAgentCapture()`, hence to the agent-dashboard
 * runtime, hence to a non-null `getSyncSource()`: all four upload lanes ticked
 * against null forever and the local corpus was stranded
 * (`main/sync/AGENTS.md` invariant 9).
 *
 * So the tests that matter here drive the never-resolving reveal, not the happy
 * one — a suite that only fires the reveal passes against the pre-fix code and
 * proves nothing. `whenBootAdmissionAllowed` imports no `electron`, so this is
 * the real production decision under test rather than an AST inspection of it;
 * `boot-admission-not-window-gated.test.ts` covers the `app.ts` wiring that the
 * decision is reached through.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BOOT_ADMISSION_DEADLINE_MS,
  scheduleAfterBootAdmission,
  whenBootAdmissionAllowed,
} from "../src/main/lifecycle/boot-admission-deadline.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

/** The failure a caller-supplied `onDeadline` is driven with. */
const ONDEADLINE_THROW = /gateway log sink unavailable/;

/** The reveal a headless boot gets: one that is never going to settle. */
function neverRevealed(): Promise<void> {
  return new Promise<void>(() => undefined);
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("ISS-5990 whenBootAdmissionAllowed", () => {
  test("HEADLESS BOOT: admits at the deadline when the reveal never comes", async () => {
    // The whole ticket in one test. Pre-fix, `app.ts` awaited
    // `whenInitiallyShown()` directly and this promise never settled.
    nodeTestTimers.enable(["setTimeout"]);
    try {
      const deadlines: number[] = [];
      let admitted = false;
      const pending = whenBootAdmissionAllowed({
        whenWindowRevealed: neverRevealed,
        onDeadline: () => deadlines.push(1),
      }).then(() => {
        admitted = true;
      });

      nodeTestTimers.tick(BOOT_ADMISSION_DEADLINE_MS - 1);
      await flushMicrotasks();
      // One tick short: the deadline is a real bound, not an immediate resolve
      // that only looks like one. The reveal fast path still gets its window.
      assert.equal(admitted, false);

      nodeTestTimers.tick(1);
      await pending;

      assert.equal(admitted, true);
      // Reported, so a headless boot is diagnosable from the gateway log rather
      // than inferred from the absence of anything.
      assert.deepEqual(deadlines, [1]);
    } finally {
      nodeTestTimers.reset();
    }
  });

  test("HEALTHY BOOT: the reveal admits immediately, with no deadline report", async () => {
    nodeTestTimers.enable(["setTimeout"]);
    try {
      const deadlines: number[] = [];
      let settleReveal: () => void = () => undefined;
      const pending = whenBootAdmissionAllowed({
        whenWindowRevealed: () =>
          new Promise<void>((resolve) => {
            settleReveal = resolve;
          }),
        onDeadline: () => deadlines.push(1),
      });

      settleReveal();
      await pending;

      assert.deepEqual(deadlines, []);
    } finally {
      nodeTestTimers.reset();
    }
  });

  test("a reveal that already landed does not leave a timer to fire later", async () => {
    // The Runtime Cleanup rule, and the reason `onDeadline` can be trusted as a
    // signal: an uncleared timer would report a healthy boot as a headless one
    // ten seconds after the window was already on screen.
    nodeTestTimers.enable(["setTimeout"]);
    try {
      const deadlines: number[] = [];
      await whenBootAdmissionAllowed({
        whenWindowRevealed: () => Promise.resolve(),
        onDeadline: () => deadlines.push(1),
      });

      nodeTestTimers.tick(BOOT_ADMISSION_DEADLINE_MS * 2);
      await flushMicrotasks();

      assert.deepEqual(deadlines, []);
    } finally {
      nodeTestTimers.reset();
    }
  });

  test("a reveal landing on the same turn as the deadline is reported once", async () => {
    // Both arms can settle in the same turn. Whichever wins, admission happens
    // exactly once and the deadline is reported at most once — the pattern
    // `RendererReadinessGates.raceWithFailOpen` holds for its own siblings.
    nodeTestTimers.enable(["setTimeout"]);
    try {
      const deadlines: number[] = [];
      let admissions = 0;
      let settleReveal: () => void = () => undefined;
      const pending = whenBootAdmissionAllowed({
        whenWindowRevealed: () =>
          new Promise<void>((resolve) => {
            settleReveal = resolve;
          }),
        onDeadline: () => deadlines.push(1),
      }).then(() => {
        admissions += 1;
      });

      nodeTestTimers.tick(BOOT_ADMISSION_DEADLINE_MS);
      settleReveal();
      await pending;
      await flushMicrotasks();

      // Exact, not `<= 1`: the deadline was ticked FIRST, so it won the race and
      // must be the reported cause. `<= 1` was satisfied by Promise semantics
      // alone and could not fail (ISS-5990 review).
      assert.equal(admissions, 1);
      assert.deepEqual(deadlines, [1]);
    } finally {
      nodeTestTimers.reset();
    }
  });

  test("a reveal wait that REJECTS still admits", async () => {
    // A thrown reveal wait means "no reveal is coming", which is the case this
    // helper exists to admit — never a reason to strand the caller. Admission
    // is immediate rather than at the deadline: the answer is already known.
    nodeTestTimers.enable(["setTimeout"]);
    try {
      const deadlines: number[] = [];
      await whenBootAdmissionAllowed({
        whenWindowRevealed: () => Promise.reject(new Error("window torn down")),
        onDeadline: () => deadlines.push(1),
      });

      assert.deepEqual(deadlines, []);
    } finally {
      nodeTestTimers.reset();
    }
  });

  test("a reveal getter that throws SYNCHRONOUSLY still admits", async () => {
    // The contract is "never rejects", and a sync throw inside the executor
    // would reject the promise instead of admitting — stranding the caller in
    // the one case this helper exists to rescue.
    nodeTestTimers.enable(["setTimeout"]);
    try {
      const deadlines: number[] = [];
      await whenBootAdmissionAllowed({
        whenWindowRevealed: () => {
          throw new Error("window already disposed");
        },
        onDeadline: () => deadlines.push(1),
      });

      assert.deepEqual(deadlines, []);
    } finally {
      nodeTestTimers.reset();
    }
  });

  test("an onDeadline that THROWS still admits", async () => {
    // The contract is "never rejects", and `onDeadline` is caller-supplied with
    // a type that accepts any callback. Reporting before resolving made a throw
    // there permanent: `settled` is already true and the timer already cleared,
    // so the reveal arm bails on the settled guard and NOTHING ever resolves the
    // promise — the same strand the module exists to prevent (ISS-5990 review).
    // The throw still escapes the timer callback, which this ordering does not
    // change; what it must not take with it is the admission.
    nodeTestTimers.enable(["setTimeout"]);
    try {
      let admitted = false;
      // Asserted through `admitted` before it is awaited: under the defect this
      // pins the promise never settles at all, and awaiting it first would
      // report that as a suite timeout instead of the assertion below.
      const pending = whenBootAdmissionAllowed({
        whenWindowRevealed: neverRevealed,
        onDeadline: () => {
          throw new Error("gateway log sink unavailable");
        },
      }).then(() => {
        admitted = true;
      });

      assert.throws(
        () => nodeTestTimers.tick(BOOT_ADMISSION_DEADLINE_MS),
        ONDEADLINE_THROW
      );
      await flushMicrotasks();

      assert.equal(
        admitted,
        true,
        "a throwing onDeadline must not strand boot admission; the promise never settles and every caller behind it never runs"
      );
      await pending;
    } finally {
      nodeTestTimers.reset();
    }
  });

  test("the deadline is armed at the call, not by the reveal being requested", async () => {
    // Criterion 4. The bug was not an absent bound, it was a bound nothing
    // armed: `InitialWindowRevealGate`'s 2s fail-open is started by
    // `requestReveal()`, so a renderer that never signals arms nothing. Nothing
    // is called on the reveal side here at all, and admission still lands.
    nodeTestTimers.enable(["setTimeout"]);
    try {
      let revealWaitCalls = 0;
      let admitted = false;
      const pending = whenBootAdmissionAllowed({
        whenWindowRevealed: () => {
          revealWaitCalls += 1;
          return neverRevealed();
        },
        deadlineMs: 250,
      }).then(() => {
        admitted = true;
      });

      nodeTestTimers.tick(250);
      await pending;

      assert.equal(admitted, true);
      assert.equal(revealWaitCalls, 1);
    } finally {
      nodeTestTimers.reset();
    }
  });
});

describe("ISS-5990 scheduleAfterBootAdmission", () => {
  test("HEADLESS BOOT: runs the boot work even though the window never reveals", async () => {
    // The production entry point `app.ts` calls, on the no-ready path. Pre-fix
    // this was `whenInitiallyShown().then(...)` and `bootWork` — the only boot
    // route to `startAgentCapture()`, and so to a non-null `getSyncSource()` —
    // simply never ran.
    nodeTestTimers.enable(["setTimeout"]);
    try {
      let ran = false;
      let resolveRan: () => void = () => undefined;
      const didRun = new Promise<void>((resolve) => {
        resolveRan = resolve;
      });

      scheduleAfterBootAdmission(neverRevealed, () => {
        ran = true;
        resolveRan();
        return Promise.resolve();
      });

      nodeTestTimers.tick(BOOT_ADMISSION_DEADLINE_MS - 1);
      await flushMicrotasks();
      assert.equal(ran, false);

      nodeTestTimers.tick(1);
      // Awaited on a signal the boot work itself produces, not on a fixed number
      // of event-loop turns: the settle path is several microtasks deep and a
      // turn count would be a guess that goes red under load.
      await didRun;

      assert.equal(ran, true);
    } finally {
      nodeTestTimers.reset();
    }
  });

  test("boot work that REJECTS is reported, not thrown into boot", async () => {
    // Fire-and-forget by contract: an unhandled rejection here would surface as
    // a main-process crash on a path nothing awaits.
    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });

    scheduleAfterBootAdmission(
      () => Promise.resolve(),
      () => {
        resolveSettled();
        return Promise.reject(new Error("capture blew up"));
      }
    );

    await settled;
    await flushMicrotasks();
  });
});
