/**
 * Spec-side controls for the Agents `pageData` IPC gate (ISS-6141).
 *
 * The gate itself is a main-process `-r` preload — see
 * `agents-page-data-gate-preload.cjs` for WHY the seam is there and what it does
 * and does not substitute. This module is the half the spec talks to: the launch
 * switch that installs it, and the `ElectronApplication.evaluate` calls that read
 * what it recorded and let the held responses go.
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
const GATE_KEY = "__clE2eAgentsPageDataGate";

/** The fields of a recorded `pageData` request a spec may assert on. */
export type AgentsPageDataRequest = {
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortDir?: string;
};

/** What the preload publishes on that global, in the main process. */
type AgentsPageDataGate = {
  dispatched: number;
  settled: number;
  requests: unknown[];
  resume: () => number;
};

/** The Electron switches that install the gate, or nothing when a spec did not ask. */
export function agentsPageDataGateLaunchArgs(enabled: boolean): string[] {
  return enabled
    ? ["-r", path.join(__dirname, "agents-page-data-gate-preload.cjs")]
    : [];
}

/**
 * The request of every `pageData` invocation the gate has seen, in order. There
 * is no HTTP on this path, so this is the local analogue of reading
 * `page.route`'s request URLs.
 */
export function readAgentsPageDataRequests(
  app: ElectronApplication
): Promise<AgentsPageDataRequest[]> {
  return app.evaluate((_electron, key) => {
    const gate: AgentsPageDataGate | undefined = Reflect.get(globalThis, key);
    if (!gate) {
      throw new Error("the Agents pageData gate preload was never installed");
    }
    return gate.requests.map((entry) =>
      entry && typeof entry === "object" ? (entry as AgentsPageDataRequest) : {}
    );
  }, GATE_KEY);
}

/**
 * Answer everything held AND lift the hold, leaving the handler fully open.
 * Resolves with how many parked responses were let through.
 */
export function resumeAgentsPageDataReads(
  app: ElectronApplication
): Promise<number> {
  return app.evaluate((_electron, key) => {
    const gate: AgentsPageDataGate | undefined = Reflect.get(globalThis, key);
    if (!gate) {
      throw new Error("the Agents pageData gate preload was never installed");
    }
    return gate.resume();
  }, GATE_KEY);
}
