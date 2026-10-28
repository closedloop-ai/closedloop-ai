/**
 * @file collector-records-dropped-reason.ts
 * @description Why a collector dropped records it had already read. Names the
 * failure mode only — never a path, a session, an agent, or the offending value.
 *
 * Split out of `schema.ts` (ISS-7429), which sat two logical lines under the
 * 1,000-line `noExcessiveLinesPerFile` ceiling. One bounded vocabulary per
 * module is the shape this directory already uses
 * (`db-host-telemetry-refusal-reason.ts`, `harness-result-envelope-drop-reason.ts`),
 * reached by direct subpath import so no barrel re-export is introduced.
 */

import { tolerantDesktopTelemetryValue } from "./tolerant-desktop-value";

/**
 * ISS-6417 — why a collector dropped records it had already read. Bounded and
 * content-free by construction: it names the FAILURE MODE only, never a path, a
 * session, an agent, or the offending value. The desktop mirror is
 * `CollectorRecordsDroppedReason` in
 * `apps/desktop/src/main/telemetry/telemetry-protocol.ts`, declared there with no
 * shared import from this module.
 *
 * TOLERANT since ISS-7488. It was a closed `z.enum`, so a reason only a newer
 * desktop knew failed the WHOLE event as `telemetry.validation_failed` — 8 of
 * the 33 rejections measured over the 30 days to 2026-09-14 were this one field.
 * Desktop and cloud deploy independently, so a producer ahead of this const is
 * the normal state of a fleet mid-rollout rather than an error, and the
 * drop-reporting event went darkest exactly while a newly added drop path was
 * the thing firing. An unrecognised reason now coarsens to `Unknown`, and the
 * event, its count, and every other diagnostic on the payload arrive.
 *
 * A new reason still belongs here in the same change: coarsening costs this
 * field's precision, which is the one dimension the alert groups by.
 * `scripts/lint/rules/no-unmirrored-desktop-telemetry-enum.ts` reads the
 * `tolerantDesktopTelemetryValue` call below and names a producer-side member
 * this const lacks, so that drift fails CI rather than showing up as a
 * dashboard of `unknown`.
 */
export const CollectorRecordsDroppedReason = {
  /**
   * The record's `timestamp` was a value no `Date` can represent — a nanosecond
   * epoch, `NaN`, or the `Infinity` `JSON.parse` yields from an overflowing
   * numeric literal. A transcript file is a parse boundary and nothing upstream
   * constrains that field. The record is read but not insertable, because an
   * event needs a time and inventing one would be the worse answer.
   */
  UnreadableTimestamp: "unreadable_timestamp",
  /**
   * ISS-5854 — the historical-parse worker's response budget dropped whole
   * parsed sessions so the payload could cross the process boundary at all.
   * The alternative was rejecting the entire source, which imported nothing;
   * the source now imports the prefix that fits, and this event is the only
   * record that the rest existed, since a dropped session leaves no row.
   */
  SessionResponseBudget: "session_response_budget",
  /**
   * ISS-7534 — the historical-parse worker's response budget truncated a
   * session's per-turn token series to make the payload fit the process
   * boundary. The dropped round-trips exist nowhere afterwards, and the
   * session's per-model rollup still reports the full parse, so a consumer
   * summing the series under-counts against a total that did not shrink.
   */
  TokenSeriesResponseBudget: "token_series_response_budget",
  /**
   * ISS-6999 — the sync payload chunker skipped a component-usage unit that no
   * single part could carry, so it could paginate the rest. The read is
   * deterministic and `agent_component_session_usage` carries no sync cursor, so
   * the same unit is re-read and re-skipped on every pass: the rows reach the
   * cloud never rather than later. Its fold-family unit can exceed the cap while
   * every wire group inside it fits, which is why the reader's own bounded
   * prefix does not already report it.
   */
  ComponentUsagePayloadBudget: "component_usage_payload_budget",
  /**
   * ISS-11347 — the desktop refused a parsed LLM request's GenAI span (a model
   * id or count the telemetry contract rejects). The request itself is
   * imported and synced as usual; only its PostHog span never exists.
   */
  GenAiRequestRefused: "gen_ai_request_refused",
  /**
   * ISS-7488 — a reason this build does not recognise, which for a desktop
   * fleet mid-rollout means a drop path newer than this deploy. The event is
   * kept and only this dimension is coarsened; no producer emits the value.
   */
  Unknown: "unknown",
} as const;

export type CollectorRecordsDroppedReason =
  (typeof CollectorRecordsDroppedReason)[keyof typeof CollectorRecordsDroppedReason];

export const COLLECTOR_RECORDS_DROPPED_REASON = tolerantDesktopTelemetryValue(
  CollectorRecordsDroppedReason
);
