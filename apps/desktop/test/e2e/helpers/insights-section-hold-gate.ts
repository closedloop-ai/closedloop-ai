/**
 * Spec-side controls for the local insights section HOLD gate (ISS-12110).
 *
 * The gate itself is a main-process `-r` preload — see
 * `insights-section-hold-gate-preload.cjs` for why the seam is there and what
 * it substitutes. This module is the half the spec talks to: the launch
 * switches that install it, and the `ElectronApplication.evaluate` calls that
 * read and release it.
 *
 * Deliberately electron-free and `@repo/*`-free, for the same reason
 * `insights-read-failure-gate.ts` is: an extension-less `@repo/*` subpath does
 * not resolve under Playwright's ESM loader, and importing one here would abort
 * the WHOLE desktop-e2e suite at load time. The spec passes the section in.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The global the preload publishes its state on, in the MAIN process. */
const GATE_KEY = "__clE2eInsightsSectionHoldGate";

export type InsightsSectionHoldStats = {
  /** Reads of the held section parked so far, released or not. */
  held: number;
  /** Reads still parked right now. */
  parked: number;
};

/** The Electron switches that install the gate, or nothing when unasked. */
export function insightsSectionHoldGateLaunchArgs(
  section: string | undefined
): string[] {
  return section
    ? ["-r", path.join(__dirname, "insights-section-hold-gate-preload.cjs")]
    : [];
}

/** The env naming the section to hold, or nothing when unasked. */
export function insightsSectionHoldGateEnv(
  section: string | undefined
): Record<string, string> {
  return section ? { CL_E2E_INSIGHTS_HOLD_SECTION: section } : {};
}

/** The gate's counters, without changing its state. */
export function readInsightsSectionHold(
  app: ElectronApplication
): Promise<InsightsSectionHoldStats> {
  return callGate(app, "stats");
}

/**
 * Let every parked read through and stop holding. Resolves with the counters
 * from just after the release, so a caller can prove reads had been held.
 */
export function releaseInsightsSectionHold(
  app: ElectronApplication
): Promise<InsightsSectionHoldStats> {
  return callGate(app, "release");
}

/**
 * One `evaluate` over an operation name rather than one per accessor, because
 * the body cannot close over anything in this file (Playwright serializes it).
 */
function callGate(
  app: ElectronApplication,
  operation: "release" | "stats"
): Promise<InsightsSectionHoldStats> {
  return app.evaluate(
    (_electron, request) => {
      const gate:
        | {
            release: () => InsightsSectionHoldStats;
            stats: () => InsightsSectionHoldStats;
          }
        | undefined = Reflect.get(globalThis, request.key);
      if (!gate) {
        throw new Error(
          "the insights section hold gate preload was never installed"
        );
      }
      return request.operation === "release" ? gate.release() : gate.stats();
    },
    { key: GATE_KEY, operation }
  );
}
