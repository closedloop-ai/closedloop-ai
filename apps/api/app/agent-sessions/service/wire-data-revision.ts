/**
 * ISS-8271: per-session disposition for the client-supplied `dataRevision` on
 * the desktop session-sync wire.
 *
 * Desktop legitimately parks session rows at two LOCAL sentinel revisions
 * (`apps/desktop/src/main/collectors/engine/data-revision.ts`):
 *
 *   • `-1` (`DATA_REVISION_IMPORT_PENDING`, ISS-4572) — the isolated import
 *     stamped the row before its seal group committed. The derived children
 *     (events, token usage, segments…) may be missing or partial: the row is
 *     an import that has not proven itself.
 *   • `0` (`DATA_REVISION_MAINTENANCE_STALE`, ISS-5260) — a maintenance pass
 *     parked a COMPLETE, sealed session for re-derivation; only a derivation
 *     dependency (skill-shadow attribution) is known stale.
 *
 * The desktop sync lane has no revision eligibility filter, and the `-1` stamp
 * bumps `updated_at` in the same statement, so both sentinels leak onto the
 * wire as a matter of course. Rejecting them at the Zod schema was a total
 * loss: the parse is batch-wide (ISS-8051 — one bad field 400s up to 200
 * sessions), the rejection is deterministic, the desktop's Row-class
 * dead-letter is keyed on session id alone, and the reseal that heals the row
 * emits no sync signal — so the session stranded (ISS-8271; ~450 rejected
 * deliveries/day in prod). The schema now accepts any integer and THIS module
 * decides, per session, what the value means:
 *
 *   • `use` with the value — a real revision inside
 *     `[1, MAX_SUPPORTED_DATA_REVISION]`; gate and commit on it as before.
 *     `null`/absent also lands here untouched (older desktop, no revision).
 *   • `use` with `undefined` — sentinel `0` on an UNCHUNKED payload, folded to
 *     "no revision": the content is complete and sealed, so the payload is
 *     applied exactly like an older desktop's — additively, with the stored
 *     revision preserved (`resolveChunkGating` treats null as first-class).
 *     Chunked payloads are excluded from the fold: `resolveChunkGating` cannot
 *     stage a null-revision sequence, so a folded chunked payload would apply
 *     chunk 0 additively and mark every later chunk foreign — a silent partial
 *     apply. Those skip instead, and the desktop re-sends the whole session.
 *   • `skip` — write NOTHING and leave the session out of
 *     `persistedSessionIds`, so an opted-in desktop re-sends it under the
 *     bounded `ack_omitted` budget once the row heals (recoverable — unlike
 *     the validation dead-letter this path replaces). Used for `-1` and every
 *     other negative value (content unproven: folding could persist a partial
 *     parse additively, destroy stored activity tiling via the unchunked
 *     REPLACE-ALL lane, and — when the reseal lands at an already-committed
 *     revision — leave no revision advance to repair it), for a chunked
 *     sentinel `0`, and for a revision above `MAX_SUPPORTED_DATA_REVISION`
 *     (FEA-3595's anti-poison ceiling, now a hold instead of a batch-wide 400
 *     so a newer desktop's version skew is survivable).
 *
 * FEA-3595's guarantee is preserved in a stronger form: a value outside the
 * supported window can no longer reach `resolveChunkGating` or the
 * `data_revision` column at all, so the irreversible high-water mark can only
 * ever hold a real, supported revision.
 */
import { MAX_SUPPORTED_DATA_REVISION } from "@repo/api/src/types/agent-session";

export const WireDataRevisionSkipReason = {
  /**
   * A sentinel revision: the row is mid-derivation on the desktop (import not
   * sealed, or a maintenance park in chunked shape). Held until it heals.
   */
  RevisionPending: "revision_pending",
  /** Above `MAX_SUPPORTED_DATA_REVISION` — a newer producer than this cloud. */
  RevisionTooNew: "revision_too_new",
} as const;

export type WireDataRevisionSkipReason =
  (typeof WireDataRevisionSkipReason)[keyof typeof WireDataRevisionSkipReason];

/**
 * ISS-8131: the no-write holds the CHUNK GATE decided, not the wire
 * disposition. They cannot live beside the reasons above because they are not
 * payload-only — the gate needs the staged `pendingChunkRevision`, so it is
 * judged after the row read, not before the locks. Every member produces the
 * same client-visible behaviour as a wire skip: no write, id omitted from the
 * echo, re-sent under the bounded ack_omitted budget.
 *
 * They do NOT all share one tally. `sentinel_revision_held` counts
 * {@link SentinelHoldReason} only — see it for why `ForeignChunk` is outside
 * that population.
 */
