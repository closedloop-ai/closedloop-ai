/**
 * @file renderer-health-telemetry.test.ts
 * @description ISS-6331 — the three renderer-lifecycle failures must each reach
 * the telemetry transport, distinguishably, without PII, and without flooding.
 *
 * Before this change `apps/desktop/src` registered NO listener for
 * `unresponsive`, `did-fail-load` or `preload-error` anywhere, and the reload
 * breaker's give-up branch answered with one local `gatewayLog.warn` that never
 * leaves the machine. All three are total product failures from the user's seat
 * and all three were invisible.
 *
 * Every leg here drives the SHIPPED production path — the real
 * `createRendererHealthReporter` and its listeners, the real
 * `evaluateRenderProcessGone` / `evaluateFrameRecovery` breaker, and the real
 * `Observability` transport — and asserts on the record that reached the
 * transport, never that a listener was registered.
 *
 * The one link this file cannot drive is `DesktopWindow` itself: `window.ts`
 * statically imports `electron` and its `init()` builds a real `BrowserWindow`
 * and loads content, exactly the constraint `initial-window-reveal-wiring.test.ts`
 * documents for the same file. Its four call sites are revert-proofed by the AST
 * guard at the bottom (the sanctioned `ts.createSourceFile` alternative to a raw
 * text scan), because each is a single statement whose deletion compiles and
 * leaves every runnable test green.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isIdentifier,
  isPropertyAccessExpression,
  type Node,
  ScriptKind,
  ScriptTarget,
  type SourceFile,
} from "typescript6";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateFrameRecovery,
  evaluateRenderProcessGone,
  MAX_CRASH_RELOADS,
} from "../src/main/ipc/renderer-ipc.js";
import { Observability } from "../src/main/telemetry/observability.js";
import {
  createRendererHealthReporter,
  NET_ERROR_ABORTED,
  RENDERER_HEALTH_DEDUPE_WINDOW_MS,
  RENDERER_HEALTH_MAX_TRACKED_SIGNALS,
  RENDERER_LOAD_FAILED_CATEGORY,
  RENDERER_RELOAD_BUDGET_EXHAUSTED_CATEGORY,
  RENDERER_UNRESPONSIVE_CATEGORY,
  type RendererHealthEventSource,
  type RendererHealthReporter,
} from "../src/main/telemetry/renderer-health-telemetry.js";
import type { EnrichedTelemetryEvent } from "../src/main/telemetry/telemetry-service.js";
import { fakeWindow } from "./helpers/fake-window.js";

/** A real Chromium net error a broken packaged install actually produces. */
const NET_ERROR_FILE_NOT_FOUND = -6;
const NET_ERROR_CONNECTION_REFUSED = -102;
const FIXED_CLOCK_MS = Date.UTC(2026, 7, 17, 12, 0, 0);
/** The loopback dev renderer `loadRendererContent` tries first and falls back from. */
const DEV_RENDERER_URL = "http://127.0.0.1:5173/";

/**
 * A packaged-app renderer URL. This is the ISS-6229 shape: a `file://` install
 * path whose third segment is the OS account name.
 */
const PACKAGED_RENDERER_URL =
  "file:///Users/alice/Applications/Closedloop.app/Contents/Resources/app/dist/renderer/index.html";
const OS_ACCOUNT_NAME = "alice";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WINDOW_SOURCE_PATH = path.join(__dirname, "../src/main/window.ts");

/** The sanitizer's path marker — its presence proves the URL was scrubbed, not dropped. */
const REDACTED_PATH_MARKER = /\[redacted-path\]/;
/** Non-PII diagnosis text that must SURVIVE, so a redaction test cannot pass by being empty. */
const FILE_NOT_FOUND_DIAGNOSIS = /ERR_FILE_NOT_FOUND/;
const PRELOAD_DIAGNOSIS = /Unable to load preload script/;
/** Wording only the give-up branch may carry. */
const GAVE_UP_WORDING = /no further recovery/;

type FailLoadArgs = {
  errorCode?: number;
  errorDescription?: string;
  validatedUrl?: string;
  isMainFrame?: boolean;
};

/**
 * A `webContents` stand-in that records the listeners the production installer
 * registers and can deliver each event with the argument list Electron uses.
 */
