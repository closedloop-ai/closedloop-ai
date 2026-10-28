/**
 * ISS-6875 — the desktop-e2e launch harness, not any spec that runs on it.
 *
 * Why the module does only this, and why the marker must not name a cause,
 * are argued once in `e2e/helpers/electron-launch-attribution.ts`. What is
 * asserted here is that the failure is ATTRIBUTED to the harness, that the
 * message stays groupable, and that no launcher escapes the wrapper.
 *
 * The stub rejects with Playwright's verbatim message, so no case can pass on a
 * failure shape the real launcher cannot produce.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript6";
import { afterAll, describe, test } from "vitest";
import {
  type ExitObservableChild,
  firstWindowOrExplainExit,
  HARNESS_LAUNCH_FAILURE_HEADLINE,
  HARNESS_LAUNCH_FAILURE_MARKER,
  launchElectronOrExplain,
  WINDOWLESS_EXIT_HEADLINE,
} from "./e2e/helpers/electron-launch-attribution.js";
import {
  countElectronLaunchCalls,
  countWrappedElectronLaunchCalls,
  electronBindings,
  electronLaunchers,
  harnessSourceFiles,
  PLAYWRIGHT_MODULE,
  RUNNER_SOURCE_EXTENSIONS,
  ELECTRON_LAUNCH_WRAPPER as WRAPPER,
} from "./helpers/electron-launch-call-scan.js";
import { forEachNode, parseTypeScriptFile } from "./helpers/ts-ast.js";

/** Playwright's verbatim rejection — `playwright-core`'s `waitForLine`. */
const PLAYWRIGHT_LAUNCH_FAILURE = "Process failed to launch!";
const LAUNCHED_SENTINEL = "launched-app-handle";
/**
 * An entry that exists and is not the Desktop bundle, so the launch preflight
 * passes without a build and these cases exercise the marker alone.
 */
const STUB_LAUNCH_OPTIONS = { args: [fileURLToPath(import.meta.url)] };

const DESKTOP_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
/**
 * Where the wrapper guard looks, with {@link SOAK_DIR}. The marker alone gave
 * `test/soak` no reason to route through {@link launchElectronOrExplain}: its
 * failures never reach the flake-quarantine intake. ISS-12135 put the launch
 * preflight in the same wrapper, and a soak launch on a broken build raises the
 * same native modal an e2e one does, so soak is guarded too.
 */
const E2E_DIR = path.join(DESKTOP_ROOT, "test/e2e");
/**
 * Where the EXIT-RACE guard also looks, and the reason the two scopes differ.
 *
 * The windowless-exit race is not about intake at all: it converts a window wait
 * that expires into an exit code, which is worth MORE here than in e2e, not
 * less — soak waits 180s per launch against e2e's 30s, and a soak cycle lost to
 * an empty timeout is a whole cycle. Leaving this half scoped to `test/e2e`
 * would have let the soak launcher drift unguarded with nothing to say so.
 */
const SOAK_DIR = path.join(DESKTOP_ROOT, "test/soak");
const EXIT_RACE_WRAPPER = "firstWindowOrExplainExit";
const FIRST_WINDOW = "firstWindow";
/**
 * Bound for the cases whose window promise never settles. Without it, an exit
 * race that stopped working would WEDGE the node lane instead of reddening it —
 * the failure mode this whole module exists to stop, reproduced in its own test.
 */
const WINDOWLESS_CASE_TIMEOUT_MS = 10_000;
/** Splits a regex literal's own source text into pattern and flags. */
const REGEX_LITERAL = /^\/(.*)\/([a-z]*)$/;

