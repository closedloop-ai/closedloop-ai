/**
 * ISS-5346: the PRODUCTION wiring of the reveal, exercised as behavior.
 *
 * This file used to AST-scan `window.ts` and `desktop-services.ts` for method
 * names. That only proved the identifiers appeared in the source: a dead branch,
 * or a waiter that resolved immediately, kept it green — and `apps/desktop`'s
 * scoped rules (plus `scripts/lint/rules/no-raw-text-source-scan.ts`) direct
 * inline `window.ts` handlers toward extracted behavioral tests instead.
 *
 * So it now DRIVES the real chain. Everything under test is the shipped module:
 *
 *   `registerRendererLifecycleIpcHandlers` (the real IPC registrar)
 *     → phase narrowing (`toRendererReadyPhase`)
 *     → `RendererReadinessGates` (the real gates)
 *     → `InitialWindowRevealGate` (the real one-shot reveal sequencer)
 *
 * assembled the way `composition/desktop-services.ts` assembles it. Only the two
 * ends that need Electron are stood in for: the `ipcMain` registrar and
 * `DesktopWindow`'s trust check + `showInitialWindow`. The launched-Electron
 * half — that the real `BrowserWindow` stays hidden until this chain fires — is
 * `test/e2e/startup-window-reveal.spec.ts`.
 *
 * The one link that cannot be driven is `DesktopApplication.handleActivate` —
 * `app.ts` statically imports `electron`, so it cannot be loaded here at all.
 * Its intent argument is revert-proofed by the AST guard at the bottom of this
 * file (the sanctioned `ts.createSourceFile` alternative to a raw text scan),
 * because `show()`/`showWindow()` default to `UserRequested`: dropping the
 * argument compiles, passes every runnable test, and silently restores the
 * pre-ISS-5346 dead-shell reveal on every macOS cold launch.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { WebContents } from "electron";
import type {
  MethodDeclaration,
  Node,
  ObjectLiteralExpression,
  SourceFile,
} from "typescript6";
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSpreadAssignment,
  ScriptKind,
  ScriptTarget,
} from "typescript6";

import {
  RendererLifecycleIpcChannel,
  registerRendererLifecycleIpcHandlers,
} from "../src/main/ipc/renderer-lifecycle-ipc.js";
import {
  InitialWindowRevealGate,
  WindowRevealReason,
  WindowShowIntent,
} from "../src/main/lifecycle/initial-window-reveal-gate.js";
import { RendererReadinessGates } from "../src/main/lifecycle/renderer-readiness-gates.js";
import {
  E2E_NO_REVEAL_ARG,
  isWindowRevealSuppressed,
  windowRevealSuppressedWebPreferences,
} from "../src/main/lifecycle/window-reveal-suppression.js";
import { RendererReadyPhase } from "../src/shared/renderer-ready-phase.js";
import { windowRevealLaunchArgs } from "./e2e/helpers/desktop-app.js";

type IpcEvent = { sender: WebContents };
type IpcListener = (event: IpcEvent, ...args: unknown[]) => void;

// The ready handler probes `sender.isDestroyed()` before acking, so the stand-in
// needs that much of the surface. Test-code cast (see the no-double-cast gate's
// test exemption) — a real `WebContents` requires a live Electron process.
const TRUSTED_SENDER = {
  isDestroyed: () => false,
  send: () => undefined,
} as unknown as WebContents;

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function silentLog(): { info: () => void; warn: () => void } {
  return { info: () => undefined, warn: () => undefined };
}

/**
 * The production reveal chain, wired as `desktop-services.ts` wires it, driven
 * through the real `registerRendererLifecycleIpcHandlers`.
 *
 * `handleRendererReady` mirrors the shipped `DesktopWindow.handleRendererReady`
 * body — trust gate, mount notification on the `Mounted` phase, then arm the
 * one-shot gate — because that method cannot be reached without booting
 * Electron.
 */
