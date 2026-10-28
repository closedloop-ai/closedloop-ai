/**
 * @file collector-records-dropped-telemetry.ts
 * @description ISS-6417 — emit the "a collector read records and then dropped
 * them" signal on the EXISTING desktop telemetry transport.
 *
 * ## Why a raw log is not enough
 *
 * `deps.log` reaches `gatewayLog.info`, which writes the console, the in-memory
 * ring, and the local log file — a diagnostic for whoever is already on that
 * machine, and invisible to everyone else. The condition it describes is silent
 * by construction: nothing throws, the store stays healthy, the hook reports
 * success, and the records are simply gone from wherever the reason says they
 * were owed — for the ingestion reasons, everywhere. That is the
 * ISS-5347 shape — a real data loss that ran for three days behind reassuring
 * log lines — so it needs a typed, queryable event rather than a line someone
 * might read.
 *
 * ## Why it is not a method on `Observability`
 *
 * Same two reasons `sync-lane-stall-telemetry.ts` gives: `Observability` sits at
 * the 1,000-line ceiling and is not grandfathered, and the obvious host,
 * {@link Observability.storeIntegrityResult}, owns a four-state cadence machine
 * whose transitions an unrelated condition would corrupt. This is also NOT a
 * store-integrity finding: the SQLite store is intact and the corrupt input is
 * an external transcript file, so routing it there would tell an operator to
 * inspect a database that is fine.
 *
 * ## What it does and does not carry
 *
 * A bounded reason and a count. No session id, agent id, transcript path, or
 * offending value — those stay in the caller's local log, which is where an
 * operator can actually open the file. Emission cadence is the CALLER'S (one
 * event per hook that dropped anything), so this stays a dumb emit with no state
 * of its own.
 */

import { Observability } from "./observability.js";
import {
  CollectorRecordsDroppedReason,
  type TelemetryTraceContext,
} from "./telemetry-protocol.js";

/**
 * Report that `count` records the process had already read were then dropped
 * for `reason` — off a harness transcript by an ingestion collector, out of a
 * sync payload by the producer, or out of the GenAI span emitter (ISS-11347).
 * What that costs differs by reason, which is
 * what {@link RECORD_FATE_BY_REASON} exists to say.
 *
 * A zero is not reportable and never emitted: the wire schema rejects a
 * non-positive count, so a caller whose tally ran outside the branch where the
 * drop actually happened fails loudly rather than inflating the alert.
 */
export function reportCollectorRecordsDropped(input: {
  reason: CollectorRecordsDroppedReason;
  count: number;
}): void {
  if (input.count <= 0) {
    return;
  }
  const trace: TelemetryTraceContext = {};
  Observability.getTelemetryEmitter().emit({
    severity: "error",
    category: "collector.records_dropped",
    message:
      `Dropped ${input.count} record(s) already read (${input.reason}). ` +
      RECORD_FATE_BY_REASON[input.reason],
    trace,
    diagnostics: {
      collectorRecordsDropped: { reason: input.reason, count: input.count },
    },
  });
}

/**
 * ISS-6999 (codex, cid 3846063735): where the dropped records now are — the one
 * fact an operator acts on, and NOT the same answer for every reason.
 *
 * The ingestion reasons destroy the record: read off a transcript, refused by
 * the store or cut at a worker boundary, present nowhere afterwards. The SYNC
 * producer's reason does not: those rows are still sitting in the desktop's own
 * `agent_component_session_usage` and simply never reach the cloud. Nor does
 * the GenAI reason: the request is imported, only its span is not sent. Telling
 * an operator they no longer exist locally would send them looking for a local
 * recovery that is not needed — the distinction this map exists to keep.
 *
 * Exhaustive by TYPE, so a new reason cannot inherit a fate it never declared;
 * adding one fails `tsc` here until it says where its records are.
 */
const RECORD_FATE_BY_REASON: Record<CollectorRecordsDroppedReason, string> = {
  [CollectorRecordsDroppedReason.UnreadableTimestamp]:
    "That data does not exist locally or upstream.",
  [CollectorRecordsDroppedReason.SessionResponseBudget]:
    "That data does not exist locally or upstream.",
  [CollectorRecordsDroppedReason.TokenSeriesResponseBudget]:
    "That data does not exist locally or upstream.",
  [CollectorRecordsDroppedReason.ComponentUsagePayloadBudget]:
    "Those rows remain in the local store and will never reach the cloud.",
  [CollectorRecordsDroppedReason.GenAiRequestRefused]:
    "The requests remain in the local store; their GenAI spans were never sent.",
};
