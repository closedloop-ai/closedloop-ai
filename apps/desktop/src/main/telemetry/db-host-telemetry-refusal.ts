/**
 * @file db-host-telemetry-refusal.ts
 * @description Emit bounded refusals for telemetry or query-observation
 * metadata from the DB-host child on the EXISTING monitored transport.
 *
 * ## Why a local log is not enough
 *
 * ISS-7109 built the relay that carries a child's telemetry to main's monitored
 * sink, because `Observability.telemetry` is null in the child and every emit it
 * made was discarded by an optional chain. It left one gap: when main REFUSES a
 * relayed event at the boundary, the drop was stated only on `onLog`, which
 * reaches the console, the in-memory ring, and the local log file — a diagnostic
 * for whoever is already on that machine, and invisible to everyone else.
 *
 * That is the same shape ISS-7109 existed to fix, one layer up. A db-host child
 * emitting something main cannot validate produces NO monitored signal: the
 * child's emit returns successfully, main drops it, and the fleet sees silence
 * that is indistinguishable from a healthy child with nothing to report.
 *
 * ## What it carries
 *
 * A single bounded reason naming the refusal class. Nothing else — and
 * pointedly not the refused event, count value, query, or diagnostics, since
 * the whole premise of the refusal is that its content could not be trusted.
 *
 * ## Cadence
 *
 * A dumb emit with no state of its own, matching its two siblings
 * (`collector-records-dropped-telemetry.ts`, `db-host-exit-telemetry.ts`): one
 * event per refusal, and the cadence is the caller's. The child reaches this
 * path only by relaying telemetry, which is itself low-frequency (exceptions,
 * drops, perf samples), so a refusal storm requires an emit storm that is
 * already bounded by the child's own emit sites. The query-count caller also
 * emits at most one fixed-shape event per projection response, however many
 * independently invalid count fields that response carried.
 *
 * This runs in MAIN only. The event it builds is well-formed by construction and
 * `deliverTelemetry` finds no relay sink in main, so reporting a refusal can
 * never re-enter the relay and refuse itself.
 */

import { DbHostResponseKind } from "../database/db-host/db-host-protocol.js";
import { Observability } from "./observability.js";
import { classifyTelemetryEventPayloadRefusal } from "./telemetry-event-payload.js";
import {
  DbHostTelemetryRefusalReason,
  type TelemetryCategory,
  type TelemetryTraceContext,
} from "./telemetry-protocol.js";

/**
 * The category this reporter emits, as a runtime value.
 *
 * Desktop spells {@link TelemetryCategory} as a string union with no runtime
 * const, so this is the single owner on this side and the annotation is the
 * drift guard: renaming the union member fails `tsc` here rather than shipping a
 * category no monitor is querying. Tests import THIS rather than re-typing the
 * literal.
 */
export const DB_HOST_TELEMETRY_REFUSED_CATEGORY: TelemetryCategory =
  "desktop.db_host.telemetry_refused";

const REFUSAL_LOG_MESSAGE =
  "db-host telemetry relay: dropped a child event whose payload is missing a severity, category, or message, or whose diagnostics carry a known field of the wrong type";

const QUERY_COUNT_REFUSAL_MESSAGE =
  "Main discarded impossible count metadata from a db-host session-list projection while preserving the successful read and every valid sibling field.";

/** Report value-free invalid query-count metadata on the monitored refusal event. */
export function reportInvalidDbHostQueryCountMetadata(): void {
  const trace: TelemetryTraceContext = {};
  Observability.getTelemetryEmitter().emit({
    severity: "error",
    category: DB_HOST_TELEMETRY_REFUSED_CATEGORY,
    message: QUERY_COUNT_REFUSAL_MESSAGE,
    trace,
    diagnostics: {
      dbHostTelemetryRefused: {
        reason: DbHostTelemetryRefusalReason.UnknownShape,
      },
    },
  });
}

/**
 * Report — locally AND on the monitored path — that main could not route a
 * telemetry event relayed by the DB-host child.
 *
 * Returns without emitting for every message that does not CLAIM to be
 * telemetry. That silence is the version-skew contract and must stay: a response
 * kind this build has never heard of is a newer child's business, not an error,
 * and alerting on it would fire on every mixed-version install. Only a message
 * that announces `kind: "telemetry"` and then fails payload validation is a
 * refusal.
 */
export function reportRefusedChildTelemetry(input: {
  message: unknown;
  onLog: (message: string) => void;
}): void {
  const { message, onLog } = input;
  if (
    typeof message !== "object" ||
    message === null ||
    (message as { kind?: unknown }).kind !== DbHostResponseKind.Telemetry
  ) {
    return;
  }
  // Classified from the SAME procedure the boundary refused with, so the
  // reported reason always describes the fault that actually caused the drop:
  // `isDbHostResponse` validates a telemetry-kind message by exactly this
  // predicate, so reaching here guarantees a reason.
  //
  // The `undefined` arm is type narrowing, NOT a fallback: reaching here means
  // the message announced `kind: "telemetry"` and failed that predicate, so a
  // reason exists. `unknown_shape` is a real reason with a real input (a known
  // diagnostics field of the wrong type) — it is NOT this arm, and must not be
  // wired to it. An unemittable member on a monitored dimension is worse than
  // useless: it gives a dashboard grouped by `reason` a bucket that is silently
  // always zero, which is why an earlier draft's version of it was removed.
  const reason = classifyTelemetryEventPayloadRefusal(
    (message as { event?: unknown }).event
  );
  if (reason === undefined) {
    return;
  }
  onLog(REFUSAL_LOG_MESSAGE);
  const trace: TelemetryTraceContext = {};
  Observability.getTelemetryEmitter().emit({
    severity: "error",
    category: DB_HOST_TELEMETRY_REFUSED_CATEGORY,
    message: `Main refused a telemetry event relayed by the db-host child (${reason}). Whatever that child was reporting is lost.`,
    trace,
    diagnostics: { dbHostTelemetryRefused: { reason } },
  });
}