function createRevealPipeline(options: { isTrustedSender?: boolean } = {}) {
  const listeners = new Map<string, IpcListener>();
  const revealed: WindowRevealReason[] = [];
  const gates = new RendererReadinessGates(silentLog());
  const revealGate = new InitialWindowRevealGate({
    waitForReadiness: () => gates.waitForInitialWindowRevealReadiness(),
    reveal: (reason) => revealed.push(reason),
  });
  const isTrustedSender = options.isTrustedSender ?? true;

  registerRendererLifecycleIpcHandlers(
    {
      on: (channel: string, listener: IpcListener) => {
        listeners.set(channel, listener);
      },
    },
    {
      isTrustedSender: () => isTrustedSender,
      handleRendererReady: (_sender, phase) => {
        if (!isTrustedSender) {
          return;
        }
        if (phase === RendererReadyPhase.Mounted) {
          gates.notifyRendererMounted();
        }
        revealGate.requestReveal();
      },
      yieldToMainLoop: () => Promise.resolve(),
      isShuttingDown: () => false,
      isLocalSessionSourceReady: () => false,
      notifyInitialRendererLiveDbIdle: () =>
        gates.notifyInitialRendererLiveDbIdle(),
      notifyRendererUserInput: () => gates.notifyRendererUserInput(),
    }
  );

  return {
    revealed,
    gates,
    revealGate,
    emitRendererReady: (phase?: unknown) => {
      listeners.get(RendererLifecycleIpcChannel.RendererReady)?.(
        { sender: TRUSTED_SENDER },
        phase
      );
    },
    emitLiveDbIdle: () => {
      listeners.get(RendererLifecycleIpcChannel.RendererLiveDbIdle)?.({
        sender: TRUSTED_SENDER,
      });
    },
  };
}

describe("ISS-5346 reveal-gate production wiring", () => {
  test("the pre-mount Shell phase arms the gate but does not reveal", async () => {
    const pipeline = createRevealPipeline();

    pipeline.emitRendererReady(RendererReadyPhase.Shell);
    await flushMicrotasks();

    // The regression in one assertion: `renderer-ready-signal.ts` fires this
    // phase before the React entry mounts, so revealing on it exposes a shell
    // that is painted but not live.
    assert.deepEqual(pipeline.revealed, []);
  });

  test("the Mounted phase releases the reveal", async () => {
    const pipeline = createRevealPipeline();

    pipeline.emitRendererReady(RendererReadyPhase.Shell);
    await flushMicrotasks();
    assert.deepEqual(pipeline.revealed, []);

    pipeline.emitRendererReady(RendererReadyPhase.Mounted);
    await flushMicrotasks();

    assert.deepEqual(pipeline.revealed, [WindowRevealReason.AppMounted]);
  });

  test("an absent phase narrows to Shell rather than revealing", async () => {
    const pipeline = createRevealPipeline();

    // A payload-free `desktop:renderer-ready` (an older renderer bundle, or any
    // caller not taught the phase) must keep its conservative pre-ISS-5346
    // meaning instead of being read as a mount.
    pipeline.emitRendererReady(undefined);
    await flushMicrotasks();

    assert.deepEqual(pipeline.revealed, []);
  });

  test("an unknown phase string narrows to Shell rather than revealing", async () => {
    const pipeline = createRevealPipeline();

    pipeline.emitRendererReady("some-future-phase");
    await flushMicrotasks();

    assert.deepEqual(pipeline.revealed, []);
  });

  test("the downstream live-DB-idle IPC does not reveal the window", async () => {
    // Guards the circularity fix at the wiring level: the reveal must not be
    // released by a signal that only exists after the window is shown.
    const pipeline = createRevealPipeline();

    pipeline.emitRendererReady(RendererReadyPhase.Shell);
    pipeline.emitLiveDbIdle();
    pipeline.gates.notifyInitialDashboardDataServed();
    await flushMicrotasks();

    assert.deepEqual(pipeline.revealed, []);
  });

  test("an untrusted sender neither mounts nor reveals", async () => {
    const pipeline = createRevealPipeline({ isTrustedSender: false });

    pipeline.emitRendererReady(RendererReadyPhase.Mounted);
    await flushMicrotasks();

    assert.deepEqual(pipeline.revealed, []);
  });

  test("the reveal is one-shot across repeated Mounted signals", async () => {
    const pipeline = createRevealPipeline();

    pipeline.emitRendererReady(RendererReadyPhase.Mounted);
    pipeline.emitRendererReady(RendererReadyPhase.Mounted);
    await pipeline.revealGate.whenRevealSettled();
    await flushMicrotasks();

    assert.deepEqual(pipeline.revealed, [WindowRevealReason.AppMounted]);
  });
});