describe("harness launch attribution (ISS-6875)", () => {
  // Pinned as a LITERAL, unlike every other contract value in this suite —
  // because the token is what a human greps a run log for, and a rename would
  // otherwise be invisible here. It is NOT pinned because something consumes
  // it: nothing does yet (ISS-6931, and the marker's own docstring). Every
  // other assertion reads the token through the import, where an empty string
  // would satisfy `includes` unconditionally and take the whole suite green.
  test("the marker is a stable non-empty token", () => {
    assert.equal(HARNESS_LAUNCH_FAILURE_MARKER, "harness_launch_failure");
  });

  test("a failed launch is re-thrown as an attributable harness failure", async () => {
    let attempts = 0;
    const failure = await launchElectronOrExplain(STUB_LAUNCH_OPTIONS, () => {
      attempts += 1;
      return Promise.reject(new Error(PLAYWRIGHT_LAUNCH_FAILURE));
    }).then(
      () => null,
      (error: unknown) => error
    );

    assert.ok(failure instanceof Error);
    // Positive control: the launch was genuinely called and genuinely rejected.
    assert.equal(attempts, 1);
    // The deliverable — Playwright's string attributes nothing; this one names
    // the harness while still carrying what Playwright said.
    assert.notEqual(failure.message, PLAYWRIGHT_LAUNCH_FAILURE);
    assert.ok(failure.message.includes(HARNESS_LAUNCH_FAILURE_MARKER));
    assert.ok(failure.message.includes(PLAYWRIGHT_LAUNCH_FAILURE));
  });

  test("the message is exactly the headline plus Playwright's own text", async () => {
    // The 17 quarantine entries collapsed onto ONE string. Interpolating
    // anything per-run — the `mkdtemp` user-data dir is the tempting one, a
    // clock read the sneaky one — splits that family into N one-offs for any
    // consumer that fingerprints the message.
    //
    // Asserted as EQUALITY against a value composed from the module's own
    // exports, not as "two rejections match": two rejections raised in the same
    // millisecond match under a `Date.now()` interpolation too, which is a green
    // this test caught itself producing.
    const failure = await launchElectronOrExplain(STUB_LAUNCH_OPTIONS, () =>
      Promise.reject(new Error(PLAYWRIGHT_LAUNCH_FAILURE))
    ).then(
      () => null,
      (error: unknown) => error
    );

    assert.ok(failure instanceof Error);
    assert.equal(
      failure.message,
      `${HARNESS_LAUNCH_FAILURE_HEADLINE}\n  playwright: ${PLAYWRIGHT_LAUNCH_FAILURE}`
    );
    // The headline is what carries the marker; neither may drift out of it.
    assert.ok(
      HARNESS_LAUNCH_FAILURE_HEADLINE.startsWith(HARNESS_LAUNCH_FAILURE_MARKER)
    );
  });

  test("the original rejection survives as `cause`", async () => {
    // Playwright hangs a stack, and on some paths its own log transcript, off
    // the error it throws. Flattening it to a string would discard exactly the
    // context this ticket exists to preserve.
    const original = new Error(PLAYWRIGHT_LAUNCH_FAILURE);
    const failure = await launchElectronOrExplain(STUB_LAUNCH_OPTIONS, () =>
      Promise.reject(original)
    ).then(
      () => null,
      (error: unknown) => error
    );

    assert.ok(failure instanceof Error);
    assert.equal(failure.cause, original);
  });

  test("the marker records the cause as unknown rather than asserting one", async () => {
    // A main-process crash on boot rejects identically to an unusable runner,
    // so a causal claim here would misroute a product regression to harness
    // triage. Asserts the short stable token, not the surrounding prose.
    const failure = await launchElectronOrExplain(STUB_LAUNCH_OPTIONS, () =>
      Promise.reject(new Error(PLAYWRIGHT_LAUNCH_FAILURE))
    ).then(
      () => null,
      (error: unknown) => error
    );

    assert.ok(failure instanceof Error);
    assert.ok(failure.message.includes("cause: UNKNOWN"));
  });

  test("a successful launch is returned untouched", async () => {
    let attempts = 0;
    const launched = await launchElectronOrExplain(STUB_LAUNCH_OPTIONS, () => {
      attempts += 1;
      return Promise.resolve(LAUNCHED_SENTINEL);
    });

    assert.equal(launched, LAUNCHED_SENTINEL);
    assert.equal(attempts, 1);
  });

  test("a non-Error rejection is still attributed", async () => {
    // Playwright is the normal source, but a launcher's own args/env builder can
    // reject with anything; the marker must not depend on the shape.
    const failure = await launchElectronOrExplain(STUB_LAUNCH_OPTIONS, () =>
      Promise.reject("spawn ENOENT")
    ).then(
      () => null,
      (error: unknown) => error
    );

    assert.ok(failure instanceof Error);
    assert.ok(failure.message.includes(HARNESS_LAUNCH_FAILURE_MARKER));
    assert.ok(failure.message.includes("spawn ENOENT"));
  });
});