function fakeWebContents() {
  const listeners = new Map<string, (...args: never[]) => void>();
  const source: RendererHealthEventSource = {
    on(event: string, listener: (...args: never[]) => void) {
      listeners.set(event, listener);
      return source;
    },
  };
  function fire(event: string, args: unknown[]): void {
    const listener = listeners.get(event);
    if (!listener) {
      // A throw, not an assertion: the production installer failing to register
      // is a setup failure, and it must surface from whichever test drove it.
      throw new Error(`no production listener registered for "${event}"`);
    }
    (listener as (...fired: unknown[]) => void)(...args);
  }
  return {
    source,
    unresponsive: () => fire("unresponsive", [{}]),
    failLoad: (args: FailLoadArgs = {}) =>
      fire("did-fail-load", [
        {},
        args.errorCode ?? NET_ERROR_FILE_NOT_FOUND,
        args.errorDescription ?? "ERR_FILE_NOT_FOUND",
        args.validatedUrl ?? PACKAGED_RENDERER_URL,
        args.isMainFrame ?? true,
      ]),
    preloadError: (preloadPath: string, error: Error) =>
      fire("preload-error", [{}, preloadPath, error]),
  };
}

function initCapturing(): EnrichedTelemetryEvent[] {
  const events: EnrichedTelemetryEvent[] = [];
  Observability.init({ telemetrySend: (event) => events.push(event) });
  return events;
}

type ReporterOptions = {
  reloadsInWindow?: number;
  tearingDown?: boolean;
  recoveredLoadUrl?: string | null;
};

/**
 * Build the REAL reporter over a fake webContents. `tearingDown` is a mutable
 * box rather than a fixed boolean so a test can flip it mid-run, the way
 * `dispose()`/`setQuitting()` do in production.
 */
function reporterOver(
  webContents: RendererHealthEventSource,
  options: ReporterOptions = {}
): { reporter: RendererHealthReporter; teardown: { active: boolean } } {
  const teardown = { active: options.tearingDown ?? false };
  const reporter = createRendererHealthReporter({
    getReloadsInWindow: () => options.reloadsInWindow ?? 0,
    isTearingDown: () => teardown.active,
    getRecoveredLoadUrl: () => options.recoveredLoadUrl ?? null,
  });
  reporter.installListeners(webContents);
  return { reporter, teardown };
}

/** The common case: install and discard the handle. */
function installOver(
  webContents: RendererHealthEventSource,
  reloadsInWindow = 0
): RendererHealthReporter {
  return reporterOver(webContents, { reloadsInWindow }).reporter;
}

function categoriesOf(events: EnrichedTelemetryEvent[]): string[] {
  return events.map((event) => event.category);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_CLOCK_MS);
});

afterEach(() => {
  vi.useRealTimers();
  Observability.reset();
});

