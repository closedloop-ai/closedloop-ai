/**
 * @file outbox-clear-result.ts
 * @description ISS-7957 — what a verified-ack outbox clear REPORTS, and the
 * boundary check that decides whether a reported count can be believed.
 *
 * `sqliteClearOutboxEntries` runs one `deleteMany` and has its `count`. Before
 * this module it discarded it, and `durablyClearedRows` — the field the
 * burn-down publishes as `queueRowsClearedSincePrevious` — was populated from
 * the number of ACKED IDS instead. The two disagree in exactly the case that
 * matters: an ack naming ids that no longer correspond to rows reported progress
 * that did not happen.
 *
 * ## Why this needs a schema at all
 *
 * The clear crosses the FEA-2038 db-host `utilityProcess` boundary. In that
 * build `syncSource.clearOutboxEntries` is the forwarding Proxy: the call is an
 * `invoke` message, and the reply is whatever the child structured-cloned back.
 * `db-host-invoke-dispatch` delivers that value verbatim — no validation, and
 * the main-process Proxy is a single `as DbHostAgentDatabase` cast — so the
 * static type of this result is an ASSERTION about the peer, not a fact about
 * the bytes. A peer on a different build answers `undefined` here, and nothing
 * in the type system says so.
 *
 * ## Why the schema is LOOSE, not `.strict()`
 *
 * Same reason `telemetryDiagnosticsBoundarySchema` is: a `.strict()` schema at a
 * cross-process boundary rejects the ENTIRE payload over one key it was never
 * taught, which converts a newer peer's richer reply into a total loss. Loose
 * type-checks the field both halves agree on and lets an unknown one travel.
 *
 * ## Why the verdict is RETURNED rather than reported here (ISS-8179)
 *
 * A reply that carries an unbelievable `deletedRowCount` is IPC corruption or a
 * producer defect, not version skew, and it has to reach a monitored sink. It
 * cannot be reported from this module: this is a pure boundary reader with no
 * logging dependency, and the context that makes such a report actionable — the
 * `sourceKey` and how many ids the ack named — lives one frame up in
 * `clearOutboxOnAck`. So {@link readClearedRowCount} names which of the three
 * answers it got and that caller owns the reporting.
 *
 * {@link OUTBOX_CLEAR_RESULT_SHAPE} carries the compile-time keys-covered guard
 * (`satisfies Record<keyof OutboxClearResult, z.ZodTypeAny>`), so the NEXT field
 * added to {@link OutboxClearResult} fails `tsc` here rather than silently
 * travelling unvalidated.
 *
 * ## What the count may be used for
 *
 * Triage evidence on an alert, plus ONE constrained gate. PR #5915 (ISS-7401)
 * REMOVED a suppression path that let a nonzero count silence
 * `detectCursorStall`. At that time `clearOutboxOnAck` reported a `deleteMany`
 * that matched zero rows as progress, and a `false` from the detector DELETES
 * the stall latch. Together they could have disarmed both durable-cursor
 * detectors permanently. This module made the count real.
 *
 * ISS-10429 is the separate decision this module left open. Perrin Upcott ruled
 * on 2026-09-16 that `detectCursorStall` may treat a nonzero count as durable
 * progress only when the row holding the lane's watermark (its in-memory cursor
 * boundary) also moved forward. That rule is `clearedRowsPastCursorBoundary` in
 * `sync-burndown-contract.ts`. The count on its own still proves nothing: newer
 * rows keep clearing while one old row is stuck, and that lane must still
 * alert. Nothing else may gate on this value.
 */

import { z } from "zod";

/** What a durable outbox clear reports about itself. */
export type OutboxClearResult = {
  /**
   * Rows the `deleteMany` actually removed — NOT the number of ids asked for.
   * The two differ whenever an ack names an id with no surviving row.
   */
  deletedRowCount: number;
};

/**
 * The VERDICT an ack's durable clear hands back to its caller: whether the write
 * committed, and — when something measured one — how many rows it removed.
 *
 * Named here rather than spelled out at each of the three hops it travels
 * (`clearOutboxOnAck` → `OutboxWriters.clearOnAck` → `AcceptedAckDeps.
 * clearOutboxDurably`) because those hops are wired by structural
 * assignability: a producer that grew a member is still assignable to a
 * consumer that never heard of it, and the member is silently erased on the way
 * through. That is the same silent-drop failure {@link OUTBOX_CLEAR_RESULT_SHAPE}
 * guards one layer down, and it deserves one owner for the same reason.
 *
 * Distinct from {@link OutboxClearResult}, which is the DELEGATE's reply and
 * requires its count. Here the count is optional because "unmeasured" is a real
 * answer — see {@link readClearedRowCount}.
 */
export type OutboxClearVerdict = {
  cleared: boolean;
  deletedRowCount?: number;
};

/**
 * One validator per field. The `satisfies` is load-bearing rather than
 * decoration: it is what makes an unmapped new field a compile error.
 */