const testDir = path.dirname(fileURLToPath(import.meta.url));
const appModulePath = path.resolve(testDir, "../src/main/app.ts");

/** The `showWindow(...)` argument text inside `DesktopApplication.handleActivate`. */
function readActivateShowWindowArguments(): string[] {
  const sourceFile = createSourceFile(
    appModulePath,
    readFileSync(appModulePath, "utf8"),
    ScriptTarget.Latest,
    true,
    ScriptKind.TS
  );

  let activate: MethodDeclaration | null = null;
  const findActivate = (node: Node): void => {
    if (
      isMethodDeclaration(node) &&
      node.name.getText(sourceFile) === "handleActivate"
    ) {
      activate = node;
      return;
    }
    forEachChild(node, findActivate);
  };
  forEachChild(sourceFile, findActivate);
  if (!activate) {
    throw new Error("DesktopApplication.handleActivate not found in app.ts");
  }

  const calls: string[][] = [];
  const findShowWindow = (node: Node): void => {
    if (
      isCallExpression(node) &&
      isPropertyAccessExpression(node.expression) &&
      node.expression.name.getText(sourceFile) === "showWindow"
    ) {
      calls.push(node.arguments.map((arg) => arg.getText(sourceFile)));
    }
    forEachChild(node, findShowWindow);
  };
  forEachChild(activate, findShowWindow);
  if (calls.length !== 1) {
    throw new Error(
      `expected exactly one showWindow call in handleActivate, found ${calls.length}`
    );
  }
  return calls[0];
}

describe("ISS-5346 handleActivate show intent", () => {
  test("handleActivate shows with the AppActivated intent", () => {
    // macOS emits `activate` on the COLD LAUNCH as well as on a dock click, and
    // `boot()` only inits the window (it never shows it), so this call is the
    // launch-time show. Passing the default `UserRequested` here would reveal
    // the pre-mount shell on every macOS boot — the exact ISS-5346 bug.
    assert.deepEqual(readActivateShowWindowArguments(), [
      "WindowShowIntent.AppActivated",
    ]);
  });

  test("the asserted intent member exists on the shipped const object", () => {
    // Keeps the AST guard honest: a renamed/removed member would otherwise leave
    // the source-text assertion above passing against a symbol that is gone.
    assert.equal(WindowShowIntent.AppActivated, "app-activated");
  });
});

describe("ISS-5987 window-reveal suppression", () => {
  const UNPACKAGED = { isPackaged: false };

  test("a launch without the argument is not suppressed", () => {
    // The load-bearing case: production launches carry no such argument, so the
    // ISS-5346 reveal sequence above stays exactly as it was.
    assert.equal(
      isWindowRevealSuppressed(
        ["/path/to/electron", "dist/main/index.js", "--user-data-dir=/tmp/x"],
        UNPACKAGED
      ),
      false
    );
  });

  test("the argument suppresses an unpackaged launch", () => {
    assert.equal(
      isWindowRevealSuppressed(
        ["/path/to/electron", "dist/main/index.js", E2E_NO_REVEAL_ARG],
        UNPACKAGED
      ),
      true
    );
  });

  test("a packaged build ignores the argument", () => {
    // Defense in depth: the packaged app never passes it, and would not honor it
    // if something else did.
    assert.equal(
      isWindowRevealSuppressed([E2E_NO_REVEAL_ARG], { isPackaged: true }),
      false
    );
  });

  test("a look-alike argument does not suppress", () => {
    // Exact match only. `--e2e-no-reveal=false` reading as "suppress" would be
    // the worst possible interpretation of an operator's intent.
    assert.equal(
      isWindowRevealSuppressed(
        [`${E2E_NO_REVEAL_ARG}=false`, "--e2e-no-reveal-window"],
        UNPACKAGED
      ),
      false
    );
  });
});

