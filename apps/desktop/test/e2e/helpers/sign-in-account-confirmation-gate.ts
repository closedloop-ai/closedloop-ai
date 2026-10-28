/**
 * Spec-side controls for the sign-in account confirmation gate (ISS-11345).
 * The gate itself is a main-process `-r` preload — see
 * `sign-in-account-confirmation-gate-preload.cjs` for why and what it stands in
 * for. Electron-free and `@repo/*`-free, like `github-connect-leg-gate.ts`, so
 * it cannot abort the suite at load (`apps/desktop/test/AGENTS.md`).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GATE_KEY = "__clE2eSignInAccountConfirmationGate";

export function signInAccountConfirmationGateLaunchArgs(
  enabled: boolean
): string[] {
  return enabled
    ? [
        "-r",
        path.join(__dirname, "sign-in-account-confirmation-gate-preload.cjs"),
      ]
    : [];
}

export function signInAccountConfirmationGateEnv(
  enabled: boolean
): Record<string, string> {
  return enabled ? { CL_E2E_SIGN_IN_ACCOUNT_CONFIRMATION_GATE: "1" } : {};
}

type SignInAccountConfirmationCounter =
  | "confirmationsRequested"
  | "cancels"
  | "confirms";

export function readSignInAccountConfirmationCounter(
  app: ElectronApplication,
  counter: SignInAccountConfirmationCounter
): Promise<number> {
  return app.evaluate(
    (_electron, request) => {
      const gate: Record<string, number> | undefined = Reflect.get(
        globalThis,
        request.key
      );
      if (!gate) {
        throw new Error(
          "the sign-in account confirmation gate preload was never installed"
        );
      }
      return gate[request.counter] ?? 0;
    },
    { counter, key: GATE_KEY }
  );
}
