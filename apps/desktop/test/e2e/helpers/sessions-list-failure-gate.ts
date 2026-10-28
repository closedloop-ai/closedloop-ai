/**
 * Spec-side controls for the Sessions list failure gate (ISS-7661).
 *
 * The gate itself is a main-process `-r` preload — see
 * `sessions-list-failure-gate-preload.cjs` for WHY the seam is here, what it
 * substitutes, and why the injected failure is deliberately non-transient. This
 * module is the half the spec talks to: the launch switches that install it, and
 * the `ElectronApplication.evaluate` calls that arm it and read its counters.
 *
 * Deliberately electron-free and `@repo/*`-free, for the same reason
 * `sessions-page-data-gate.ts` is: an extension-less `@repo/*` subpath does not
 * resolve under Playwright's ESM loader, and importing one from a spec aborts the
 * WHOLE desktop-e2e suite at load time with no failing test name to point at it.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The global the preload publishes its state on, in the MAIN process. */
const GATE_KEY = "__clE2eSessionsListFailureGate";

/** The Electron switches that install the gate, or nothing when unasked. */
export function sessionsListFailureGateLaunchArgs(enabled: boolean): string[] {
  return enabled
    ? ["-r", path.join(__dirname, "sessions-list-failure-gate-preload.cjs")]
    : [];
}

/** The env the preload reads, or nothing when no spec asked for the gate. */
export function sessionsListFailureGateEnv(
  enabled: boolean
): Record<string, string> {
  return enabled ? { CL_E2E_SESSIONS_LIST_FAILURE_GATE: "1" } : {};
}

export type SessionsListFailureGateStats = {
  failed: number;
  succeeded: number;
};

type GateOperation = "arm" | "stats";

/**
 * Run one gate operation in the MAIN process. Written as a single `evaluate` over
 * an operation name rather than one per accessor, because the body cannot close
 * over anything in this file (Playwright serializes it).
 */
function callGate(
  app: ElectronApplication,
  operation: GateOperation
): Promise<SessionsListFailureGateStats> {
  return app.evaluate(
    (_electron, request) => {
      const gate:
        | {
            arm: () => number;
            stats: () => { failed: number; succeeded: number };
          }
        | undefined = Reflect.get(globalThis, request.key);
      if (!gate) {
        throw new Error(
          "the Sessions list failure gate preload was never installed"
        );
      }
      if (request.operation === "arm") {
        gate.arm();
      }
      return gate.stats();
    },
    { key: GATE_KEY, operation }
  );
}

/**
 * Start failing the Sessions `pageData` read. Resolves with the counters at the
 * moment of arming, so a caller can prove a read had already SUCCEEDED first —
 * without that, the failure would not be happening over held data at all.
 */
export function armSessionsListFailure(
  app: ElectronApplication
): Promise<SessionsListFailureGateStats> {
  return callGate(app, "arm");
}

/** The gate's success/failure counters, without changing its state. */
export function readSessionsListFailureGateStats(
  app: ElectronApplication
): Promise<SessionsListFailureGateStats> {
  return callGate(app, "stats");
}
