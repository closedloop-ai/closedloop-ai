/**
 * Spec-side controls for the docs-help getPage/search failure gate (ISS-10366).
 *
 * The gate itself is a main-process `-r` preload — see
 * `docs-help-failure-gate-preload.cjs` for WHY the seam is there and what it
 * substitutes. This module is the half the spec talks to: the launch switches
 * that install it, and the `ElectronApplication.evaluate` calls that arm, disarm
 * and read it.
 *
 * Deliberately electron-free and `@repo/*`-free, for the same reason
 * `sessions-list-failure-gate.ts` is: an extension-less `@repo/*` subpath does
 * not resolve under Playwright's ESM loader, and importing one from a spec aborts
 * the WHOLE desktop-e2e suite at load time with no failing test name to point
 * at it.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The global the preload publishes its state on, in the MAIN process. */
const GATE_KEY = "__clE2eDocsHelpFailureGate";

/**
 * Which read a call arms or reports on. Named per channel because the two cases
 * are different claims: the Help reader case fails only `getPage`, the palette
 * case only `search`.
 */
export const DocsHelpFailureOperation = {
  GetPage: "getPage",
  Search: "search",
} as const;

export type DocsHelpFailureOperation =
  (typeof DocsHelpFailureOperation)[keyof typeof DocsHelpFailureOperation];

/** The Electron switches that install the gate, or nothing when unasked. */
export function docsHelpFailureGateLaunchArgs(enabled: boolean): string[] {
  return enabled
    ? ["-r", path.join(__dirname, "docs-help-failure-gate-preload.cjs")]
    : [];
}

/** The env the preload reads, or nothing when no spec asked for the gate. */
export function docsHelpFailureGateEnv(
  enabled: boolean
): Record<string, string> {
  return enabled ? { CL_E2E_DOCS_HELP_FAILURE_GATE: "1" } : {};
}

export type DocsHelpFailureGateStats = {
  failed: number;
  succeeded: number;
};

type GateAction = "arm" | "disarm" | "stats";

/**
 * Run one gate action in the MAIN process. Written as a single `evaluate` over an
 * action name rather than one per accessor, because the body cannot close over
 * anything in this file (Playwright serializes it).
 */
function callGate(
  app: ElectronApplication,
  action: GateAction,
  operation: DocsHelpFailureOperation
): Promise<DocsHelpFailureGateStats> {
  return app.evaluate(
    (_electron, request) => {
      const gate:
        | {
            arm: (operation: string) => void;
            disarm: (operation: string) => void;
            stats: (operation: string) => {
              failed: number;
              succeeded: number;
            };
          }
        | undefined = Reflect.get(globalThis, request.key);
      if (!gate) {
        throw new Error(
          "the docs-help failure gate preload was never installed"
        );
      }
      if (request.action === "arm") {
        gate.arm(request.operation);
      }
      if (request.action === "disarm") {
        gate.disarm(request.operation);
      }
      return gate.stats(request.operation);
    },
    { action, key: GATE_KEY, operation }
  );
}

/**
 * Start rejecting this read. Resolves with the counters at the moment of arming,
 * so a caller can prove a read had already SUCCEEDED first — without that, the
 * failure state is indistinguishable from a surface that never worked.
 */
export function armDocsHelpFailure(
  app: ElectronApplication,
  operation: DocsHelpFailureOperation
): Promise<DocsHelpFailureGateStats> {
  return callGate(app, "arm", operation);
}

/**
 * Let the real handler answer again. The recovery half of the proof: a retry that
 * goes green only after this call is a retry that re-crossed IPC, and it shows
 * the failure state was the gate's doing rather than the app's.
 */
export function disarmDocsHelpFailure(
  app: ElectronApplication,
  operation: DocsHelpFailureOperation
): Promise<DocsHelpFailureGateStats> {
  return callGate(app, "disarm", operation);
}

/**
 * The gate's success/failure counters, without changing its state.
 *
 * Counted per CHANNEL, not per surface: every `docsHelp.search` in the main
 * process advances the same pair. A case driving two searching surfaces at once
 * cannot read either one off this number.
 */
export function readDocsHelpFailureGateStats(
  app: ElectronApplication,
  operation: DocsHelpFailureOperation
): Promise<DocsHelpFailureGateStats> {
  return callGate(app, "stats", operation);
}