describe("launcher wiring (ISS-6875)", () => {
  const launchers = [
    ...electronLaunchers(E2E_DIR, DESKTOP_ROOT),
    ...electronLaunchers(SOAK_DIR, DESKTOP_ROOT),
  ];
  const cleanups: string[] = [];
  afterAll(() => {
    for (const dir of cleanups) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the derivation matches both spellings of Playwright's electron export", () => {
    // Today's launchers write `_electron as electron`, so a derivation keyed on
    // that one identifier looks complete while a launcher written against the
    // raw export drops out of the set — and a dropped launcher generates no
    // case at all, which is silent. Asserted directly rather than by planting a
    // fixture launcher, because a fixture cannot detect its own omission.
    assert.equal(
      countProbeLaunchCalls(
        "electron.launch({}); _electron.launch({}); notElectron.launch({});"
      ),
      2
    );
  });

  test("an ALIASED electron binding is derived from the import, not guessed", () => {
    // COUNTEREXAMPLE 1. A hard-coded receiver set recognizes exactly the two
    // aliases someone happened to think of; any third — and the alias is the
    // shipped style here, both launchers write `_electron as electron` — is a
    // bare launch that passes the guard by never being seen.
    assert.equal(
      countProbeLaunchCalls(
        `import { _electron as desktopElectron } from "${PLAYWRIGHT_MODULE}";
         desktopElectron.launch({});`
      ),
      1
    );
    // Reached through a namespace import, the other ordinary shape.
    assert.equal(
      countProbeLaunchCalls(
        `import * as playwright from "${PLAYWRIGHT_MODULE}";
         playwright._electron.launch({});`
      ),
      1
    );
    // The derivation must stay a derivation: an alias of something else, and a
    // same-named binding from another module, are not Playwright's Electron.
    assert.equal(
      countProbeLaunchCalls(
        `import { expect as desktopElectron } from "${PLAYWRIGHT_MODULE}";
         desktopElectron.launch({});`
      ),
      0
    );
    assert.equal(
      countProbeLaunchCalls(
        `import { _electron as desktopElectron } from "./local-barrel";
         desktopElectron.launch({});`
      ),
      0
    );
  });

  test("the scan covers every extension the Playwright runner collects", () => {
    // COUNTEREXAMPLE 2's premise, pinned against the runner's OWN regex rather
    // than against a comment. `testMatch` is unanchored, so `.spec.tsx` runs in
    // the suite; a scan that stopped at `.ts` dropped such a file before any
    // wrapper case was generated. Asserted one-way — tightening the config can
    // never turn this red, only a scan that stops covering it can.
    const testMatch = runnerTestMatch();
    for (const extension of [".ts", ".tsx"]) {
      if (testMatch.test(`some-name.spec${extension}`)) {
        assert.ok(
          RUNNER_SOURCE_EXTENSIONS.includes(extension),
          `runner collects ${extension} but the scan skips it`
        );
      }
    }
  });

  test("a `.tsx` spec with an aliased bare launch is caught, not skipped", () => {
    // COUNTEREXAMPLE 2, end to end and through the real production path: both
    // escape hatches in ONE file, discovered by the same `electronLaunchers` the
    // generated cases below run on. Before this fix the file was not returned
    // at all, so the guard was green on a bare launch.
    const fixture = mkdtempSync(path.join(tmpdir(), "iss6875-guard-"));
    cleanups.push(fixture);
    writeFileSync(
      path.join(fixture, "bare.spec.tsx"),
      `import { _electron as desktopElectron } from "${PLAYWRIGHT_MODULE}";
       export const App = () => <div />;
       export const boot = () => desktopElectron.launch({});`
    );

    const found = electronLaunchers(fixture, fixture);

    assert.deepEqual(
      found.map(({ relativePath }) => relativePath),
      ["bare.spec.tsx"]
    );
    // And the case it generates genuinely fails: unwrapped < total.
    const [{ source, bindings }] = found;
    assert.equal(countElectronLaunchCalls(source, bindings), 1);
    assert.equal(countWrappedElectronLaunchCalls(source, bindings), 0);
  });

  test("the derivation finds the launchers it is meant to guard", () => {
    // A derivation that silently matched nothing would make every case below
    // vacuous — the failure mode of a stale hand-written list, reproduced.
    //
    // ISS-6929 collapsed both harness launchers onto `launchGuardedElectronApp`,
    // so `desktop-app.ts` is now the ONLY module under test/e2e that reaches
    // Playwright's Electron. The authenticated launcher moved to
    // `authenticated-desktop-app.ts` and reaches it through that guard, so it is
    // covered here by the site it delegates to rather than by a launch of its
    // own — pinning it again would pin a module that no longer launches.
    const paths = launchers.map(({ relativePath }) => relativePath);
    for (const launcher of [
      "test/e2e/helpers/desktop-app.ts",
      "test/soak/soak-app.ts",
    ]) {
      assert.ok(
        paths.includes(launcher),
        `derived launcher set was ${JSON.stringify(paths)}`
      );
    }
  });

  for (const { relativePath, source, bindings } of launchers) {
    test(`${relativePath} launches through ${WRAPPER}`, () => {
      // A launch outside the wrapper reports a death Playwright described as
      // `Process failed to launch!` and nothing else — the state this fixed.
      assert.equal(
        countWrappedElectronLaunchCalls(source, bindings),
        countElectronLaunchCalls(source, bindings),
        `${relativePath} has an electron.launch outside ${WRAPPER}`
      );
    });
  }
});

