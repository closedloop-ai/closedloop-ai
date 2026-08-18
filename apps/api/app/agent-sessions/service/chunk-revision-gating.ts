/**
 * FEA-3788 + FEA-3474 (PRD-536 D3): atomic chunk-aware revision gating for the
 * agent-session sync upsert.
 *
 * An oversized session is split by the desktop `chunkOversizedSession` into N
 * chunks, EACH carrying the same `dataRevision` and a `{ index, total }` marker.
 * The chunks arrive as SEPARATE batch requests (one interactive transaction
 * each) over a bounded-retry outbox, so the apply must survive any partial,
 * interrupted, retried, or out-of-order delivery and remain all-or-nothing: an
 * interrupted or contaminated sequence must never leave a half-session
 * masquerading as a complete `dataRevision`.
 *
 * The gate stages the assembling sequence's identity on the SessionDetail row:
 *   - `pendingChunkRevision` — the `dataRevision` chunk 0 started rebuilding.
 *   - `pendingChunkTotal`    — that sequence's chunk count (`chunk.total`).
 *     Half of the sequence's IDENTITY, not just a completeness bound: a later
 *     chunk whose own `total` disagrees belongs to a different chunking and is
 *     foreign.
 *   - `pendingChunkReceived` — the highest CONTIGUOUS chunk index seen + 1
 *     (i.e. how many leading chunks of the sequence have arrived), so a dropped
 *     interior chunk is detectable and the last chunk cannot commit over a gap.
 *
 * Chunk 0 of an ADVANCING revision opens the sequence (delete-replace + stage);
 * each subsequent in-sequence chunk advances the contiguous counter; the LAST
 * chunk commits `dataRevision` ONLY when it belongs to the staged sequence AND
 * every chunk up to it has arrived. A sequence's identity is the PAIR
 * `(dataRevision, chunk.total)` — not the revision alone — so a chunk from a
 * different revision OR a different chunking of the same revision (stale,
 * reordered, re-prepared, or arriving with no chunk 0 staged) is FOREIGN: it
 * must not mutate the live event/detail rows at all, or its events would
 * contaminate the set the real sequence is assembling. A foreign chunk is a
 * no-op; the next in-order chunk 0 re-stages the marker and fully repairs the
 * session.
 *
 * FEA-3595 — forward-only, measured against a HIGH-WATER MARK. "Advancing"
 * means strictly greater than `max(committed revision, staged pending
 * revision)`, so an OLDER desktop can never overwrite a newer cloud projection,
 * and a delayed mid-revision payload can never wipe a newer sequence that is
 * staged but not yet committed. Two consequences worth knowing:
 *   - A payload BELOW the high-water mark is STALE, and stale is foreign in
 *     every shape — unchunked and chunk 0 included, which is the one case where
 *     a foreign payload is not merely "not chunk 0 of the staged sequence".
 *   - A payload EQUAL to the staged pending revision still re-opens that
 *     sequence (`restartsStagedSequence`), because a retried chunk 0 is how an
 *     interrupted sequence repairs itself. An UNCHUNKED payload equal to the
 *     COMMITTED revision remains an idempotent no-op: nothing to replace,
 *     nothing to commit.
 *
 * ISS-6167 — a CHUNKED payload equal to the COMMITTED revision is NOT that
 * no-op, and treating it as one livelocked the desktop lane. Its chunk 0 STAGES
 * the sequence (`reopensCommittedSequence`) so the later chunks are in-sequence
 * rather than foreign, but it does NOT delete-replace: see that predicate for
 * why staging-without-replacing is the repair, and why replacing would trade the
 * livelock for the destruction of a complete committed snapshot.
 *
 * The ingest schema bounds `dataRevision` at `MAX_SUPPORTED_DATA_REVISION`
 * (`@repo/api/src/types/agent-session`) so a malformed or hostile payload
 * cannot plant an unreachable high-water mark that permanently strands every
 * subsequent real revision as stale.
 *
 * Unchunked sessions carry no `chunk` marker (implicitly chunk 0 of 1): they
 * delete-replace AND commit in the same apply, exactly as before, and never
 * stage a pending marker.
 *
 * Pure (no DB) so the whole state machine is unit-testable without the sync
 * transaction.
 */

export type ChunkGatingInput = {
  /** Incoming payload's parser/data revision (`session.dataRevision`). */
  incomingRevision: number | null | undefined;
  /** Incoming chunk marker, absent for an unchunked whole-session payload. */
  chunk: { index: number; total: number } | null | undefined;
  /** The persisted row's committed revision, if the session already exists. */
  existingRevision: number | null | undefined;
  /** The staged in-progress sequence marker, if a chunked apply is mid-flight. */
  existingPendingRevision: number | null | undefined;
  /** The staged sequence's `chunk.total`; with the revision, its identity. */
  existingPendingTotal: number | null | undefined;
  existingPendingReceived: number | null | undefined;
};