describe("ISS-6331 — each signal reaches the transport", () => {
  it("reports an unresponsive renderer with the reloads already spent", () => {
    const events = initCapturing();
    const webContents = fakeWebContents();
    installOver(webContents.source, 2);

    webContents.unresponsive();

    assert.equal(events.length, 1);
    assert.equal(events[0].category, RENDERER_UNRESPONSIVE_CATEGORY);
    assert.equal(events[0].severity, "error");
    assert.equal(events[0].diagnostics?.rendererHealth?.reloadsInWindow, 2);
    // A hang is not a load failure: nothing classifies it as one.
    assert.equal(events[0].diagnostics?.rendererHealth?.source, undefined);
  });

  it("reports a main-frame did-fail-load with Chromium's error code", () => {
    const events = initCapturing();
    const webContents = fakeWebContents();
    installOver(webContents.source, 1);

    webContents.failLoad({ errorCode: NET_ERROR_FILE_NOT_FOUND });

    assert.equal(events.length, 1);
    assert.equal(events[0].category, RENDERER_LOAD_FAILED_CATEGORY);
    assert.equal(
      events[0].diagnostics?.rendererHealth?.source,
      "did_fail_load"
    );
    assert.equal(
      events[0].diagnostics?.rendererHealth?.errorCode,
      NET_ERROR_FILE_NOT_FOUND
    );
    assert.equal(events[0].diagnostics?.rendererHealth?.reloadsInWindow, 1);
  });

  it("reports a preload-error as its own load-failure source", () => {
    const events = initCapturing();
    const webContents = fakeWebContents();
    installOver(webContents.source);

    webContents.preloadError(
      "/Applications/Closedloop.app/preload.js",
      new Error("preload script threw")
    );

    assert.equal(events.length, 1);
    assert.equal(events[0].category, RENDERER_LOAD_FAILED_CATEGORY);
    assert.equal(
      events[0].diagnostics?.rendererHealth?.source,
      "preload_error"
    );
    // No Chromium code exists for this listener; the field must be absent
    // rather than a fabricated 0.
    assert.equal(events[0].diagnostics?.rendererHealth?.errorCode, undefined);
  });

  it("reports breaker exhaustion only once the budget is actually spent", () => {
    const events = initCapturing();
    // The positive control: replay the exact loop `window.ts` runs, so the
    // breaker genuinely reaches its give-up state through real crash decisions
    // rather than a hand-set flag.
    const reporter = installOver(fakeWebContents().source);
    let reloadTimestamps: number[] = [];
    const exhaustedAfterCrash: number[] = [];
    for (let crash = 1; crash <= MAX_CRASH_RELOADS + 1; crash++) {
      const decision = evaluateRenderProcessGone({
        reason: "crashed",
        disposing: false,
        quitting: false,
        now: FIXED_CLOCK_MS + crash,
        reloadTimestamps,
      });
      reloadTimestamps = decision.reloadTimestamps;
      if (!decision.reload && decision.budgetExhausted) {
        exhaustedAfterCrash.push(crash);
        reporter.reportReloadBudgetExhausted(reloadTimestamps.length);
      }
    }

    assert.deepEqual(
      exhaustedAfterCrash,
      [MAX_CRASH_RELOADS + 1],
      "the breaker gives up on the crash AFTER the budget is spent, not before"
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].category, RENDERER_RELOAD_BUDGET_EXHAUSTED_CATEGORY);
    assert.equal(events[0].severity, "error");
    assert.equal(
      events[0].diagnostics?.rendererHealth?.reloadsInWindow,
      MAX_CRASH_RELOADS
    );
  });

  it("does not call a quit during a crash storm a give-up", () => {
    // Teardown declines to reload too, but the window is going away — reporting
    // it as exhaustion would page someone for every quit that follows a crash.
    const decision = evaluateRenderProcessGone({
      reason: "crashed",
      disposing: false,
      quitting: true,
      now: FIXED_CLOCK_MS,
      reloadTimestamps: [
        FIXED_CLOCK_MS - 3,
        FIXED_CLOCK_MS - 2,
        FIXED_CLOCK_MS - 1,
      ],
    });
    assert.equal(decision.reload, false);
    assert.equal(decision.budgetExhausted, false);
  });
});

describe("ISS-6331 — the three signals stay distinguishable", () => {
  it("emits three categories a reader can act on differently", () => {
    const events = initCapturing();
    const webContents = fakeWebContents();
    const reporter = installOver(webContents.source, 2);

    webContents.unresponsive();
    webContents.failLoad();
    reporter.reportReloadBudgetExhausted(MAX_CRASH_RELOADS);

    assert.deepEqual(categoriesOf(events), [
      RENDERER_UNRESPONSIVE_CATEGORY,
      RENDERER_LOAD_FAILED_CATEGORY,
      RENDERER_RELOAD_BUDGET_EXHAUSTED_CATEGORY,
    ]);
  });

  it("separates recovery-still-in-play from the budget being spent", () => {
    const events = initCapturing();
    const webContents = fakeWebContents();
    // Two reloads spent: recovery is still trying.
    const reporter = installOver(webContents.source, 2);
    webContents.failLoad();
    reporter.reportReloadBudgetExhausted(MAX_CRASH_RELOADS);

    const [stillRecovering, gaveUp] = events;
    assert.equal(stillRecovering.category, RENDERER_LOAD_FAILED_CATEGORY);
    assert.equal(
      stillRecovering.diagnostics?.rendererHealth?.reloadsInWindow,
      2
    );
    assert.equal(gaveUp.category, RENDERER_RELOAD_BUDGET_EXHAUSTED_CATEGORY);
    assert.equal(
      gaveUp.diagnostics?.rendererHealth?.reloadsInWindow,
      MAX_CRASH_RELOADS
    );
    // The load failure must not read as a give-up, and the give-up must not
    // read as a load failure — the categories, not a shared field, carry it.
    assert.notEqual(stillRecovering.category, gaveUp.category);
    expect(gaveUp.message).toMatch(GAVE_UP_WORDING);
    expect(stillRecovering.message).not.toMatch(GAVE_UP_WORDING);
  });
});