/** Launch calls in a synthetic module, with bindings derived from its own imports. */
function countProbeLaunchCalls(sourceText: string): number {
  const probe = ts.createSourceFile(
    "probe.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false
  );
  return countElectronLaunchCalls(probe, electronBindings(probe));
}

/** The Desktop runner's `testMatch`, read out of `playwright.config.ts` itself. */
function runnerTestMatch(): RegExp {
  const config = parseTypeScriptFile(
    path.join(DESKTOP_ROOT, "playwright.config.ts")
  );
  let literal: string | undefined;
  forEachNode(config, (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "testMatch" &&
      ts.isRegularExpressionLiteral(node.initializer)
    ) {
      literal = node.initializer.text;
    }
  });
  if (!literal) {
    throw new Error("playwright.config.ts has no testMatch regex literal");
  }
  const parsed = REGEX_LITERAL.exec(literal);
  if (!parsed) {
    throw new Error(`testMatch was not a regex literal: ${literal}`);
  }
  return new RegExp(parsed[1], parsed[2]);
}

/** A never-settling window wait, so only the exit race can end a case. */
function pendingWindow(): Promise<string> {
  return new Promise<string>(() => {
    // Deliberately never settles: a case that passes anyway is not observing
    // the exit race, it is observing the window.
  });
}

/** A child handle that is alive until `exit` is emitted on it. */
function fakeChild(
  overrides: Partial<Pick<ExitObservableChild, "exitCode" | "signalCode">> = {}
): ExitObservableChild & EventEmitter {
  return Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    ...overrides,
  }) as ExitObservableChild & EventEmitter;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => null,
    (error: unknown) => error
  );
}

