/**
 * Spec-side controls for the GitHub connect leg gate (ISS-10411).
 *
 * The gate itself is a main-process `-r` preload — see
 * `github-connect-leg-gate-preload.cjs` for WHY the seam is there and what it
 * substitutes. This module is the half the spec talks to: the launch switches
 * that install it, and the `ElectronApplication.evaluate` calls that read its
 * counters.
 *
 * Deliberately electron-free and `@repo/*`-free, for the same reason
 * `desktop-auth-state-gate.ts` is: an extension-less `@repo/*` subpath does not
 * resolve under Playwright's ESM loader, and importing one from a spec aborts
 * the WHOLE desktop-e2e suite at load time with no failing test name to point
 * at it (`apps/desktop/test/AGENTS.md`).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The global the preload publishes its counters on, in the MAIN process. */
const GATE_KEY = "__clE2eGitHubConnectLegGate";

/** The Electron switches that install the gate, or nothing when unasked. */
export function githubConnectLegGateLaunchArgs(enabled: boolean): string[] {
  return enabled
    ? ["-r", path.join(__dirname, "github-connect-leg-gate-preload.cjs")]
    : [];
}

/** The env the preload reads, or nothing when no spec asked for the gate. */
export function githubConnectLegGateEnv(
  enabled: boolean
): Record<string, string> {
  return enabled ? { CL_E2E_GITHUB_CONNECT_LEG_GATE: "1" } : {};
}

/** The counters a spec can read from the test process. */
type GitHubConnectLegCounter = "signInsRejected" | "connectsReached";

/**
 * Read one gate counter in the MAIN process. One `evaluate` over a counter name
 * rather than one per accessor, because the body cannot close over anything in
 * this file (Playwright serializes it).
 */
export function readGitHubConnectLegCounter(
  app: ElectronApplication,
  counter: GitHubConnectLegCounter
): Promise<number> {
  return app.evaluate(
    (_electron, request) => {
      const gate: Record<string, number> | undefined = Reflect.get(
        globalThis,
        request.key
      );
      if (!gate) {
        throw new Error(
          "the GitHub connect leg gate preload was never installed"
        );
      }
      return gate[request.counter] ?? 0;
    },
    { counter, key: GATE_KEY }
  );
}
