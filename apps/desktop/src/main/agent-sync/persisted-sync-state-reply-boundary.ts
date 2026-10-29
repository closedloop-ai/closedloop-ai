/**
 * @file persisted-sync-state-reply-boundary.ts
 * @description ISS-8115 — the boundary schema for the DURABLE CURSOR reply
 * (`syncSource.loadSyncState`), split out of `sync-source-reply-boundary.ts`
 * (ISS-10053) when the lane run added fields that degrade differently from every
 * other reply there. The rules it follows — loose never `.strict()`, known
 * fields validated to their domain, never throw, every rejection reported — are
 * that file's header, and are not restated here.
 *
 * PLN-2028 D6 is the one rule that is new: the three lane-run fields degrade
 * ALONE. An unreadable origin, reason or producer is dropped and reported, and
 * the cursor still loads, because none of them is part of the watermark decision
 * that makes every other field here all-or-nothing.
 */

import { z } from "zod";
import { reportRejectedDbHostReply } from "../telemetry/db-host-reply-rejection.js";
import { DbHostRejectedReplyOp } from "../telemetry/telemetry-protocol.js";
import { componentDeadLetterRecordSchema } from "./agent-component-dead-letter-persistence.js";
import { MAX_OBSERVED_TOP_IDS } from "./agent-session-sync-backoff-policy.js";
import type { PersistedSyncState } from "./agent-session-sync-source.js";
import { LANE_RUN_COLUMN_SCHEMAS } from "./sync-cursor-state-source.js";

/**
 * One validator per field of {@link PersistedSyncState}. The `satisfies` is what
 * makes an unmapped new field a compile error — see
 * `sync-source-reply-boundary.ts`'s header.
 *
 * `observedTopUpdatedAt` is `string | null` because a persisted cursor that has
 * never observed a top row is a real state, not a fault. When it IS a string it
 * must be a canonical ISO 'T'-form UTC instant, because a JS-`string` check is
 * not enough here: `sessions.updated_at` is a TEXT column and the incremental
 * query compares it RAW (`WHERE updated_at > $1`), so ordering is LEXICAL. A
 * peer answering `"zzzz"` — or `"9999-invalid"` — sorts ABOVE every canonical
 * `2026-…` stamp, so the scan matches nothing, the watermark never advances, and
 * because the value is truthy the resume ALSO skips the full backfill. The lane
 * then re-persists the same poisoned watermark and is wedged across restarts,
 * silently. `z.iso.datetime()` is exactly the form `bumpSessionsUpdatedAt`
 * documents as mandatory (`Date#toISOString` / `chunkWatermark`) and it also
 * rejects SQLite's space-separated `datetime('now')` form, which the FEA-3232
 * review caught sorting BELOW same-date ISO stamps.
 */
export const PERSISTED_SYNC_STATE_SHAPE = {
  observedTopUpdatedAt: z.iso.datetime().nullable(),
  // The writer already caps this set at MAX_OBSERVED_TOP_IDS
  // (`capPersistedTopIds`), so the same bound is what a healthy peer can answer;
  // this is that constant, not a second copy of it. It matters on the read side
  // because every id becomes one positional SQLite bind in
  // `listUpdatedSessionCursorRows`' `id NOT IN (…)` expansion, so an unbounded
  // array walks past SQLITE_MAX_VARIABLE_NUMBER and THROWS out of the sync tick
  // — the one outcome this boundary exists to prevent.
  observedIdsAtTopUpdatedAt: z.array(z.string()).max(MAX_OBSERVED_TOP_IDS),
  deadLetteredIds: z.array(z.string()),
  // ISS-8593: optional because it is the COMPONENT lane's field — the session
  // lane never sets it, and a cursor row written before migration 0080 has no
  // value to answer with. Validated against the schema that OWNS the record
  // shape rather than a second copy of the predicate.
  //
  // This entry exists to keep the keys-covered guard total, NOT because it is
  // what protects the component lane: that lane reads `loadSyncState` raw and
  // never reaches this boundary, so it runs the same schema itself at its own
  // hydrate (`agent-session-sync-component-lane.ts`). Only the session lane's
  // hydration passes through here, and it neither sets nor reads the field.
  deadLetterAttempts: z.array(componentDeadLetterRecordSchema).optional(),
  // ISS-8593: present for the same reason the field above is — to keep the
  // keys-covered guard total. The component lane does not read its drop signal
  // through here either; it validates the count itself at its own hydrate
  // (`componentDeadLetterRecordsWereDropped`), because only that lane fails
  // closed on it and only that lane can act on the answer.
  deadLetterAttemptsDropped: z.int().nonnegative().optional(),
  // ISS-9418 (migration 0082): the durable lane give-up stamp. Optional because
  // a lane that has not given up omits it, and every row written before the
  // column existed has no value to answer with.
  //
  // `z.iso.datetime()` rather than a bare string, for the reason
  // `observedTopUpdatedAt` above is: this value is parsed back into a clock
  // (`Date.parse`) and compared against the re-arm window, so a peer answering
  // an unparseable string would produce a `NaN` stamp. `NaN` makes every later
  // comparison false, which removes the recovery door silently — the exact
  // failure `SyncRetryBudgetState.originMs`'s nullability exists to make
  // impossible to write by accident. Refusing it here leaves the field absent,
  // which the lane reads as "has not given up" and re-derives from its own run.
  laneGaveUpAt: LANE_RUN_COLUMN_SCHEMAS.laneGaveUpAt.optional(),
  // PLN-2028 (migration 0091_iss10053_sync_state_lane_run): the rest of the lane
  // run. Each DEGRADES ALONE (D6) — see `FIELDS_THAT_DEGRADE_ALONE`. Every
  // lane-run domain, the stamp's included, is `LANE_RUN_COLUMN_SCHEMAS`, the same
  // validators the store's write refuses against.
  laneStalledSince: LANE_RUN_COLUMN_SCHEMAS.laneStalledSince.optional(),
  laneGaveUpReason: LANE_RUN_COLUMN_SCHEMAS.laneGaveUpReason.optional(),
  laneGaveUpSource: LANE_RUN_COLUMN_SCHEMAS.laneGaveUpSource.optional(),
} satisfies Record<keyof PersistedSyncState, z.ZodTypeAny>;