/**
 * The staged pending-sequence columns to persist. An omitted field (absent key)
 * leaves the persisted value untouched; an explicit `null` clears it. Kept as a
 * discrete patch so the upsert spreads only the fields that change.
 */
export type PendingChunkPatch = {
  pendingChunkRevision?: number | null;
  pendingChunkTotal?: number | null;
  pendingChunkReceived?: number | null;
};

export type ChunkGatingDecision = {
  /**
   * True only for chunk 0 that opens a sequence carrying data the persisted
   * children do not already hold — fires the events delete-replace. FEA-3595:
   * that means the revision advances past the committed/pending high-water mark,
   * or equals the staged pending revision (a chunk-0 retry re-opening its own
   * interrupted sequence, whose partial rows must go). A revision below the
   * high-water mark never replaces; ISS-6167: neither does one EQUAL to the
   * committed revision, which stages a sequence without replacing.
   */
  shouldReplace: boolean;
  /**
   * FEA-3474: a non-first chunk that does NOT match the staged sequence's
   * identity — its revision or its `chunk.total` differs (reordered, re-chunked
   * by a re-prepared re-send, or no chunk 0 staged). Such a chunk must not touch
   * the live event or detail rows — appending its events would contaminate the
   * set the real sequence is assembling. The caller skips the entire per-session
   * apply when this is true.
   *
   * FEA-3595: a STALE payload — one below the committed/pending high-water mark
   * — is foreign in every shape, including unchunked and chunk 0, so an older
   * desktop cannot overwrite a newer cloud projection.
   */
  isForeignChunk: boolean;
  /**
   * Commit the incoming `dataRevision` on this apply. True for an unchunked
   * whole session that OPENS a sequence (see `shouldReplace`), or the LAST
   * chunk whose revision matches the staged marker AND whose sequence is
   * complete (every leading chunk arrived). A non-final chunk, a mismatched
   * last chunk, a last chunk with a gap, or any stale payload never commits.
   */
  shouldCommitRevision: boolean;
  /** The pending-sequence columns to stage / advance / clear on this apply. */
  pendingChunkPatch: PendingChunkPatch;
};

/**
 * Resolve the atomic chunk-revision gating decision for a single session apply.
 * See the module header for the full state machine.
 */
export function resolveChunkGating(
  input: ChunkGatingInput
): ChunkGatingDecision {
  const chunkIndex = input.chunk?.index ?? 0;
  const chunkTotal = input.chunk?.total ?? 1;
  const isFirstChunk = chunkIndex === 0;
  const isLastChunk = chunkIndex === chunkTotal - 1;
  const isUnchunked = isFirstChunk && isLastChunk;

  const { opensSequence, isStaleRevision, reopensCommittedSequence } =
    resolveRevisionStanding(input, isUnchunked);
  // Chunk 0 that opens a sequence: stages the marker, resets the contiguous
  // counter, and un-foreigns the chunks behind it.
  const startsSequence = opensSequence && isFirstChunk;
  // ISS-6167: STAGING and REPLACING are separate powers. A sequence re-opened at
  // the ALREADY-COMMITTED revision stages but must not replace — see
  // `reopensCommittedSequence`.
  const shouldReplace = startsSequence && !reopensCommittedSequence;

  // The revision this apply belongs to. Chunk 0 of a differing revision OPENS a
  // new sequence (its own revision); every later chunk is measured against the
  // marker chunk 0 staged.
  const stagedRevision = startsSequence
    ? (input.incomingRevision ?? null)
    : (input.existingPendingRevision ?? null);

  // FEA-3474: a non-first chunk that does not belong to the staged sequence is
  // FOREIGN. Unchunked payloads and chunk 0 are never foreign (chunk 0 opens its
  // own sequence). A non-first chunk belongs to the staged sequence only when
  // BOTH halves of the identity match — the revision AND the chunk count chunk 0
  // staged — which excludes the "no chunk 0 staged yet" case (staged is null), a
  // stale chunk from a superseded revision, and a reordered chunk.
  //
  // ISS-6166 review (wongk): the revision alone is NOT the identity. A re-send
  // re-prepared at a different chunking carries the same `dataRevision`, so
  // chunk 1-of-2 landing on a marker staged at 0-of-100 would satisfy
  // `receivedAfter >= chunkTotal` against its OWN smaller total and commit two
  // chunks' worth of events as a complete hundred-chunk `dataRevision` — the
  // half-session-masquerading-as-complete this gate exists to prevent. Judging
  // it against the staged total makes it foreign instead, and the re-send
  // repairs itself the ordinary way: its own chunk 0 re-stages the new total,
  // after which its tail matches.
  //
  // FEA-3595: a stale-revision payload (any shape) is also foreign — an older
  // desktop must not overwrite a newer cloud projection.
  const matchesStagedSequence =
    stagedRevision != null &&
    input.incomingRevision === stagedRevision &&
    input.existingPendingTotal === chunkTotal;
  // An unchunked payload is chunk 0 of 1, so `!isFirstChunk` already excludes
  // both shapes that open their own sequence.
  const isFollowingChunk = !isFirstChunk;
  const isForeignChunk =
    isStaleRevision || (isFollowingChunk && !matchesStagedSequence);

  // How many leading chunks of THIS sequence have now arrived (contiguous from
  // index 0). Chunk 0 resets it to 1; a contiguous next chunk advances it; a
  // replayed or out-of-order chunk leaves it unchanged (idempotent re-apply).
  const priorReceived = input.existingPendingReceived ?? 0;
  const receivedAfter = resolveReceivedAfter({
    isForeignChunk,
    startsSequence,
    isUnchunked,
    chunkIndex,
    priorReceived,
  });

  const sequenceComplete = receivedAfter >= chunkTotal;

  // Commit the incoming `dataRevision` only when this apply completes the
  // sequence it belongs to: an unchunked differing-revision whole session
  // commits directly; the LAST chunk commits iff it matches the staged sequence
  // identity (proving chunk 0 of THIS revision AND this chunking opened it) AND
  // every leading chunk arrived (no interior gap). A foreign chunk never commits.
  const shouldCommitRevision =
    !isForeignChunk &&
    input.incomingRevision != null &&
    isLastChunk &&
    (isUnchunked ? opensSequence : matchesStagedSequence && sequenceComplete);

  return {
    shouldReplace,
    isForeignChunk,
    shouldCommitRevision,
    pendingChunkPatch: resolvePendingChunkPatch({
      isForeignChunk,
      isUnchunked,
      startsSequence,
      shouldCommitRevision,
      incomingRevision: input.incomingRevision ?? null,
      chunkTotal,
      receivedAfter,
    }),
  };
}

