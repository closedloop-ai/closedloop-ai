/**
 * Spec-side controls for the local insights read failure gate (ISS-10409).
 *
 * The gate itself is a main-process `-r` preload — see
 * `insights-read-failure-gate-preload.cjs` for WHY the seam is here, what it
 * substitutes, and why it fails from launch rather than waiting to be armed.
 * This module is the half the spec talks to: the launch switches that install
 * it, and the `ElectronApplication.evaluate` calls that release it and read its
 * counters.
 *
 * Deliberately electron-free and `@repo/*`-free, for the same reason
 * `sessions-list-failure-gate.ts` is: an extension-less `@repo/*` subpath does
 * not resolve under Playwright's ESM loader, and importing one from a spec
 * aborts the WHOLE desktop-e2e suite at load time with no failing test name to
 * point at it.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The global the preload publishes its state on, in the MAIN process. */
const GATE_KEY = "__clE2eInsightsReadFailureGate";

/** The Electron switches that install the gate, or nothing when unasked. */
export function insightsReadFailureGateLaunchArgs(enabled: boolean): string[] {
  return enabled
    ? ["-r", path.join(__dirname, "insights-read-failure-gate-preload.cjs")]
    : [];
}

/** The env the preload reads, or nothing when no spec asked for the gate. */
export function insightsReadFailureGateEnv(
  enabled: boolean
): Record<string, string> {
  return enabled ? { CL_E2E_INSIGHTS_READ_FAILURE_GATE: "1" } : {};
}

export type InsightsReadFailureGateStats = {
  failed: number;
  succeeded: number;
};

type GateOperation = "release" | "stats";

/**
 * Run one gate operation in the MAIN process. Written as a single `evaluate`
 * over an operation name rather than one per accessor, because the body cannot
 * close over anything in this file (Playwright serializes it).
 */
function callGate(
  app: ElectronApplication,
  operation: GateOperation
): Promise<InsightsReadFailureGateStats> {
  return app.evaluate(
    (_electron, request) => {
      const gate:
        | {
            release: () => number;
            stats: () => { failed: number; succeeded: number };
          }
        | undefined = Reflect.get(globalThis, request.key);
      if (!gate) {
        throw new Error(
          "the insights read failure gate preload was never installed"
        );
      }
      if (request.operation === "release") {
        gate.release();
      }
      return gate.stats();
    },
    { key: GATE_KEY, operation }
  );
}

/**
 * Hand the real insights read back. Resolves with the counters at the moment of
 * release, so a caller can prove the read had actually been FAILING first —
 * without that, a dashboard that never reached the error state would release
 * into a green second half and say nothing about the first.
 */
export function releaseInsightsRead(
  app: ElectronApplication
): Promise<InsightsReadFailureGateStats> {
  return callGate(app, "release");
}

/** The gate's success/failure counters, without changing its state. */
export function readInsightsReadFailureGateStats(
  app: ElectronApplication
): Promise<InsightsReadFailureGateStats> {
  return callGate(app, "stats");
}