/** Loose on purpose — see `sync-source-reply-boundary.ts`'s header. */
const persistedSyncStateBoundarySchema = z.looseObject(
  PERSISTED_SYNC_STATE_SHAPE
);

/**
 * Read the durable upload cursor out of whatever the delegate returned.
 *
 * `null` is a legitimate answer from the contract itself (a fresh store, or a
 * first run after upgrade) and means "no cursor — full backfill", so it is
 * passed through rather than rejected. Every other unreadable reply degrades to
 * that SAME `null`, because a full backfill re-walks the corpus and loses
 * nothing, whereas seeding a watermark from a half-trusted cursor silently skips
 * rows that were never uploaded.
 *
 * `undefined` is NOT `null` here, and the difference is the whole reason this
 * function is not `value == null`. The delegate is declared
 * `PersistedSyncState | null`, and the one production caller checks
 * `source.loadSyncState` exists BEFORE invoking it — so by the time a reply
 * reaches this function the op was genuinely called, and `undefined` is a reply
 * outside its own contract rather than a source that has no cursor. Both
 * degrade to a full backfill, because that is the safe answer either way, but
 * only one of them is a FAULT, and folding them together would spend the
 * monitored facet's whole purpose: a peer that has silently stopped answering
 * this op would be indistinguishable from a fresh install with nothing to
 * resume. An absent DELEGATE is still not a fault — that case never reaches
 * here.
 *
 * Rejecting the whole cursor rather than salvaging its readable fields is
 * deliberate: the three fields are one decision. A valid `observedTopUpdatedAt`
 * paired with an unreadable `observedIdsAtTopUpdatedAt` would advance the
 * watermark past a tied-timestamp cluster whose observed-id set is unknown, which
 * is exactly the skip the incremental query's `NOT IN (<observedTopIds>)` arm
 * exists to prevent.
 *
 * PLN-2028 D6 is the one exception: an unreadable lane-run field
 * ({@link FIELDS_THAT_DEGRADE_ALONE}) costs only itself. The reply is still a
 * fault and is reported once, but the cursor loads without that field, which
 * the lane then reads exactly as it reads a row written before the column.
 *
 * Never throws. Before this schema the caller spread the reply straight into
 * `new Set(persisted.observedIdsAtTopUpdatedAt)` and iterated
 * `persisted.deadLetteredIds` with `for...of`, so a non-iterable in either field
 * threw out of identity hydration.
 */
export function readPersistedSyncState(
  value: unknown
): PersistedSyncState | null {
  if (value === null) {
    return null;
  }
  const parsed = persistedSyncStateBoundarySchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  reportRejectedDbHostReply({ op: DbHostRejectedReplyOp.LoadSyncState });
  const salvaged = persistedSyncStateBoundarySchema.safeParse(
    withoutUnreadableLaneRunFields(value)
  );
  return salvaged.success ? salvaged.data : null;
}

/**
 * PLN-2028 D6: the {@link PERSISTED_SYNC_STATE_SHAPE} fields an unreadable value
 * drops on its own. Typed against the cursor's keys so a rename fails `tsc`. A
 * field left OFF this list keeps the all-or-nothing default, which fails safe (a
 * full backfill), so forgetting one never trusts a bad value.
 */
const FIELDS_THAT_DEGRADE_ALONE = [
  "laneStalledSince",
  "laneGaveUpReason",
  "laneGaveUpSource",
] as const satisfies readonly (keyof PersistedSyncState)[];

/** `value` minus each {@link FIELDS_THAT_DEGRADE_ALONE} entry its own validator refuses. */
function withoutUnreadableLaneRunFields(value: unknown): unknown {
  const object = z.looseObject({}).safeParse(value);
  if (!object.success) {
    return value;
  }
  const kept: Record<string, unknown> = { ...object.data };
  for (const field of FIELDS_THAT_DEGRADE_ALONE) {
    if (!PERSISTED_SYNC_STATE_SHAPE[field].safeParse(kept[field]).success) {
      Reflect.deleteProperty(kept, field);
    }
  }
  return kept;
}
