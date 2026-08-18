/**
 * @file usage-api-service.ts
 * @description PRD-538 R5 (ISS-5353). Schedules the owned `/usage` capture and
 * feeds the result into the shared session-limit snapshot store as the
 * AUTHORITATIVE `usage_api` source.
 *
 * ── Why this is a producer, not a second cache ────────────────────────────────
 * The snapshot store (FEA-3493) already holds one snapshot per source, already
 * reconciles them by freshness, and already stamps provenance for the renderer.
 * Adding a private cache here would create a second source of truth for the same
 * numbers. So this service owns only the SCHEDULE; the store owns the state, and
 * its per-source map is bounded by the source union (3 entries) rather than by
 * anything read off the wire.
 *
 * ── The four states, kept distinct ────────────────────────────────────────────
 *   - no credential      → nothing is ever recorded; the store has no
 *                          `usage_api` entry and the renderer hides the feature.
 *                          Never a zero, never an error.
 *   - not yet fetched    → same absence, before the first tick completes. The
 *                          first refresh is fired immediately on `start()` so
 *                          this window is short.
 *   - stale snapshot     → recorded WITH its `fetchedAt`; the store's staleness
 *                          rule decides whether it is still surfaced, and the
 *                          renderer labels it from that timestamp. A failed
 *                          refresh deliberately leaves the previous snapshot in
 *                          place rather than erasing it — losing a known-stale
 *                          reading in favor of nothing is strictly less
 *                          information.
 *   - genuinely 0% used  → a real snapshot with `utilization: 0`, recorded and
 *                          rendered like any other value.
 *
 * A capture failure NEVER throws out of the scheduled callback and never blocks
 * startup — `refreshNow` resolves a boolean and swallows nothing silently that a
 * caller needs.
 *
 * ── The Labs gate (PRD-538, default OFF) ──────────────────────────────────────
 * The whole feature sits behind the desktop Labs flag
 * `subscriptionSessionLimits`, and the gate lives HERE — at the capture — rather
 * than at the render, because this feature reads the user's OAuth credential and
 * calls an external endpoint. Not-product-approved must mean that behavior does
 * not happen at all, so with the flag off: no credential read, no `/usage`
 * request, no snapshot recorded, and no interval scheduled. The check is made
 * BEFORE `fetchUsageSnapshot` is ever entered, so `readAccessToken` is not
 * invoked either. `start()` re-reads the flag each call, so the value is not
 * captured at construction time.
 */
import {
  SessionLimitSnapshotSource,
  type SessionLimitsSnapshotStore,
  sessionLimitsSnapshotStore,
} from "./snapshot-store.js";
import {
  fetchUsageSnapshot,
  type UsageApiClientDeps,
  type UsageFetchFailure,
} from "./usage-api-client.js";

/**
 * How often the snapshot is refreshed. Comfortably inside the store's 15-minute
 * staleness window, so a single failed refresh cannot age the surface out.
 */
export const USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export type UsageApiServiceDeps = {
  /** Client dependencies (credential reader, transport, clock). */
  client: UsageApiClientDeps;
  /**
   * The Labs gate (`subscriptionSessionLimits`). Read on every attempt rather
   * than captured once, and defaulted to DISABLED so a caller that forgets to
   * wire it cannot accidentally enable a credential read.
   */
  isEnabled?: () => boolean;
  /** Store to record into (defaults to the process-wide instance). */
  store?: SessionLimitsSnapshotStore;
  /** Epoch ms, for the store's freshness ordering. */
  nowMs?: () => number;
  /** Refresh cadence override (tests). */
  intervalMs?: number;
  setIntervalFn?: (
    handler: () => void,
    ms: number
  ) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
  /**
   * Notified after each attempt, for diagnostics. MUST NOT be given anything
   * credential-derived — it receives only the closed failure reason enum.
   */
  onResult?: (
    outcome: { ok: true } | { ok: false; reason: UsageFetchFailure }
  ) => void;
};