describe("ISS-6331 — no PII escapes on the load-failure payload", () => {
  it("redacts the packaged file:// URL while keeping the diagnosis", () => {
    const events = initCapturing();
    const webContents = fakeWebContents();
    installOver(webContents.source);

    webContents.failLoad({
      errorDescription: "ERR_FILE_NOT_FOUND",
      validatedUrl: PACKAGED_RENDERER_URL,
    });

    const detail = events[0].diagnostics?.rendererHealth?.detail;
    assert.ok(detail, "the load failure must still report a diagnosis");
    // Anchored on surviving non-PII text: this cannot pass by being empty.
    assert.match(detail, FILE_NOT_FOUND_DIAGNOSIS);
    assert.match(detail, REDACTED_PATH_MARKER);
    assert.ok(
      !detail.includes(OS_ACCOUNT_NAME),
      `detail leaked the OS account name: ${detail}`
    );
    assert.ok(!detail.includes("/Users"), `detail leaked a path: ${detail}`);
    assert.ok(!detail.includes("file://"), `detail leaked a URL: ${detail}`);
  });

  it("redacts the preload path out of a thrown preload message", () => {
    const events = initCapturing();
    const webContents = fakeWebContents();
    installOver(webContents.source);

    webContents.preloadError(
      "/Users/alice/Applications/Closedloop.app/Contents/preload.js",
      new Error(
        "Unable to load preload script: /Users/alice/Applications/Closedloop.app/Contents/preload.js"
      )
    );

    const detail = events[0].diagnostics?.rendererHealth?.detail;
    assert.ok(detail);
    assert.match(detail, PRELOAD_DIAGNOSIS);
    assert.match(detail, REDACTED_PATH_MARKER);
    assert.ok(
      !detail.includes(OS_ACCOUNT_NAME),
      `detail leaked the OS account name: ${detail}`
    );
  });
});

describe("ISS-6331 — the emission is bounded", () => {
  it("suppresses an identical repeat from a flapping renderer", () => {
    const events = initCapturing();
    const webContents = fakeWebContents();
    installOver(webContents.source);

    for (let flap = 0; flap < 10; flap++) {
      webContents.unresponsive();
    }

    assert.equal(events.length, 1);
  });

  it("still lets a CHANGED signal through inside the same window", () => {
    const events = initCapturing();
    const webContents = fakeWebContents();
    installOver(webContents.source);

    webContents.unresponsive();
    webContents.unresponsive();
    // A different condition entirely.
    webContents.failLoad({ errorCode: NET_ERROR_FILE_NOT_FOUND });
    webContents.failLoad({ errorCode: NET_ERROR_FILE_NOT_FOUND });
    // The same condition, reclassified.
    webContents.failLoad({ errorCode: NET_ERROR_CONNECTION_REFUSED });

    assert.deepEqual(categoriesOf(events), [
      RENDERER_UNRESPONSIVE_CATEGORY,
      RENDERER_LOAD_FAILED_CATEGORY,
      RENDERER_LOAD_FAILED_CATEGORY,
    ]);
    assert.deepEqual(
      events.slice(1).map((e) => e.diagnostics?.rendererHealth?.errorCode),
      [NET_ERROR_FILE_NOT_FOUND, NET_ERROR_CONNECTION_REFUSED]
    );
  });

  it("re-admits the same signal once the window elapses", () => {
    const events = initCapturing();
    const webContents = fakeWebContents();
    installOver(webContents.source);

    webContents.unresponsive();
    vi.setSystemTime(FIXED_CLOCK_MS + RENDERER_HEALTH_DEDUPE_WINDOW_MS - 1);
    webContents.unresponsive();
    assert.equal(events.length, 1, "still inside the window");

    vi.setSystemTime(FIXED_CLOCK_MS + RENDERER_HEALTH_DEDUPE_WINDOW_MS);
    webContents.unresponsive();
    assert.equal(events.length, 2, "the window elapsed, so the hang is news");
  });

  it("caps the tracked-signal map instead of growing per error code", () => {
    const events = initCapturing();
    const webContents = fakeWebContents();
    installOver(webContents.source);

    // One distinct key per error code, past the cap, all inside the window.
    for (let index = 0; index <= RENDERER_HEALTH_MAX_TRACKED_SIGNALS; index++) {
      webContents.failLoad({ errorCode: -1000 - index });
    }
    const admittedBefore = events.length;

    // The FIRST key must have been evicted by the cap, so re-emitting it inside
    // the window is admitted again. A map that grew without bound would still
    // remember it and suppress.
    webContents.failLoad({ errorCode: -1000 });

    assert.equal(admittedBefore, RENDERER_HEALTH_MAX_TRACKED_SIGNALS + 1);
    assert.equal(events.length, admittedBefore + 1);
  });

  it("clears its suppression state on reset", () => {
    const events = initCapturing();
    const webContents = fakeWebContents();
    const reporter = installOver(webContents.source);

    webContents.unresponsive();
    reporter.dispose();
    webContents.unresponsive();

    assert.equal(events.length, 2);
  });
});

