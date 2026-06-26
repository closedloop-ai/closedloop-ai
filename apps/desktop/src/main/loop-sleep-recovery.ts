import electron from "electron";
import { gatewayLog } from "./gateway-logger.js";
import { createStubJobStore } from "./job-store.js";
import { sendHeartbeatNow } from "./loop-heartbeat.js";
import type { LoopSchedulerDeps } from "./loop-lifecycle.js";
import { refreshLoopTokenSingleflight } from "./loop-refresh.js";

// Extract powerMonitor via default import so the module loads correctly in
// both Electron (runtime) and Node.js (tests). Named imports from "electron"
// fail outside the Electron process because the CJS shim exports only a default.
const { powerMonitor } = electron;

// ---------------------------------------------------------------------------
// Module-scoped registry: loopId -> deps
// ---------------------------------------------------------------------------

const registry = new Map<string, LoopSchedulerDeps>();
let initialized = false;

// ---------------------------------------------------------------------------
// Internal: handle a single loop on resume (fire-and-forget)
// ---------------------------------------------------------------------------

async function handleResumeForLoop(
  loopId: string,
  deps: LoopSchedulerDeps
): Promise<void> {
  const { apiBaseUrl, getToken, loopTokenStore } = deps;

  // Trigger an immediate token refresh via the singleflight primitive so that
  // concurrent resume handlers for the same loop coalesce into one network call.
  try {
    const result = await refreshLoopTokenSingleflight(
      loopId,
      apiBaseUrl,
      getToken,
      loopTokenStore
    );
    if (result.success) {
      gatewayLog.info(
        "loop-sleep-recovery",
        `Token refreshed after resume for loopId=${loopId}`
      );
    } else {
      gatewayLog.warn(
        "loop-sleep-recovery",
        `Token refresh after resume failed for loopId=${loopId}: ${result.error}`
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    gatewayLog.error(
      "loop-sleep-recovery",
      `Unexpected error refreshing token after resume for loopId=${loopId}: ${message}`
    );
  }

  // Trigger an immediate heartbeat via the heartbeat module's public API.
  // sendHeartbeatNow is fire-and-forget and handles errors internally; errors
  // are logged by the heartbeat module, so no additional try/catch is needed.
  //
  // Sleep recovery does not own a jobStore or finalizer — those belong to the
  // dedicated heartbeat scheduler that runs alongside. Provide a stub jobStore
  // whose getByLoopId always returns undefined so runHeartbeatTick skips
  // finalization on a terminal signal. sendHeartbeatNow suppresses the 404-gate
  // side effect for exactly this reason: if this one-shot heartbeat tripped the
  // process-wide gate, the real heartbeat scheduler's next tick would skip the
  // round trip and never finalize. With the gate left open, that scheduler
  // still observes the terminal signal and finalizes the job.
  //
  // loopTokenStore is threaded through so that if the server revives the loop
  // on this resume heartbeat, the fresh runner token is adopted into the store
  // the owning scheduler reads from.
  // PoP fields and getTokenMeta are threaded through from the registered
  // LoopSchedulerDeps so the sleep-recovery heartbeat attaches PoP headers and
  // uses the managed-key fallback path when the runner JWT is stale.
  sendHeartbeatNow(loopId, {
    apiBaseUrl,
    getToken,
    loopTokenStore,
    getApiKey: deps.getApiKey,
    getApiKeyProvenance: deps.getApiKeyProvenance,
    signDesktopRequest: deps.signDesktopRequest,
    onDesktopPopUnavailable: deps.onDesktopPopUnavailable,
    getTokenMeta:
      loopTokenStore === undefined
        ? undefined
        : () => loopTokenStore.getLoopToken(loopId),
    jobStore: createStubJobStore(),
    finalizeFn: async () => {},
  });
}

// ---------------------------------------------------------------------------
// Internal: handle the system resume event
// ---------------------------------------------------------------------------

/**
 * Handles the system resume event. Exported for unit testing only — callers
 * outside of tests must use `init()` which registers this as a powerMonitor
 * listener.
 *
 * @internal
 */
export function onResume(): void {
  const activeLoopIds = [...registry.keys()];

  if (activeLoopIds.length === 0) {
    gatewayLog.info(
      "loop-sleep-recovery",
      "System resumed; no active loops to recover"
    );
    return;
  }

  gatewayLog.info(
    "loop-sleep-recovery",
    `System resumed; triggering refresh and heartbeat for ${activeLoopIds.length} active loop(s)`
  );

  for (const loopId of activeLoopIds) {
    const deps = registry.get(loopId);
    if (deps === undefined) {
      // Unregistered between iteration start and now — skip.
      continue;
    }
    // Fire-and-forget: log errors inside handleResumeForLoop but never throw.
    void handleResumeForLoop(loopId, deps);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initializes the sleep/wake recovery listener.
 *
 * Subscribes to Electron's `powerMonitor` `resume` event so that all
 * registered active loops immediately refresh their tokens and send a
 * heartbeat when the system wakes from sleep.
 *
 * Idempotent: subsequent calls are no-ops. (Note: `powerMonitor` is an
 * `EventEmitter` and does not deduplicate identical listener instances —
 * without this guard a second `init()` call would double-register `onResume`
 * and cause duplicate token-refresh attempts on every resume.)
 */
export function init(): void {
  if (initialized) {
    return;
  }
  initialized = true;
  powerMonitor?.on("resume", onResume);
  gatewayLog.info(
    "loop-sleep-recovery",
    "Sleep/wake recovery listener registered"
  );
}

/** Resets module-level state. For unit tests only. */
export function resetForTesting(): void {
  initialized = false;
  registry.clear();
}

/**
 * Registers a loop so it participates in sleep/wake recovery.
 *
 * When the system resumes from sleep, the recovery module will:
 * 1. Trigger an immediate token refresh via `refreshLoopTokenSingleflight`.
 * 2. Issue an immediate heartbeat POST via `sendHeartbeatNow`.
 *
 * Calling `registerLoop` for a loop that is already registered replaces its
 * deps (useful if the API URL changes after initial registration).
 */
export function registerLoop(loopId: string, deps: LoopSchedulerDeps): void {
  registry.set(loopId, deps);
  gatewayLog.info(
    "loop-sleep-recovery",
    `Registered loopId=${loopId} for sleep/wake recovery`
  );
}

/**
 * Unregisters a loop from sleep/wake recovery.
 * A no-op if the loop is not registered.
 */
export function unregisterLoop(loopId: string): void {
  if (!registry.has(loopId)) {
    return;
  }
  registry.delete(loopId);
  gatewayLog.info(
    "loop-sleep-recovery",
    `Unregistered loopId=${loopId} from sleep/wake recovery`
  );
}
