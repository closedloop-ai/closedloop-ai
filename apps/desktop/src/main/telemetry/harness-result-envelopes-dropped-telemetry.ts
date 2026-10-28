/**
 * @file harness-result-envelopes-dropped-telemetry.ts
 * @description ISS-7332 — emit the "persisted harness result envelopes did not
 * validate and were dropped" signal on the EXISTING desktop telemetry transport.
 *
 * ## Why a raw log is not enough
 *
 * `gatewayLog` reaches the console, the in-memory ring, and the local log file —
 * a diagnostic for whoever is already on that machine. The condition it
 * describes is silent by construction: the store loads, the invalid rows are
 * skipped, the file is rewritten WITHOUT them, and nothing throws. The store is
 * the recovery artifact for the authoritative `total_cost_usd` — the figure
 * nothing else in the system carries — so a row lost here is lost the same way
 * the 2026-07-19 → 2026-08-06 window was, which is the failure this module's
 * subject exists to prevent. That needs a typed, queryable event.
 *
 * ## Why it is not a method on `Observability`
 *
 * Same two reasons `collector-records-dropped-telemetry.ts` gives: that class
 * sits at the 1,000-line ceiling and is not grandfathered, and the nearest host,
 * `Observability.storeIntegrityResult`, owns a four-state cadence machine an
 * unrelated condition would corrupt. This is also NOT a store-integrity finding:
 * the SQLite store is uninvolved — the corrupt input is a local JSON file — so
 * routing it there would send an operator to inspect a database that is fine.
 *
 * ## What it does and does not carry
 *
 * A bounded reason and a count. No loop id, work dir, or any part of the
 * envelope — the envelope's own `result` field carries the run's final assistant
 * text, and this module is on the telemetry side of the privacy boundary
 * `harness-result-retention.ts` documents. Emission cadence is the CALLER'S (one
 * event per load that dropped anything), so this stays a dumb emit with no state.
 */

import { Observability } from "./observability.js";
import type {
  HarnessResultEnvelopeDropReason,
  TelemetryTraceContext,
} from "./telemetry-protocol.js";

/**
 * Report that `count` persisted result envelopes were dropped for `reason`.
 *
 * A zero is not reportable and never emitted: the wire schema rejects a
 * non-positive count, so a caller whose tally ran outside the branch where the
 * drop actually happened fails loudly rather than inflating the alert.
 */
export function reportHarnessResultEnvelopesDropped(input: {
  reason: HarnessResultEnvelopeDropReason;
  count: number;
}): void {
  if (input.count <= 0) {
    return;
  }
  const trace: TelemetryTraceContext = {};
  Observability.getTelemetryEmitter().emit({
    severity: "error",
    category: "cost.harness_result_envelopes_dropped",
    message: `Dropped ${input.count} persisted harness result envelope(s) that failed validation (${input.reason}). The authoritative cost those runs carried is no longer recoverable.`,
    trace,
    diagnostics: {
      harnessResultEnvelopesDropped: {
        reason: input.reason,
        count: input.count,
      },
    },
  });
}