describe("ISS-6331 — noise the listeners must not report", () => {
  it("ignores a sub-frame load failure", () => {
    const events = initCapturing();
    const webContents = fakeWebContents();
    installOver(webContents.source);

    webContents.failLoad({ isMainFrame: false });

    assert.deepEqual(events, []);
  });

  it("ignores ERR_ABORTED, which every superseded reload produces", () => {
    const events = initCapturing();
    const webContents = fakeWebContents();
    installOver(webContents.source);

    webContents.failLoad({
      errorCode: NET_ERROR_ABORTED,
      errorDescription: "ERR_ABORTED",
    });

    assert.deepEqual(events, []);
  });

  it("ignores the dev-renderer probe the bundled fallback recovers from", () => {
    const events = initCapturing();
    const webContents = fakeWebContents();
    reporterOver(webContents.source, { recoveredLoadUrl: DEV_RENDERER_URL });

    // `loadRendererContent` tries the dev URL FIRST and a down Vite server is
    // explicitly non-fatal — it falls through to the bundled `app://` asset and
    // the window paints. Reporting this would fire an error-severity "nothing
    // ever painted" on every dev launch without Vite.
    webContents.failLoad({
      errorCode: NET_ERROR_CONNECTION_REFUSED,
      errorDescription: "ERR_CONNECTION_REFUSED",
      validatedUrl: DEV_RENDERER_URL,
    });
    assert.deepEqual(events, []);

    // The bundled asset failing is the real thing and must still be reported,
    // so the filter cannot be a blanket mute.
    webContents.failLoad({
      errorCode: NET_ERROR_FILE_NOT_FOUND,
      validatedUrl: PACKAGED_RENDERER_URL,
    });
    assert.deepEqual(categoriesOf(events), [RENDERER_LOAD_FAILED_CATEGORY]);
  });

  it("stays silent while the window is tearing down", () => {
    const events = initCapturing();
    const webContents = fakeWebContents();
    const { reporter, teardown } = reporterOver(webContents.source);

    // Quit and dispose make the renderer hang and fail loads BY DESIGN; every
    // sibling handler in window.ts takes the same guard, or a quit pages someone.
    teardown.active = true;
    webContents.unresponsive();
    webContents.failLoad();
    reporter.reportReloadBudgetExhausted(MAX_CRASH_RELOADS);
    assert.deepEqual(events, []);

    // And the guard must not latch: the same window, still alive, still reports.
    teardown.active = false;
    webContents.unresponsive();
    assert.deepEqual(categoriesOf(events), [RENDERER_UNRESPONSIVE_CATEGORY]);
  });
});