/**
 * FEA-3595: where the incoming revision stands against everything this session
 * already has, committed or staged.
 *
 * `opensSequence` — this payload is entitled to delete-replace and start (or
 * restart) a sequence. True when it advances past the high-water mark, or when
 * it re-opens the sequence currently staged at its own revision (a chunk-0 retry
 * repairing an interrupted sequence). Never true for a stale payload.
 *
 * `isStaleRevision` — this payload is BELOW the high-water mark. Stale is
 * foreign in every shape, so an older desktop cannot overwrite a newer cloud
 * projection and a delayed mid-revision payload cannot wipe a newer staged
 * sequence.
 */
function resolveRevisionStanding(
  input: ChunkGatingInput,
  isUnchunked: boolean
): {
  opensSequence: boolean;
  isStaleRevision: boolean;
  reopensCommittedSequence: boolean;
} {
  const highWaterRevision = maxRevision(
    input.existingRevision,
    input.existingPendingRevision
  );
  const incoming = input.incomingRevision;

  const revisionAdvances =
    incoming != null &&
    (highWaterRevision == null || incoming > highWaterRevision);
  const isStaleRevision =
    incoming != null &&
    highWaterRevision != null &&
    incoming < highWaterRevision;
  const restartsStagedSequence =
    incoming != null &&
    input.existingPendingRevision != null &&
    incoming === input.existingPendingRevision;
  // ISS-6167: a CHUNKED re-send at the revision already COMMITTED opens a
  // sequence too. An unchunked equal-revision payload is a self-contained
  // idempotent no-op, but a chunked one is not deliverable in a single request:
  // with nothing staged, chunk 0 was accepted (chunk 0 is never foreign) while
  // staging no marker, so every later chunk read a null `stagedRevision` and
  // came back FOREIGN. The desktop saw "accepted but NOT persisted", discarded
  // the tail, and re-prepared from chunk 0 against the same revision — forever.
  //
  // Staging the marker is the whole repair: it un-foreigns the later chunks
  // while keeping gap detection and the all-or-nothing commit alive. The one
  // power it must NOT take is `shouldReplace`. This is the single case where the
  // persisted children ALREADY hold this exact revision — the cloud only ever
  // commits a revision from a COMPLETE sequence — so a delete-replace could not
  // remove a stale row (there are none at an unchanged revision), and would
  // instead destroy a complete committed snapshot the moment chunk 0 lands. The
  // revision stays committed while the children are partial, and read
  // projections do not gate on `pendingChunkRevision`, so an interrupted re-send
  // (client offline, quit) would leave a formerly-complete session exposed as a
  // partial one indefinitely (codex P1 on PR #4946). Events are upserted on
  // their conflict key, so the re-send restores byte-identical rows WITHOUT the
  // delete — the same treatment the UNCHUNKED equal-revision payload has always
  // had, rather than a strictly more destructive one for identical data.
  //
  // The tiling lane loses nothing by this: `persistSessionActivitySegments`
  // routes chunk 0 through the REPLACE lane on `chunk.index === 0`, not on
  // `shouldReplace`, which there gates only whether an explicitly-EMPTY chunk-0
  // slice may clear. Letting it clear would delete the stored tiling and leave
  // the later slices to hit `appendActivityTilingSlice`'s no-stored-tiling
  // guard, which skips them — losing the tiling AND its predecessor rather than
  // just re-deriving it (`main/sync/AGENTS.md` invariant 3).
  const reopensCommittedSequence =
    !isUnchunked &&
    incoming != null &&
    input.existingRevision != null &&
    incoming === input.existingRevision;

  return {
    opensSequence:
      (revisionAdvances ||
        restartsStagedSequence ||
        reopensCommittedSequence) &&
      !isStaleRevision,
    isStaleRevision,
    // A marker staged AT the committed revision can only have come from an
    // earlier re-open of this same kind — which never deleted — so a chunk-0
    // RESTART of it must not start deleting now either. The genuine FEA-3595
    // restart (pending ABOVE committed) never reaches here: its incoming
    // revision differs from the committed one, so the predicate is already false
    // and that arm keeps its delete-replace.
    reopensCommittedSequence: reopensCommittedSequence && !isStaleRevision,
  };
}

