/**
 * Spec-side controls for the gateway listen gate (ISS-10291).
 *
 * The gate itself is a main-process `-r` preload — see
 * `gateway-listen-gate-preload.cjs` for WHY the seam is there and what it does
 * and does not substitute. This module is the half the spec talks to.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication } from "@playwright/test";
import { E2E_EPHEMERAL_LOOPBACK_PORTS_ARG } from "../../../src/main/lifecycle/loopback-port-isolation.js";
import { PORT_PROBE_ORDER } from "../../../src/shared/contracts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The global the preload publishes its state on, in the MAIN process. */
const GATE_KEY = "__clE2eGatewayListenGate";

const GATE_MISSING = "the gateway listen gate preload was never installed";

/** Installs the shared test-only gateway bind and discovery policy. */
export function gatewayListenGateLaunchArgs(): string[] {
  return ["-r", path.join(__dirname, "gateway-listen-gate-preload.cjs")];
}

/** Uses existing gate metadata to isolate this caller-owned profile. */
export function gatewayListenGateEnv(
  enabled: boolean,
  userDataDir: string
): Record<string, string> {
  return {
    CL_E2E_GATEWAY_LISTEN_GATE_PORTS: JSON.stringify({
      ports: PORT_PROBE_ORDER,
      held: enabled,
      ephemeralLoopbackPortsArg: E2E_EPHEMERAL_LOOPBACK_PORTS_ARG,
      userDataDir,
    }),
  };
}

/** How many gateway listens are parked right now. */
export function parkedGatewayListens(
  app: ElectronApplication
): Promise<number> {
  return app.evaluate(
    (_electron, { key, missing }) => {
      const gate: { parkedCount: () => number } | undefined = Reflect.get(
        globalThis,
        key
      );
      if (!gate) {
        throw new Error(missing);
      }
      return gate.parkedCount();
    },
    { key: GATE_KEY, missing: GATE_MISSING }
  );
}

/** Let boot bind the gateway; resolves with how many listens were parked. */
export function releaseGatewayListen(
  app: ElectronApplication
): Promise<number> {
  return app.evaluate(
    (_electron, { key, missing }) => {
      const gate: { release: () => number } | undefined = Reflect.get(
        globalThis,
        key
      );
      if (!gate) {
        throw new Error(missing);
      }
      return gate.release();
    },
    { key: GATE_KEY, missing: GATE_MISSING }
  );
}