/** Schedules `/usage` captures and records them into the snapshot store. */
export class UsageApiService {
  readonly #deps: UsageApiServiceDeps;
  readonly #store: SessionLimitsSnapshotStore;
  readonly #isEnabled: () => boolean;
  readonly #nowMs: () => number;
  readonly #intervalMs: number;
  readonly #setIntervalFn: NonNullable<UsageApiServiceDeps["setIntervalFn"]>;
  readonly #clearIntervalFn: NonNullable<
    UsageApiServiceDeps["clearIntervalFn"]
  >;
  #handle: ReturnType<typeof setInterval> | null = null;
  #disposed = false;

  constructor(deps: UsageApiServiceDeps) {
    this.#deps = deps;
    this.#store = deps.store ?? sessionLimitsSnapshotStore;
    // Fail CLOSED: an unwired gate means disabled, never enabled.
    this.#isEnabled = deps.isEnabled ?? (() => false);
    this.#nowMs = deps.nowMs ?? Date.now;
    this.#intervalMs = deps.intervalMs ?? USAGE_REFRESH_INTERVAL_MS;
    this.#setIntervalFn =
      deps.setIntervalFn ?? ((handler, ms) => setInterval(handler, ms));
    this.#clearIntervalFn =
      deps.clearIntervalFn ?? ((handle) => clearInterval(handle));
  }

  /**
   * Run one capture. Resolves true when a snapshot was recorded. Never rejects:
   * every failure path resolves false so a scheduled tick cannot produce an
   * unhandled rejection.
   */
  async refreshNow(): Promise<boolean> {
    if (this.#disposed || !this.#isEnabled()) {
      // Flag off → return before the client is entered, so no credential is read
      // and no request is issued. Deliberately silent: this is the default
      // state, not a failure worth reporting.
      return false;
    }
    let result: Awaited<ReturnType<typeof fetchUsageSnapshot>>;
    try {
      result = await fetchUsageSnapshot(this.#deps.client);
    } catch {
      // fetchUsageSnapshot is contractually non-throwing; this is a belt-and-
      // braces guard so a future regression there cannot crash the interval.
      this.#deps.onResult?.({ ok: false, reason: "network" });
      return false;
    }

    // A refresh that lands after disposal must not resurrect a stopped service.
    if (this.#disposed) {
      return false;
    }

    if (!result.ok) {
      // Deliberately does NOT clear a previously recorded snapshot: a stale
      // reading with an honest timestamp beats erasing it to nothing.
      this.#deps.onResult?.({ ok: false, reason: result.reason });
      return false;
    }

    this.#store.record({
      source: SessionLimitSnapshotSource.UsageApi,
      fetchedAtMs: this.#nowMs(),
      limits: result.snapshot,
    });
    this.#deps.onResult?.({ ok: true });
    return true;
  }

  /**
   * Begin refreshing. Fires one capture immediately (so a cold start does not
   * wait a full interval) and then on the interval. Idempotent.
   */
  start(): void {
    if (this.#disposed || this.#handle !== null || !this.#isEnabled()) {
      // No timer is scheduled while the flag is off. Enabling it takes effect on
      // the next `start()` (app restart), which is the correct trade for a
      // not-yet-approved feature: nothing runs until someone opts in.
      return;
    }
    this.#handle = this.#setIntervalFn(() => {
      this.refreshNow().catch(() => undefined);
    }, this.#intervalMs);
    // Fire once immediately so a cold start does not wait a whole interval.
    this.refreshNow().catch(() => undefined);
  }

  /** Stop refreshing and clear the timer. Idempotent; safe to call unstarted. */
  stop(): void {
    if (this.#handle !== null) {
      this.#clearIntervalFn(this.#handle);
      this.#handle = null;
    }
  }

  /** Stop permanently. Further `start`/`refreshNow` calls are no-ops. */
  dispose(): void {
    this.stop();
    this.#disposed = true;
  }
}
