/**
 * Spec-side controls for the Sessions `pageData` IPC gate (ISS-4561).
 *
 * The gate itself is a main-process `-r` preload — see
 * `sessions-page-data-gate-preload.cjs` for WHY the seam is here and what it does
 * and does not substitute. This module is the half the spec talks to: the launch
 * switches that install it, and the `ElectronApplication.evaluate` calls that read
 * its counter and let held responses go.
 *
 * Deliberately electron-free and `@repo/*`-free, for the same reason `summary-strip.ts`
 * is: an extension-less `@repo/*` subpath does not resolve under Playwright's ESM
 * loader, and importing one from a spec aborts the WHOLE desktop-e2e suite at load
 * time with no failing test name to point at it.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectronApplication } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The global the preload publishes its state on, in the MAIN process. */
const GATE_KEY = "__clE2eSessionsPageDataGate";

/** What the preload publishes on that global, in the main process. */
type SessionsPageDataGate = {
  dispatched: number;
  settled: number;
  arm: () => number;
  release: () => number;
};

/**
 * `MAX_TRANSIENT_QUERY_RETRIES` (`@repo/app/shared/query/query-client`), pinned as a
 * LITERAL rather than imported — see the module note above for why a `@repo/*` import
 * cannot appear in this suite.
 *
 * Drift fails LOUDLY rather than silently: the spec releases `this - 1` recovery
 * attempts and then holds the next one, so a cap that grew would leave the recovery
 * unexhausted after the final release and the settlement assertion would time out.
 * The unit twin (`use-usage-transient-recovery.test.ts`) imports the real constant.
 */
export const MAX_TRANSIENT_RECOVERY_ATTEMPTS = 2;

/**
 * `queryRetryDelay(MAX_TRANSIENT_RECOVERY_ATTEMPTS - 1)` — the LONGEST backoff the
 * recovery hook waits before dispatching an attempt (1s, then 2s). Pinned for the same
 * reason as the cap above.
 */
const LONGEST_RECOVERY_BACKOFF_MS = 2000;

/**
 * How long the gate's counter must stay UNCHANGED before the held invocation is
 * treated as the recovery hook's next attempt. Comfortably past the longest backoff:
 * the hook dispatches within that window of the previous attempt settling, and once its
 * attempt is held nothing else can reach the handler (the poll dedupes onto the
 * in-flight fetch), so the counter is stable from then on.
 */
const QUIESCENT_MS = LONGEST_RECOVERY_BACKOFF_MS + 2500;

const SAMPLE_INTERVAL_MS = 250;
const ATTEMPT_WAIT_TIMEOUT_MS = 60_000;

/** The Electron switches that install the gate, or nothing when a spec did not ask. */
export function sessionsPageDataGateLaunchArgs(enabled: boolean): string[] {
  return enabled
    ? ["-r", path.join(__dirname, "sessions-page-data-gate-preload.cjs")]
    : [];
}

/** The env the preload reads, or nothing when no spec asked for the gate. */
export function sessionsPageDataGateEnv(
  enabled: boolean
): Record<string, string> {
  return enabled ? { CL_E2E_SESSIONS_PAGE_DATA_GATE: "1" } : {};
}

/** The gate operations the spec can drive from the test process. */
type GateOperation = "arm" | "dispatched" | "release" | "settled";

/**
 * Run one gate operation in the MAIN process. Written as a single `evaluate` over an
 * operation name rather than one `evaluate` per accessor, because the body cannot close
 * over anything in this file (Playwright serializes it) — so four accessors would be four
 * copies of the same lookup-and-guard.
 */
function callGate(
  app: ElectronApplication,
  operation: GateOperation
): Promise<number> {
  return app.evaluate(
    (_electron, request) => {
      const gate: SessionsPageDataGate | undefined = Reflect.get(
        globalThis,
        request.key
      );
      if (!gate) {
        throw new Error(
          "the Sessions pageData gate preload was never installed"
        );
      }
      if (request.operation === "arm") {
        return gate.arm();
      }
      if (request.operation === "release") {
        return gate.release();
      }
      return request.operation === "settled" ? gate.settled : gate.dispatched;
    },
    { key: GATE_KEY, operation }
  );
}

/**
 * Start failing the usage half transiently, and hold every response after the one
 * that opens that window. Resolves with the `settled` count the gate will have
 * reached once that opening response has been answered — poll
 * {@link readGateSettledCount} for it to know the window is open.
 */
export function armSessionsUsageFailure(
  app: ElectronApplication
): Promise<number> {
  return callGate(app, "arm");
}

/** How many `pageData` invocations the gate has ANSWERED since launch. */
export function readGateSettledCount(
  app: ElectronApplication
): Promise<number> {
  return callGate(app, "settled");
}

/** How many `pageData` invocations the gate has SEEN since launch. */
export function readGateDispatchCount(
  app: ElectronApplication
): Promise<number> {
  return callGate(app, "dispatched");
}

/** Answer every response the gate is currently holding; resolves with how many. */
export function releaseHeldPageDataReads(
  app: ElectronApplication
): Promise<number> {
  return callGate(app, "release");
}

/**
 * Wait until the recovery hook's NEXT attempt is dispatched and held.
 *
 * Settle-detection, not a sleep-then-assert: it returns as soon as the counter has
 * moved past `after` AND then stayed put for longer than the longest backoff. That
 * combination is what identifies the held invocation as the hook's attempt — React
 * Query's 2s `refetchInterval` poll cannot reach the handler while a fetch is in
 * flight (it dedupes), while the hook's `refetch({ cancelRefetch: true })` always
 * starts a new one, so a quiet gate with something held means the hook has dispatched.
 *
 * Mis-identification cannot pass silently either way: releasing something that is NOT
 * the final attempt leaves the recovery unexhausted, and the caller's settlement
 * assertion fails.
 */
export async function waitForHeldRecoveryAttempt(
  app: ElectronApplication,
  after: number
): Promise<number> {
  const deadline = Date.now() + ATTEMPT_WAIT_TIMEOUT_MS;
  let observed = -1;
  let unchangedSince = Date.now();
  while (Date.now() < deadline) {
    const dispatched = await readGateDispatchCount(app);
    if (dispatched === observed) {
      if (dispatched > after && Date.now() - unchangedSince >= QUIESCENT_MS) {
        return dispatched;
      }
    } else {
      observed = dispatched;
      unchangedSince = Date.now();
    }
    await new Promise((resolve) => {
      setTimeout(resolve, SAMPLE_INTERVAL_MS);
    });
  }
  throw new Error(
    `the usage recovery never dispatched an attempt past #${after} (gate saw ${observed})`
  );
}