describe("windowless exit attribution (ISS-10066)", () => {
  test("a child that exits before the window is reported with its exit code", {
    timeout: WINDOWLESS_CASE_TIMEOUT_MS,
  }, async () => {
    const child = fakeChild();
    const raced = firstWindowOrExplainExit(pendingWindow(), child);
    child.emit("exit", 1, null);

    const failure = await rejectionOf(raced);

    assert.ok(failure instanceof Error);
    // Read through the import so a rename reds rather than a stale literal.
    assert.ok(failure.message.startsWith(WINDOWLESS_EXIT_HEADLINE));
    // The deliverable: the run says WHICH exit, not that 30s elapsed.
    assert.ok(failure.message.includes("exit code 1"));
    // Same grepped token the launch-death family carries, so one search finds
    // both halves of "the app did not come up".
    assert.ok(failure.message.includes(HARNESS_LAUNCH_FAILURE_MARKER));
  });

  test("a child that already exited is reported without waiting for the event", {
    timeout: WINDOWLESS_CASE_TIMEOUT_MS,
  }, async () => {
    // `exit` has already fired by the time the race is set up, so a version
    // built only on the listener waits the full window budget for an event that
    // can never arrive again.
    const child = fakeChild({ exitCode: 9 });

    const failure = await rejectionOf(
      firstWindowOrExplainExit(pendingWindow(), child)
    );

    assert.ok(failure instanceof Error);
    assert.ok(failure.message.includes("exit code 9"));
  });

  test("a signalled death names the signal rather than a missing code", {
    timeout: WINDOWLESS_CASE_TIMEOUT_MS,
  }, async () => {
    // A SIGKILL/SIGSEGV exit carries `code: null`, which is exactly the shape a
    // code-only reader turns back into "reason unavailable".
    const child = fakeChild();
    const raced = firstWindowOrExplainExit(pendingWindow(), child);
    child.emit("exit", null, "SIGKILL");

    const failure = await rejectionOf(raced);

    assert.ok(failure instanceof Error);
    assert.ok(failure.message.includes("killed by SIGKILL"));
  });

  test("the message is exactly the headline plus one exit line", {
    timeout: WINDOWLESS_CASE_TIMEOUT_MS,
  }, async () => {
    // Same grouping contract as the launch-death message: one constant headline,
    // everything per-run on its own line, so a consumer that fingerprints the
    // first line sees one family and not N.
    const child = fakeChild({ signalCode: "SIGSEGV" });

    const failure = await rejectionOf(
      firstWindowOrExplainExit(pendingWindow(), child)
    );

    assert.ok(failure instanceof Error);
    assert.equal(
      failure.message,
      `${WINDOWLESS_EXIT_HEADLINE}\n  electron: killed by SIGSEGV`
    );
    assert.ok(
      WINDOWLESS_EXIT_HEADLINE.startsWith(HARNESS_LAUNCH_FAILURE_MARKER)
    );
    // The two headlines must stay distinguishable: this one HAS the exit code
    // the launch-death one says it cannot get.
    assert.notEqual(WINDOWLESS_EXIT_HEADLINE, HARNESS_LAUNCH_FAILURE_HEADLINE);
  });

  test("a live app that simply never opened a window keeps Playwright's own error", async () => {
    // The near-miss that matters. Widening this into "any window rejection is an
    // exit" would relabel every genuine 30s timeout as a crash and send the next
    // reader hunting an exit code that does not exist.
    const child = fakeChild();
    const timeout = new Error(
      'electronApplication.firstWindow: Timeout 30000ms exceeded while waiting for event "window"'
    );

    const failure = await rejectionOf(
      firstWindowOrExplainExit(Promise.reject(timeout), child)
    );

    assert.equal(failure, timeout);
    assert.equal(child.listenerCount("exit"), 0);
  });

  test("a window that arrives is returned untouched and leaves no listener", async () => {
    const child = fakeChild();

    const page = await firstWindowOrExplainExit(
      Promise.resolve(LAUNCHED_SENTINEL),
      child
    );

    assert.equal(page, LAUNCHED_SENTINEL);
    // A listener per launch on a suite that launches ~100 times a run is a leak
    // and a `MaxListenersExceededWarning`, not merely untidy.
    assert.equal(child.listenerCount("exit"), 0);
  });

  test("no child handle degrades to the plain await, both ways", async () => {
    // ISS-7654's rule applied to launch: with no handle nothing observed an
    // exit, so nothing may claim one.
    assert.equal(
      await firstWindowOrExplainExit(
        Promise.resolve(LAUNCHED_SENTINEL),
        undefined
      ),
      LAUNCHED_SENTINEL
    );

    const timeout = new Error("no handle, no extra fact");
    assert.equal(
      await rejectionOf(
        firstWindowOrExplainExit(Promise.reject(timeout), undefined)
      ),
      timeout
    );
  });
});

