import { useEffect, useState } from "react";
import type { CloudSyncProgress } from "./use-cloud-sync-progress";
import type { FileAccessBlock } from "./use-file-access-blocks";
import type { IngestProgress } from "./use-ingest-progress";

const INGEST_POLL_MS = 1000;

/**
 * The subset of the desktop runtime-status payload the renderer's status hooks
 * project. The `desktopApi` IPC boundary is typed `Promise<unknown>`
 * (`desktop-api.d.ts`), so the shape is asserted once, here. The payload is our
 * own main-process output (`app.ts` → `desktop:get-runtime-status`), shipped in
 * the same package as this renderer, so its field shapes are trusted rather than
 * re-validated field by field. The one guard is against a missing payload
 * (before the first poll resolves), which degrades each projection to `null`.
 */
type RuntimeStatusPayload = {
  ingest?: IngestProgress | null;
  // ISS-6241: `unknown` at the boundary, not the trusted shape — it is validated
  // field by field in `parseMaintenanceProgress` now that it carries the counts
  // the Compute step renders.
  maintenance?: unknown;
  cloudStatus?: unknown;
  cloudSync?: CloudSyncProgress | null;
  // ISS-5768: the whole-app, all-lanes backlog. `unknown` at the boundary, not
  // the trusted shape (whitlockk review): it is validated field by field in
  // `parseCloudReadReadinessBacklog`, because a partial or version-skewed object
  // reaching `resolveCloudSyncBacklog` threw inside the shared poll's fan-out
  // loop and starved every listener behind it. Absent or invalid degrades to an
  // `unknown` backlog, which renders as "Checking…" and never as "Up to date".
  cloudReadReadiness?: unknown;
  fileAccessBlocks?: FileAccessBlock[] | null;
  // ISS-4714: validated element-by-element in `parseAgentMonitorStatus`, so this
  // is `unknown` at the boundary rather than the trusted shape (an older main
  // process omits it; a malformed/future `kind` must degrade, not throw).
  agentMonitor?: unknown;
  // ISS-11426: the compute-target link block. `unknown` at the boundary and
  // validated field by field in `parseComputeTargetLinkBlock`, for the same
  // reason `cloudReadReadiness` is: a shape this build cannot read must degrade
  // to "not blocked" rather than render an alert built from `undefined`.
  computeTargetLinkBlock?: unknown;
};

export function readRuntimeStatus(status: unknown): RuntimeStatusPayload {
  return typeof status === "object" && status !== null
    ? (status as RuntimeStatusPayload)
    : {};
}

// FEA-2264: a single shared poll of the main-process runtime status. Every
// status-derived hook subscribes to this one poller, so a component that mounts
// several of them (the first-launch banner reads both ingest and maintenance)
// makes one getRuntimeStatus IPC round-trip per interval instead of one per
// hook. The interval starts on the first subscriber and stops once the last one
// leaves, so it never polls while nothing is watching.
type RuntimeStatusListener = (status: unknown) => void;
const runtimeStatusListeners = new Set<RuntimeStatusListener>();
let runtimeStatusInterval: number | null = null;
let lastRuntimeStatus: unknown;
let hasRuntimeStatus = false;

function emitRuntimeStatus(status: unknown): void {
  lastRuntimeStatus = status;
  hasRuntimeStatus = true;
  for (const listener of runtimeStatusListeners) {
    listener(status);
  }
}

function pollRuntimeStatusOnce(): void {
  // Defensive optional-chaining at the single call site: `desktopApi` — and the
  // `getRuntimeStatus` method itself — is typed non-optional but can be absent
  // in test/SSR contexts or on an older preload (version skew). Guarding the
  // method call keeps a missing method from throwing synchronously and taking
  // down every status-derived hook subscribed to this shared poll.
  const pending = window.desktopApi?.getRuntimeStatus?.();
  pending?.then(emitRuntimeStatus).catch(() => undefined);
}

function subscribeRuntimeStatus(listener: RuntimeStatusListener): () => void {
  runtimeStatusListeners.add(listener);
  // Replay the latest status so a late subscriber paints immediately rather
  // than waiting a full interval for the next poll.
  if (hasRuntimeStatus) {
    listener(lastRuntimeStatus);
  }
  if (runtimeStatusInterval === null) {
    pollRuntimeStatusOnce();
    runtimeStatusInterval = window.setInterval(
      pollRuntimeStatusOnce,
      INGEST_POLL_MS
    );
  }
  return () => {
    runtimeStatusListeners.delete(listener);
    if (runtimeStatusListeners.size === 0 && runtimeStatusInterval !== null) {
      window.clearInterval(runtimeStatusInterval);
      runtimeStatusInterval = null;
    }
  };
}

/**
 * Subscribe to the shared runtime-status poll and project each payload through
 * `parse` while `active`. Returns null until the first response. `parse` must be
 * a stable reference (a module-level parser), since it participates in the
 * effect dependencies.
 */
export function useRuntimeStatusValue<T>(
  active: boolean,
  parse: (status: unknown) => T | null
): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    if (!active) {
      return;
    }
    let cancelled = false;
    const unsubscribe = subscribeRuntimeStatus((status) => {
      if (!cancelled) {
        setValue(parse(status));
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [active, parse]);
  return value;
}

/**
 * Test-only: reset the module-level shared runtime-status poll (listeners,
 * interval, and the replayed last-status cache). Vitest reuses one module
 * instance across a file's tests, so without this a component mounted in a later
 * test synchronously receives the PREVIOUS test's cached status on subscribe —
 * which a latching consumer (e.g. `useTerminalAgentMonitorStatus`) would then
 * settle on before the fresh poll resolves. Call from `afterEach` (after
 * unmounting) so each test starts from a clean poll.
 */
export function __resetRuntimeStatusPollForTests(): void {
  runtimeStatusListeners.clear();
  if (runtimeStatusInterval !== null) {
    globalThis.clearInterval(runtimeStatusInterval);
    runtimeStatusInterval = null;
  }
  lastRuntimeStatus = undefined;
  hasRuntimeStatus = false;
}
