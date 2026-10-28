/**
 * Spec-side controls for the desktop auth-bridge gate (ISS-8288).
 *
 * The gate itself is a main-process `-r` preload — see
 * `desktop-auth-state-gate-preload.cjs` for WHY the seam is here, and which two
 * channels it has to cover for the hold to be race-free. This module is the half
 * the spec talks to: the launch switches that install it, and the
 * `ElectronApplication.evaluate` calls that read its counters and release it.
 *
 * Deliberately electron-free and `@repo/*`-free, for the same reason
 * `sessions-page-data-gate.ts` is: an extension-less `@repo/*` subpath does not
 * resolve under Playwright's ESM loader, and importing one from a spec aborts
 * the WHOLE desktop-e2e suite at load time with no failing test name to point at
 * it (`apps/desktop/test/AGENTS.md`).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The global the preload publishes its state on, in the MAIN process. */
const GATE_KEY = "__clE2eDesktopAuthStateGate";

/** What the preload publishes on that global, in the main process. */
type DesktopAuthStateGate = {
  held: boolean;
  pullsHeld: number;
  probePushSuppression: () => number;
  release: () => number;
};

/** The Electron switches that install the gate, or nothing when unasked. */
export function desktopAuthStateGateLaunchArgs(enabled: boolean): string[] {
  return enabled
    ? ["-r", path.join(__dirname, "desktop-auth-state-gate-preload.cjs")]
    : [];
}

/** The env the preload reads, or nothing when no spec asked for the gate. */
export function desktopAuthStateGateEnv(
  enabled: boolean
): Record<string, string> {
  return enabled ? { CL_E2E_DESKTOP_AUTH_STATE_GATE: "1" } : {};
}

/** The gate operations a spec can drive from the test process. */
type AuthGateOperation = "probePushSuppression" | "pullsHeld" | "release";

/**
 * Run one gate operation in the MAIN process. One `evaluate` over an operation
 * name rather than one per accessor, because the body cannot close over
 * anything in this file (Playwright serializes it).
 */
function callGate(
  app: ElectronApplication,
  operation: AuthGateOperation
): Promise<number> {
  return app.evaluate(
    (_electron, request) => {
      const gate: DesktopAuthStateGate | undefined = Reflect.get(
        globalThis,
        request.key
      );
      if (!gate) {
        throw new Error(
          "the desktop auth-state gate preload was never installed"
        );
      }
      if (request.operation === "release") {
        return gate.release();
      }
      if (request.operation === "probePushSuppression") {
        return gate.probePushSuppression();
      }
      return gate.pullsHeld;
    },
    { key: GATE_KEY, operation }
  );
}

/**
 * How many `desktop:get-desktop-auth-state` pulls the gate has PARKED.
 *
 * The pull half's proof of effect: a spec that asserts the deadline branch has
 * to be able to say the bridge was actually held, rather than that it happened
 * to be slow.
 */
export function readAuthPullsHeld(app: ElectronApplication): Promise<number> {
  return callGate(app, "pullsHeld");
}

/** Prove the push half is held without relying on when startup publishes auth. */
export function probeAuthPushSuppression(
  app: ElectronApplication
): Promise<number> {
  return callGate(app, "probePushSuppression");
}

/**
 * Let the auth bridge resolve: stop dropping pushes and answer every parked
 * pull with the REAL handler's answer. Resolves with how many pulls were
 * released.
 *
 * Called by the spec once it has observed the consequence it is asserting on,
 * so the hold ends on a signal rather than on a timer — the deadline elapsing is
 * the behavior under test, not something this helper may sleep through.
 */
export function releaseDesktopAuthState(
  app: ElectronApplication
): Promise<number> {
  return callGate(app, "release");
}