describe("windowless exit wiring (ISS-10066)", () => {
  const scanned = [
    ...harnessSourceFiles(E2E_DIR, DESKTOP_ROOT),
    ...harnessSourceFiles(SOAK_DIR, DESKTOP_ROOT),
  ].map((relativePath) => ({
    relativePath,
    source: parseTypeScriptFile(path.join(DESKTOP_ROOT, relativePath)),
  }));

  test("every `firstWindow()` in the launch harnesses is raced against the child's exit", () => {
    const unwrapped = scanned
      .filter(
        ({ source }) =>
          countFirstWindowCalls(source) > countWrappedFirstWindowCalls(source)
      )
      .map(({ relativePath }) => relativePath);

    // The comparison is per-file COUNTS, so what it pins is the CALL SHAPE and
    // not the guarantee: hoisting the wait out
    // (`const p = app.firstWindow(); await firstWindowOrExplainExit(p, child)`)
    // is equally correct and still reds here. That is a deliberate floor rather
    // than an oversight — deciding the hoisted case needs dataflow, and a guard
    // that tried would go quiet on the case it exists for. Every shipped call
    // site inlines the wait; a future one that cannot should widen this into a
    // real dataflow check rather than drop the file from the scan.
    assert.deepEqual(
      unwrapped,
      [],
      `these files call firstWindow() outside ${EXIT_RACE_WRAPPER}(...); pass the wait INLINE as its first argument`
    );
  });

  test("the scan actually found calls to guard", () => {
    // Without this the case above is green on an empty set — which is what a
    // renamed `firstWindow`, a moved scan root, or a broken parse all look like.
    const total = scanned.reduce(
      (sum, { source }) => sum + countFirstWindowCalls(source),
      0
    );

    assert.ok(total > 0, "no firstWindow() call sites were scanned");
  });

  test("each scanned root contributes call sites of its own", () => {
    // `total > 0` above is satisfied by the e2e root ALONE, so it cannot tell a
    // covered soak harness from a SOAK_DIR that moved out from under the scan.
    // Per root, so widening the scope buys coverage rather than a longer list.
    for (const [label, dir] of [
      ["e2e", E2E_DIR],
      ["soak", SOAK_DIR],
    ] as const) {
      const calls = harnessSourceFiles(dir, DESKTOP_ROOT).reduce(
        (sum, relativePath) =>
          sum +
          countFirstWindowCalls(
            parseTypeScriptFile(path.join(DESKTOP_ROOT, relativePath))
          ),
        0
      );

      assert.ok(
        calls > 0,
        `no firstWindow() call sites were scanned in ${label}`
      );
    }
  });
});

/** Count of `<app>.firstWindow(...)` under `root`. */
function countFirstWindowCalls(root: ts.Node): number {
  let count = 0;
  forEachNode(root, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === FIRST_WINDOW
    ) {
      count += 1;
    }
  });
  return count;
}

/** Count of those calls that sit INSIDE a `firstWindowOrExplainExit(...)`. */
function countWrappedFirstWindowCalls(source: ts.SourceFile): number {
  let count = 0;
  forEachNode(source, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === EXIT_RACE_WRAPPER
    ) {
      count += countFirstWindowCalls(node);
    }
  });
  return count;
}