describe("ISS-5987 which launches carry the suppression argument", () => {
  const originalPwDebug = process.env.PWDEBUG;

  afterEach(() => {
    if (originalPwDebug === undefined) {
      Reflect.deleteProperty(process.env, "PWDEBUG");
      return;
    }
    process.env.PWDEBUG = originalPwDebug;
  });

  test("an ordinary launch is suppressed", () => {
    // Cleared explicitly: an operator running THIS suite under `--debug` would
    // otherwise inherit a PWDEBUG that satisfies the opt-out below, and the
    // default would go untested.
    Reflect.deleteProperty(process.env, "PWDEBUG");

    assert.deepEqual(windowRevealLaunchArgs(false), [E2E_NO_REVEAL_ARG]);
  });

  test("a spec whose subject is the reveal opts out", () => {
    Reflect.deleteProperty(process.env, "PWDEBUG");

    assert.deepEqual(windowRevealLaunchArgs(true), []);
  });

  test("`playwright test --debug` reveals without editing a launch call", () => {
    // `--debug` is playwright's documented shortcut for PWDEBUG=1, which test
    // workers inherit. Without this branch it opened the Inspector against a
    // window that never reached the screen, and `launchAuthenticatedDesktopApp`
    // — which hardcodes `windowRevealLaunchArgs(false)` and takes no
    // `revealWindow` — could not be watched at all without a source edit.
    process.env.PWDEBUG = "1";

    assert.deepEqual(windowRevealLaunchArgs(false), []);
  });
});

const windowModulePath = path.resolve(testDir, "../src/main/window.ts");

/** The `webPreferences` object literal inside `new BrowserWindow({ ... })`. */
function findWebPreferences(
  node: Node,
  sourceFile: SourceFile
): ObjectLiteralExpression | null {
  if (
    isNewExpression(node) &&
    isIdentifier(node.expression) &&
    node.expression.text === "BrowserWindow"
  ) {
    const [options] = node.arguments ?? [];
    if (options && isObjectLiteralExpression(options)) {
      for (const property of options.properties) {
        if (
          isPropertyAssignment(property) &&
          property.name.getText(sourceFile) === "webPreferences" &&
          isObjectLiteralExpression(property.initializer)
        ) {
          return property.initializer;
        }
      }
    }
  }
  let found: ObjectLiteralExpression | null = null;
  forEachChild(node, (child) => {
    found ??= findWebPreferences(child, sourceFile);
  });
  return found;
}

/** The spread expressions `window.ts` mixes into that `webPreferences`. */
function readWebPreferencesSpreads(): string[] {
  const sourceFile = createSourceFile(
    windowModulePath,
    readFileSync(windowModulePath, "utf8"),
    ScriptTarget.Latest,
    true,
    ScriptKind.TS
  );
  const webPreferences = findWebPreferences(sourceFile, sourceFile);
  if (!webPreferences) {
    throw new Error(
      "new BrowserWindow({ webPreferences }) not found in window.ts"
    );
  }
  return webPreferences.properties
    .filter(isSpreadAssignment)
    .map((property) => property.expression.getText(sourceFile));
}

describe("ISS-6112 off-screen launches run unthrottled", () => {
  test("a suppressed launch disables background throttling", () => {
    // Electron's contract for this one flag: "whether to throttle animations
    // and timers when the page becomes background. This also affects the Page
    // Visibility API." That last clause is why one switch covers the clamped
    // timers, the paused rAF, AND the renderer's visibility-gated live bridge.
    assert.deepEqual(windowRevealSuppressedWebPreferences(true), {
      backgroundThrottling: false,
    });
  });

  test("an ordinary launch is left on Electron's default", () => {
    // The load-bearing half: a real user's backgrounded window MUST still
    // throttle. Returning `{}` rather than `{ backgroundThrottling: true }`
    // keeps the key absent from `webPreferences` entirely, so this is a
    // test-harness concession and not a product change.
    assert.deepEqual(windowRevealSuppressedWebPreferences(false), {});
  });

  test("window.ts actually spreads it into the constructed webPreferences", () => {
    // The unit tests above stay green if the call site is deleted, which is the
    // whole failure mode: the helper would be correct and unreachable, and the
    // suite would go back to running throttled with nothing red. This is the
    // sanctioned AST guard (see the `handleActivate` one above) on the real
    // production construction site.
    assert.ok(
      readWebPreferencesSpreads().includes(
        "windowRevealSuppressedWebPreferences(this.revealSuppressed)"
      ),
      `expected new BrowserWindow({ webPreferences }) to spread windowRevealSuppressedWebPreferences(this.revealSuppressed); found ${JSON.stringify(readWebPreferencesSpreads())}`
    );
  });
});