describe("ISS-6331 — the frame-disposal path shares the breaker", () => {
  /** A live window whose Chromium frame is gone — the sleep/wake shape. */
  const disposedFrameWindow = () => fakeWindow({ frameDestroyed: true });

  it("declares exhaustion once the shared budget is spent", () => {
    const spent = [FIXED_CLOCK_MS - 3, FIXED_CLOCK_MS - 2, FIXED_CLOCK_MS - 1];
    const result = evaluateFrameRecovery({
      window: disposedFrameWindow(),
      disposing: false,
      quitting: false,
      recovering: false,
      now: FIXED_CLOCK_MS,
      reloadTimestamps: spent,
    });

    assert.equal(result.shouldReload, false);
    assert.equal(
      result.budgetExhausted,
      true,
      "a frame disposed after the budget is spent leaves the same blank, un-retried window"
    );
    assert.equal(result.reloadTimestamps.length, MAX_CRASH_RELOADS);
  });

  it("does not declare exhaustion while recovery is still available", () => {
    const result = evaluateFrameRecovery({
      window: disposedFrameWindow(),
      disposing: false,
      quitting: false,
      recovering: false,
      now: FIXED_CLOCK_MS,
      reloadTimestamps: [FIXED_CLOCK_MS - 1],
    });

    assert.equal(result.shouldReload, true);
    assert.equal(result.budgetExhausted, false);
  });

  it("does not declare exhaustion during teardown or an in-flight recovery", () => {
    const spent = [FIXED_CLOCK_MS - 3, FIXED_CLOCK_MS - 2, FIXED_CLOCK_MS - 1];
    for (const guard of [
      { disposing: true, quitting: false, recovering: false },
      { disposing: false, quitting: true, recovering: false },
      { disposing: false, quitting: false, recovering: true },
    ]) {
      const result = evaluateFrameRecovery({
        window: disposedFrameWindow(),
        now: FIXED_CLOCK_MS,
        reloadTimestamps: spent,
        ...guard,
      });
      assert.equal(result.shouldReload, false);
      assert.equal(
        result.budgetExhausted,
        false,
        `teardown/recovery guard ${JSON.stringify(guard)} must not read as a give-up`
      );
    }
  });
});

/**
 * `window.ts` cannot be loaded here (static `electron` import; `init()` builds a
 * real `BrowserWindow`), and both wiring lines are single statements whose
 * deletion compiles and leaves every test above green. This is the same
 * `ts.createSourceFile` guard `initial-window-reveal-wiring.test.ts` uses for
 * the same file and the same reason.
 */
describe("ISS-6331 — window.ts keeps its call sites", () => {
  it("builds the reporter, installs it, reports exhaustion, and disposes it", () => {
    const source = createSourceFile(
      "window.ts",
      readFileSync(WINDOW_SOURCE_PATH, "utf8"),
      ScriptTarget.Latest,
      true,
      ScriptKind.TS
    );

    assert.equal(
      countCalls(source, "createRendererHealthReporter"),
      1,
      "each window must own exactly one reporter, so one window cannot suppress another's signals"
    );
    assert.equal(
      countCalls(source, "installListeners"),
      1,
      "window.ts must install the renderer-health listeners on its webContents"
    );
    assert.equal(
      countCalls(source, "reportReloadBudgetExhausted"),
      2,
      "both breaker give-up branches (render-process-gone and frame disposal) must report"
    );
    assert.ok(
      countCalls(source, "dispose") >= 1,
      "dispose() must drop the reporter's suppression state with the window"
    );
  });
});

/**
 * Counts calls to `name` whether it is invoked bare (`f()`) or as a method
 * (`this.rendererHealth.f()`) — the guard must not go quiet because a call site
 * moved onto an object.
 */
function countCalls(source: SourceFile, name: string): number {
  let count = 0;
  visitCallExpressions(source, (called) => {
    if (called === name) {
      count += 1;
    }
  });
  return count;
}

function visitCallExpressions(
  node: Node,
  onCalledName: (name: string) => void
): void {
  if (isCallExpression(node)) {
    const callee = node.expression;
    if (isIdentifier(callee)) {
      onCalledName(callee.text);
    } else if (
      isPropertyAccessExpression(callee) &&
      isIdentifier(callee.name)
    ) {
      onCalledName(callee.name.text);
    }
  }
  forEachChild(node, (child) => {
    visitCallExpressions(child, onCalledName);
  });
}