export const SessionGateHoldReason = {
  /**
   * FEA-3474: a chunk whose revision does not match the staged pending
   * assembly. Nothing is written and the id is withheld from the echo — the
   * same client-visible behaviour as its neighbours, which is why it shares
   * this enum. It is NOT a sentinel revision, so it is deliberately absent from
   * the `sentinel_revision_held` population; see `upsert-sessions-batch.ts`.
   *
   * ISS-8781 named it. Before that the arm was representable only as
   * `persisted: false` AND `heldRevisionReason == null` — an implicit encoding
   * no type stated, which is how a fifth no-write arm could have joined it in
   * silence.
   */
  ForeignChunk: "foreign_chunk",
  /**
   * A revision-less payload arrived while a chunk sequence was assembling.
   * Writing its children additively would seal a union of two derivations as
   * one authoritative `dataRevision`; holding it lets the sequence commit the
   * derivation it actually staged.
   */
  SequenceAssembling: "sequence_assembling",
} as const;

export type SessionGateHoldReason =
  (typeof SessionGateHoldReason)[keyof typeof SessionGateHoldReason];

/** Every reason a slice reports a no-write HOLD, whoever decided it. */
export type SessionHoldReason =
  | WireDataRevisionSkipReason
  | SessionGateHoldReason;

/**
 * ISS-8781: the hold reasons `SessionSyncMetric.SentinelRevisionHeld` measures —
 * every one EXCEPT `ForeignChunk`.
 *
 * That metric is a monitoring contract whose docstring defines its population as
 * sentinel and too-new revisions. A foreign chunk is neither, so folding it in
 * would change what an existing query means. The exclusion is stated as a TYPE
 * rather than a runtime filter because the batch's tally is a
 * `Record<SentinelHoldReason, number>`: `foreign_chunk` cannot reach that
 * population by accident, and no reviewer has to notice a missing `if`.
 *
 * DERIVED by exclusion, never re-listed. A hold reason added later joins this
 * type automatically and then fails `tsc` at that `Record` initializer until
 * someone decides, deliberately, whether the sentinel population should grow —
 * which is the opposite of a hand-kept side inventory that widens in silence.
 */
export type SentinelHoldReason = Exclude<
  SessionHoldReason,
  typeof SessionGateHoldReason.ForeignChunk
>;

export type WireDataRevisionDisposition =
  | {
      kind: "use";
      /**
       * The revision the apply should gate and commit on. `undefined` for the
       * folded sentinel-0 case (and for a payload that sent none), `null`
       * preserved as-sent — the column write is `shouldCommitRevision`-gated,
       * which requires a non-null value, so neither ever lands.
       *
       * ISS-8131: that reasoning covers `data_revision` only. A revision-less
       * disposition also leaves the three `pendingChunk*` columns UNTOUCHED —
       * it used to clear them, wiping the marker of a sequence still
       * assembling (see `resolvePendingChunkPatch`).
       */
      revision: number | null | undefined;
    }
  | { kind: "skip"; reason: WireDataRevisionSkipReason };

/**
 * The disposition for a wire session, deriving chunkedness from its own chunk
 * marker — the one way every caller (slice admission, batch hold-expressibility
 * guard) states the question, so the "is this payload chunked" predicate cannot
 * drift between them.
 */
export function resolveSessionWireDataRevisionDisposition(session: {
  dataRevision?: number | null;
  chunk?: { total: number } | null;
}): WireDataRevisionDisposition {
  return resolveWireDataRevisionDisposition({
    dataRevision: session.dataRevision,
    isChunked: session.chunk != null && session.chunk.total > 1,
  });
}

export function resolveWireDataRevisionDisposition(input: {
  dataRevision: number | null | undefined;
  /** True when the payload declares a multi-part chunk sequence. */
  isChunked: boolean;
}): WireDataRevisionDisposition {
  const revision = input.dataRevision;
  if (revision == null) {
    return { kind: "use", revision };
  }
  if (revision >= 1 && revision <= MAX_SUPPORTED_DATA_REVISION) {
    return { kind: "use", revision };
  }
  if (revision > MAX_SUPPORTED_DATA_REVISION) {
    return {
      kind: "skip",
      reason: WireDataRevisionSkipReason.RevisionTooNew,
    };
  }
  if (revision === 0 && !input.isChunked) {
    return { kind: "use", revision: undefined };
  }
  return {
    kind: "skip",
    reason: WireDataRevisionSkipReason.RevisionPending,
  };
}
