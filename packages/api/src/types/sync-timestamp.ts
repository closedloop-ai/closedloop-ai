import { z } from "zod";
import { isBelowPgTimestampFloor } from "./pg-timestamp-floor.ts";

/** Issue messages the timestamp schemas here raise. */
export const TimestampRejection = {
  InvalidDate: "invalid_date",
  BelowTimestampFloor: "date_below_timestamp_floor",
} as const;
export type TimestampRejection =
  (typeof TimestampRejection)[keyof typeof TimestampRejection];

/** Client-safe ISO-8601 timestamp validator for additive sync contracts. */
export const syncTimestampSchema = z
  .string()
  .transform((value) => value.trim())
  .refine(
    (value) => value.length > 0 && Number.isFinite(Date.parse(value)),
    TimestampRejection.InvalidDate
  );

/**
 * {@link syncTimestampSchema} for a field that is written to a Postgres
 * `timestamp`, degrading an instant the column cannot hold to `undefined`.
 *
 * `Number.isFinite(Date.parse(...))` is a parse check, not a range check: JS
 * dates reach year -271821, roughly 267,000 years before anything Postgres can
 * store, and `toISOString` round-trips that extended-year form intact. Such a
 * value passed every guard on the sync path and only failed at the INSERT,
 * inside the batch's transaction, on a payload the desktop re-sends unchanged
 * on every retry — the wedged-ingest shape of ISS-8338.
 *
 * Out of range DEGRADES rather than rejecting, for the reason `baseRef` and
 * `state` on the pull-request ref carry `.catch(undefined)`: a sync batch is one
 * `safeParse`, so rejecting would 400 up to 200 sessions on a single bad date
 * and keep 400ing them on every retry — worse than today, where the value at
 * least only fails its own slice on a row-level-ack client.
 *
 * A MALFORMED value still rejects, exactly as before. That is deliberate: this
 * schema is also parsed on the desktop, where a ref that fails validation is
 * dropped, and widening that to a degrade would change which refs sync — a
 * behaviour ISS-8547 did not ask to touch.
 *
 * Degrading is right ONLY where no hash reconciles the stored value against the
 * wire value. Where the persisted bytes must equal the wire bytes — the
 * invocation sync lane rehashes its persisted rows — use
 * {@link pgRangedTimestampSchema}, which rejects and never rewrites.
 */
export const storableSyncTimestampSchema = syncTimestampSchema.transform(
  (value) => (isBelowPgTimestampFloor(Date.parse(value)) ? undefined : value)
);

/**
 * ISO-8601 timestamp a JS `Date` can parse, rejecting `invalid_date` for
 * anything else. Unlike {@link syncTimestampSchema} it does not trim, so the
 * bytes in are the bytes out.
 */
export const parsableTimestampSchema = z
  .string()
  .refine(
    (value) => Number.isFinite(Date.parse(value)),
    TimestampRejection.InvalidDate
  );

/**
 * {@link parsableTimestampSchema} narrowed to what a Postgres `timestamp` column
 * can hold, raising `date_below_timestamp_floor` below
 * `PG_TIMESTAMP_MIN_MS` instead of degrading like
 * {@link storableSyncTimestampSchema}: on the invocation sync lane the server
 * rehashes the persisted rows and compares against the wire generation id, so a
 * trimmed or degraded value would hash differently from what the producer signed
 * and turn a transient rejection into a permanent `generation_conflict`
 * (ISS-9174). `isBelowPgTimestampFloor` stays the one floor.
 */
export const pgRangedTimestampSchema = parsableTimestampSchema.refine(
  (value) => !isBelowPgTimestampFloor(Date.parse(value)),
  TimestampRejection.BelowTimestampFloor
);
