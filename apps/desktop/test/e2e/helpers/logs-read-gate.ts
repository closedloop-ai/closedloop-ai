/**
 * Spec-side controls for the gateway-log read gate (ISS-7593).
 *
 * The gate itself is a main-process `-r` preload — see
 * `logs-read-gate-preload.cjs` for WHY the seam is there and what it does and
 * does not substitute. This module is the half the spec talks to.
 *
 * Deliberately electron-free and `@repo/*`-free, for the same reason
 * `local-session-source-gate.ts` is: an extension-less `@repo/*` subpath does
 * not resolve under Playwright's ESM loader, and importing one from a spec
 * aborts the WHOLE desktop-e2e suite at load time with no failing test name to
 * point at it.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The global the preload publishes its state on, in the MAIN process. */
const GATE_KEY = "__clE2eLogsReadGate";

const GATE_MISSING = "the logs read gate preload was never installed";

/** One row as `toLogEntries` in LogsPanel.tsx expects to receive it. */
export type E2eLogEntry = {
  timestamp: string;
  level: string;
  tag: string;
  message: string;
};

/** The Electron switches that install the gate, or nothing when unasked. */
export function logsReadGateLaunchArgs(enabled: boolean): string[] {
  return enabled
    ? ["-r", path.join(__dirname, "logs-read-gate-preload.cjs")]
    : [];
}

/** The env the preload reads, or nothing when no spec asked for the gate. */
export function logsReadGateEnv(enabled: boolean): Record<string, string> {
  return enabled ? { CL_E2E_LOGS_READ_GATE: "1" } : {};
}

/** The rows every log read answers with until this is called again. */
export function setLogsPayload(
  app: ElectronApplication,
  entries: E2eLogEntry[]
): Promise<void> {
  return app.evaluate(
    (_electron, { key, rows, missing }) => {
      const gate: { setPayload: (value: unknown[]) => void } | undefined =
        Reflect.get(globalThis, key);
      if (!gate) {
        throw new Error(missing);
      }
      gate.setPayload(rows);
    },
    { key: GATE_KEY, missing: GATE_MISSING, rows: entries }
  );
}

/** Park every subsequent log read until {@link releaseLogsReads}. */
export function holdLogsReads(app: ElectronApplication): Promise<void> {
  return app.evaluate(
    (_electron, { key, missing }) => {
      const gate: { hold: () => void } | undefined = Reflect.get(
        globalThis,
        key
      );
      if (!gate) {
        throw new Error(missing);
      }
      gate.hold();
    },
    { key: GATE_KEY, missing: GATE_MISSING }
  );
}

/** How many log reads are parked right now. */
export function pendingLogsReads(app: ElectronApplication): Promise<number> {
  return app.evaluate(
    (_electron, { key, missing }) => {
      const gate: { pendingCount: () => number } | undefined = Reflect.get(
        globalThis,
        key
      );
      if (!gate) {
        throw new Error(missing);
      }
      return gate.pendingCount();
    },
    { key: GATE_KEY, missing: GATE_MISSING }
  );
}

/**
 * Answer every parked read with `entries`; resolves with how many there were.
 *
 * That count is asserted rather than discarded: a zero would mean no read was
 * ever in flight, so the "never rendered" assertion after it would prove
 * nothing about the guard.
 */
export function releaseLogsReads(
  app: ElectronApplication,
  entries: E2eLogEntry[]
): Promise<number> {
  return app.evaluate(
    (_electron, { key, rows, missing }) => {
      const gate: { release: (value: unknown[]) => number } | undefined =
        Reflect.get(globalThis, key);
      if (!gate) {
        throw new Error(missing);
      }
      return gate.release(rows);
    },
    { key: GATE_KEY, missing: GATE_MISSING, rows: entries }
  );
}
