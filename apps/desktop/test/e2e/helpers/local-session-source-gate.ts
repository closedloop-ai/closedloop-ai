/**
 * Spec-side controls for the local session-source gate (ISS-6002).
 *
 * The gate itself is a main-process `-r` preload — see
 * `local-session-source-gate-preload.cjs` for WHY the seam is here and what it
 * does and does not substitute. This module is the half the spec talks to: the
 * launch switches that install it, and the `ElectronApplication.evaluate` that
 * lets the real source through.
 *
 * Deliberately electron-free and `@repo/*`-free, for the same reason
 * `sessions-page-data-gate.ts` is: an extension-less `@repo/*` subpath does not
 * resolve under Playwright's ESM loader, and importing one from a spec aborts
 * the WHOLE desktop-e2e suite at load time with no failing test name to point
 * at it.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The global the preload publishes its state on, in the MAIN process. */
const GATE_KEY = "__clE2eLocalSessionSourceGate";

/** The Electron switches that install the gate, or nothing when unasked. */
export function localSessionSourceGateLaunchArgs(enabled: boolean): string[] {
  return enabled
    ? ["-r", path.join(__dirname, "local-session-source-gate-preload.cjs")]
    : [];
}

/** The env the preload reads, or nothing when no spec asked for the gate. */
export function localSessionSourceGateEnv(
  enabled: boolean
): Record<string, string> {
  return enabled ? { CL_E2E_LOCAL_SESSION_SOURCE_GATE: "1" } : {};
}

/**
 * Stop holding the source down; resolves with how many probes were answered
 * while it was held.
 *
 * That count is asserted rather than discarded: a zero would mean the renderer
 * never polled the source at all, so the "did not claim an empty install"
 * assertion before it proved nothing about the gate.
 */
export function releaseLocalSessionSource(
  app: ElectronApplication
): Promise<number> {
  return app.evaluate((_electron, key) => {
    const gate: { release: () => number } | undefined = Reflect.get(
      globalThis,
      key
    );
    if (!gate) {
      throw new Error(
        "the local session-source gate preload was never installed"
      );
    }
    return gate.release();
  }, GATE_KEY);
}