/**
 * FEA-3595: the forward-only bar — the highest revision this session has any
 * state for, committed or staged. `null` only when the session has neither.
 */
function maxRevision(
  committed: number | null | undefined,
  pending: number | null | undefined
): number | null {
  if (committed == null) {
    return pending ?? null;
  }
  if (pending == null) {
    return committed;
  }
  return Math.max(committed, pending);
}

/**
 * Advance the contiguous received-count for the staged sequence. A foreign
 * chunk leaves it untouched (it is not part of this sequence). Chunk 0 of a new
 * sequence resets it to 1. An in-sequence non-first chunk that is contiguous
 * with what has arrived (`index === priorReceived`) advances it by one; a
 * replay (`index < priorReceived`) or a gap (`index > priorReceived`) leaves it
 * unchanged, so a dropped interior chunk keeps the counter behind `total` and
 * blocks the commit.
 */
function resolveReceivedAfter(args: {
  isForeignChunk: boolean;
  startsSequence: boolean;
  isUnchunked: boolean;
  chunkIndex: number;
  priorReceived: number;
}): number {
  if (args.isUnchunked) {
    return 1;
  }
  if (args.isForeignChunk) {
    return args.priorReceived;
  }
  if (args.startsSequence) {
    return 1;
  }
  if (args.chunkIndex === args.priorReceived) {
    return args.priorReceived + 1;
  }
  return args.priorReceived;
}

/**
 * The pending-sequence columns to persist. Chunk 0 of a multi-chunk sequence
 * stages the marker; each in-sequence chunk advances the received-count; the
 * committing apply clears all three back to NULL; a foreign chunk or an interior
 * replay omits every field so the marker is left exactly as it was.
 */
function resolvePendingChunkPatch(args: {
  isForeignChunk: boolean;
  isUnchunked: boolean;
  startsSequence: boolean;
  shouldCommitRevision: boolean;
  incomingRevision: number | null;
  chunkTotal: number;
  receivedAfter: number;
}): PendingChunkPatch {
  // A foreign payload must not disturb the in-progress sequence's marker.
  // FEA-3595: this MUST be tested before the unchunked branch below. A stale
  // unchunked payload is foreign, and clearing on it would erase the marker of
  // the newer sequence still assembling — stranding its remaining chunks as
  // foreign no-ops, which is the failure this gate exists to prevent.
  if (args.isForeignChunk) {
    return {};
  }
  // A committing apply (unchunked, or the completing last chunk) clears the
  // staged sequence. A non-stale unchunked apply is never mid-sequence, so it
  // also clears (a no-op when already NULL).
  if (args.shouldCommitRevision || args.isUnchunked) {
    return {
      pendingChunkRevision: null,
      pendingChunkTotal: null,
      pendingChunkReceived: null,
    };
  }
  // Chunk 0 of a genuine multi-chunk sequence opens (or restarts) the marker.
  if (args.startsSequence) {
    return {
      pendingChunkRevision: args.incomingRevision,
      pendingChunkTotal: args.chunkTotal,
      pendingChunkReceived: args.receivedAfter,
    };
  }
  // An in-sequence non-first, non-final chunk advances only the received-count.
  return { pendingChunkReceived: args.receivedAfter };
}