export const OUTBOX_CLEAR_RESULT_SHAPE = {
  deletedRowCount: z.number().int().nonnegative(),
} satisfies Record<keyof OutboxClearResult, z.ZodTypeAny>;

/** Loose on purpose — see this file's header. */
const outboxClearResultBoundarySchema = z.looseObject(
  OUTBOX_CLEAR_RESULT_SHAPE
);

/**
 * Objecthood probe, run only after the strict read above has already failed.
 *
 * `z.unknown()` type-checks nothing on purpose: this answers only whether the
 * reply is an OBJECT at all, so that a bare `2`, a `"2"`, or an `undefined`
 * reply is settled here rather than by the presence check below. Loose for the
 * same reason its sibling is — an unknown key from a newer peer must not decide
 * this.
 */
const outboxClearCountProbeSchema = z.looseObject({
  deletedRowCount: z.unknown(),
});

/**
 * ISS-8179: which of the three answers a delegate's reply actually gave.
 *
 * A discriminated union rather than an optional number, because the two
 * count-less answers are NOT the same event and collapsing them is the defect
 * this exists to stop: {@link OutboxClearCountKind.Absent} is an expected,
 * silent, version-skew reading, and {@link OutboxClearCountKind.Malformed} is
 * IPC corruption or a producer defect that someone has to look at.
 */
export const OutboxClearCountKind = {
  /** The reply carried a count this boundary believes. */
  Measured: "measured",
  /** No `deletedRowCount` was carried at all — degrade silently. */
  Absent: "absent",
  /** A `deletedRowCount` WAS carried and cannot be believed — report it. */
  Malformed: "malformed",
} as const;

export type OutboxClearCountKind =
  (typeof OutboxClearCountKind)[keyof typeof OutboxClearCountKind];

/** One reply, read. Exhaustive by construction — see {@link OutboxClearCountKind}. */
export type OutboxClearCountReading =
  | { kind: typeof OutboxClearCountKind.Measured; deletedRowCount: number }
  | { kind: typeof OutboxClearCountKind.Absent }
  | { kind: typeof OutboxClearCountKind.Malformed };

/**
 * Read a clear's reported row count out of whatever the delegate answered.
 *
 * Both count-less readings still OMIT the count downstream — deliberately not
 * `0`: the burn-down distinguishes an omitted count (nothing measured) from a
 * reported zero (measured, cleared nothing), and the second is the alarming
 * reading on the very alert whose job is telling those two populations apart.
 * Fabricating a zero here would raise the stall alarm this field exists to help
 * silence. What ISS-8179 changed is only that the CALLER can now tell which of
 * the two happened; the value it publishes is unchanged.
 *
 * ABSENT is drawn as wide as cross-repo compatibility requires, and no wider:
 * `undefined`, a reply that is not an object at all, and an object WITHOUT the
 * own key. Every one of those is a db-host peer that predates the field (root
 * `AGENTS.md` — an absent optional cross-process field is OMITTED, never
 * serialized as a value), and none may raise an alert.
 *
 * MALFORMED is therefore exactly the reviewer's population: the field is THERE
 * and the boundary schema rejects it — a string, a negative, a non-finite, a
 * fractional, a `null`, or an integer past the safe range where a JS number no
 * longer names one integer.
 *
 * Presence is OWN-PROPERTY presence, which is why it is asked of the raw reply
 * rather than of the probe's parsed data: structured clone preserves an
 * explicitly-`undefined` key, so `{ deletedRowCount: undefined }` arrives
 * distinguishable from an omitted one, and Zod cannot express that distinction
 * (it normalizes present-`undefined` and absent to the same parsed shape). That
 * distinction is load-bearing here. A peer that PREDATES the field cannot name
 * it at all, so a reply carrying the key with no value is a producer that knows
 * the field and failed to compute it — a defect, on the same footing as the
 * explicit `null` beside it, not the older peer the ABSENT arm exists for.
 *
 * Never throws: a clear that COMMITTED must not be reported as failed because
 * its bookkeeping was unreadable.
 */
export function readClearedRowCount(value: unknown): OutboxClearCountReading {
  const parsed = outboxClearResultBoundarySchema.safeParse(value);
  if (parsed.success) {
    return {
      kind: OutboxClearCountKind.Measured,
      deletedRowCount: parsed.data.deletedRowCount,
    };
  }
  const probed = outboxClearCountProbeSchema.safeParse(value);
  if (!(probed.success && carriesOwnDeletedRowCount(value))) {
    return { kind: OutboxClearCountKind.Absent };
  }
  return { kind: OutboxClearCountKind.Malformed };
}

/**
 * Whether the reply carries `deletedRowCount` as its OWN key, whatever its
 * value.
 *
 * Deliberately not a Zod check: the question is presence, and Zod answers shape.
 * A schema treats a present-`undefined` key and an omitted one as the same
 * parsed result, which is precisely the two populations this module exists to
 * keep apart.
 */
function carriesOwnDeletedRowCount(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, "deletedRowCount")
  );
}
