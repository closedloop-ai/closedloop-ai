/**
 * @file harness-ingest.ts
 * @description Producer that feeds the COARSE `rate_limit_event` source into the
 * session-limit snapshot store (PRD-539, FEA-3523).
 *
 * Every `--output-format stream-json` harness run persists its stdout to
 * `claude-output.jsonl`; the loop finalizer already scans that file (via
 * {@link file://../cost/token-usage.ts parseHarnessResult}) at completion. This
 * module rides that same seam: it extracts the LATEST `rate_limit_event` from
 * the capture, maps it into a {@link SessionLimitsSnapshot}, and records it in
 * the store so the resolver — and thus the renderer's session-limit bars — see
 * subscription limit state with no opt-in and no new infrastructure.
 *
 * FAIL-CLOSED: a missing/empty capture or a malformed event must NEVER break
 * harness finalization. Every failure path swallows and no-ops (the store simply
 * keeps whatever it had), so cost/event posting is unaffected.
 */
import { parseRateLimitEvent } from "../cost/token-usage.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import { mapRateLimitEventSnapshot } from "./mappers.js";
import {
  SessionLimitSnapshotSource,
  type SessionLimitsSnapshotStore,
  sessionLimitsSnapshotStore,
} from "./snapshot-store.js";

const TAG = "session-limits-harness-ingest";

/** Injectable seams for tests; production defaults to the real implementations. */
export type HarnessSessionLimitsIngestDeps = {
  store?: SessionLimitsSnapshotStore;
  /** Capture time in epoch ms (defaults to `Date.now`). */
  now?: () => number;
};

/**
 * Extract the latest `rate_limit_event` from a run's stdout capture and, when
 * present, record it as a COARSE snapshot. Called from the loop finalizer at the
 * same seam that reads {@link parseHarnessResult}. No-op (and never throws) when
 * the capture holds no usable event or anything goes wrong.
 */
export function ingestHarnessSessionLimits(
  claudeWorkDir: string,
  deps: HarnessSessionLimitsIngestDeps = {}
): void {
  const store = deps.store ?? sessionLimitsSnapshotStore;
  const now = deps.now ?? Date.now;
  try {
    const event = parseRateLimitEvent(claudeWorkDir);
    if (!event) {
      // The common case: no `rate_limit_event` on this run's stream. Not an
      // error — persistent transcripts and interactive runs never carry one.
      return;
    }
    const fetchedAtMs = now();
    const limits = mapRateLimitEventSnapshot(
      event,
      new Date(fetchedAtMs).toISOString()
    );
    store.record({
      source: SessionLimitSnapshotSource.RateLimitEvent,
      fetchedAtMs,
      limits,
    });
  } catch (error) {
    // Fail-closed: session-limit capture must never break harness finalization.
    gatewayLog.warn(
      TAG,
      `rate_limit_event ingest skipped: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
