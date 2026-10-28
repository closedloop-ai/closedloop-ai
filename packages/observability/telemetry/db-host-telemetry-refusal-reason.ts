/**
 * @file db-host-telemetry-refusal-reason.ts
 * @description ISS-7201 — the bounded `dbHostTelemetryRefused.reason` vocabulary
 * and the diagnostics validator built from it.
 *
 * Its own module rather than another block in `schema.ts`, which owns the whole
 * desktop wire contract and was already within a dozen lines of the file-size
 * ceiling — adding this family inline pushed it over. `schema.ts` imports the
 * finished validator and spends four lines on the family instead of twenty.
 */

import { z } from "zod";

/**
 * Which field made a db-host child's telemetry event unroutable at main's
 * boundary. Bounded and content-free by construction: it names the FAULT only,
 * never the refused event's category, message, or diagnostics — that content is
 * precisely what could not be trusted.
 *
 * The desktop mirror is `DbHostTelemetryRefusalReason` in
 * `apps/desktop/src/main/telemetry/telemetry-protocol.ts`, declared there with no
 * shared import from this package (desktop deliberately does not depend on
 * `@repo/observability`). A value only the producer knows about is rejected by
 * `desktopTelemetryEventSchema`, which drops the WHOLE event as
 * `telemetry.validation_failed` — so a new reason MUST be added to both halves in
 * the same change.
 */
export const DbHostTelemetryRefusalReason = {
  /** The relayed `event` was absent, or not an object at all. */
  NotAnObject: "not_an_object",
  /** `severity` was missing, or outside the closed `info`/`warn`/`error` set. */
  InvalidSeverity: "invalid_severity",
  /** `category` was missing, not a string, or empty. */
  MissingCategory: "missing_category",
  /** `message` was missing or not a string. */
  MissingMessage: "missing_message",
  /**
   * The three routing fields were well-formed, but a KNOWN `diagnostics` field
   * carried a value of the wrong type, which main's own transport cannot
   * enrich and this schema would reject as a whole-event drop. An UNKNOWN
   * diagnostics key is not this reason — those ride through by design.
   */
  UnknownShape: "unknown_shape",
} as const;

export type DbHostTelemetryRefusalReason =
  (typeof DbHostTelemetryRefusalReason)[keyof typeof DbHostTelemetryRefusalReason];

/**
 * The `diagnostics.dbHostTelemetryRefused` validator.
 *
 * `.strip()` is what keeps this family content-free in practice rather than by
 * convention: a producer that attached the refused event's category or message
 * to "help debugging" has those fields dropped here instead of logged.
 */
export const dbHostTelemetryRefusedDiagnosticsSchema = z
  .object({ reason: z.enum(Object.values(DbHostTelemetryRefusalReason)) })
  .strip()
  .optional();
