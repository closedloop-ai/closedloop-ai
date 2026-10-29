import { z } from "zod";
import { DeadEndPhase } from "./app";
import { TelemetryAttribute } from "./src/attributes";
import {
  boundedText,
  TelemetryDurationMsMax,
  TelemetryTextMaxLength,
} from "./src/schema-primitives";

const IpcOperationSchema = z.enum(["list", "detail", "usage", "page_data"]);

/** Bounded request vocabulary carried by an IPC list-query span. */
export const IpcQuerySource = {
  Canonical: "canonical",
  Legacy: "legacy",
} as const;

/** Bounded execution paths carried by an IPC list-query span. */
export const IpcQueryExecution = {
  Count: "count",
  CursorPage: "cursor_page",
  DatabasePage: "database_page",
  DisplayValueFallback: "display_value_fallback",
  HydratedFallback: "hydrated_fallback",
  PreHydrationPage: "pre_hydration_page",
  Refused: "refused",
  Unsupported: "unsupported",
} as const;

/** Bounded canonical-query refusal codes carried separately from error.type. */
export const IpcQueryRefusal = {
  UnsupportedVersion: "list_query_version_unsupported",
  UnsupportedField: "list_query_field_unsupported",
  UnsupportedOperator: "list_query_operator_unsupported",
  TooManyClauses: "list_query_too_many_clauses",
  TooManyValues: "list_query_too_many_values",
  TooManySortRules: "list_query_too_many_sort_rules",
  Malformed: "list_query_malformed",
} as const;
export type IpcQueryRefusal =
  (typeof IpcQueryRefusal)[keyof typeof IpcQueryRefusal];

/** Runtime validator for the optional IPC list-query source attribute. */
export const IpcQuerySourceSchema = z.enum(IpcQuerySource);

/** Runtime validator for the optional IPC list-query execution attribute. */
export const IpcQueryExecutionSchema = z.enum(IpcQueryExecution);

/** Runtime validator for the optional canonical-query refusal attribute. */
export const IpcQueryRefusalSchema = z.enum(IpcQueryRefusal);

const IpcQueryPopulationCountSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

/**
 * Strict IPC perf wide-event schema (FEA-1997). One event per Agent Dashboard
 * `list`/`detail`/`usage`/`page_data` IPC call carries the dimensions that expose the
 * many-sessions performance cliff: handler duration, serialized payload size,
 * returned row count, and the total local-store session count. `error.type` is
 * present only when the call failed (the span is also marked ERROR so the
 * collector tail policy retains it at 100%).
 *
 * The four dimensions the handler itself measures are required. ISS-8773 made
 * `ipc.session_count` optional, because it is the one dimension a SEPARATE query
 * produces: a distressed db-host fails the handler and the follow-up COUNT
 * together, and the producer omits a count it never measured rather than
 * fabricating a 0. Requiring it here meant `.parse()` threw on exactly that
 * event, the producer's best-effort catch swallowed the throw, and the
 * `error.type` the event exists to carry was dropped in the only situation it
 * mattered. `error.type` is likewise optional — present only on a failed call.
 */
export const IpcTelemetrySchema = z
  .object({
    [TelemetryAttribute.IpcOperation]: IpcOperationSchema,
    // Reuses the span schema's duration bound (0..24h in ms). Carried as an
    // explicit wide-event dimension in addition to the native span duration the
    // collector tail-sampling latency policy reads.
    [TelemetryAttribute.DurationMs]: z
      .number()
      .int()
      .min(0)
      .max(TelemetryDurationMsMax),
    [TelemetryAttribute.IpcMatchedCount]:
      IpcQueryPopulationCountSchema.optional(),
    [TelemetryAttribute.IpcPayloadBytes]: z.number().int().min(0),
    [TelemetryAttribute.IpcResultCount]: z.number().int().min(0),
    [TelemetryAttribute.IpcQueryExecution]: IpcQueryExecutionSchema.optional(),
    [TelemetryAttribute.IpcQueryRefusal]: IpcQueryRefusalSchema.optional(),
    [TelemetryAttribute.IpcQuerySource]: IpcQuerySourceSchema.optional(),
    [TelemetryAttribute.IpcScannedCount]:
      IpcQueryPopulationCountSchema.optional(),
    [TelemetryAttribute.IpcSessionCount]: z.number().int().min(0).optional(),
    [TelemetryAttribute.ErrorType]: boundedText(
      TelemetryTextMaxLength.ErrorType
    ).optional(),
  })
  .strict();

/** Parsed IPC perf telemetry attribute shape. */
export type IpcTelemetry = z.infer<typeof IpcTelemetrySchema>;

/**
 * ISS-12039: both operands of the dead-end rate as ONE log record family, so
 * the builds that write the numerator are the builds that write the
 * denominator. Population: local-mode, user-initiated (Perrin Upcott rulings,
 * 2026-10-05). A record carries `ipc.operation` for each settled user-initiated
 * Agent Dashboard IPC read (a key's first fetch or an explicit refresh; polls
 * write none), or `dead_end.phase: rendered` for each rendered Sessions dead
 * end. Cloud-mode reads go over HTTP and write no record, so a dead end
 * rendered in Cloud mode writes none either. Neither side is sampled or capped:
 * the dead-end side is written ahead of the desktop dead-end recorder's
 * per-process cap, which still bounds the detailed `dead_end.treatment`
 * records. A rate record never carries `dead_end.treatment`, which every
 * `dead_end.treatment` record does, so a query tells the two apart with it.
 */
export const DeadEndRateRecordName = "dead_end.rate";

/** Strict attribute schema for the dead-end rate record. */
export const DeadEndRateRecordSchema = z.union([
  z.object({ [TelemetryAttribute.IpcOperation]: IpcOperationSchema }).strict(),
  z
    .object({
      [TelemetryAttribute.DeadEndPhase]: z.literal(DeadEndPhase.Rendered),
    })
    .strict(),
]);
