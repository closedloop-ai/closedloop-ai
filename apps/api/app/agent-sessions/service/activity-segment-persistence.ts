import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import { log } from "@repo/observability/log";
import type { AgentSessionUpsertTx } from "./records";
import { bindParameterChunkSize } from "./write-chunking";

/**
 * ISS-8185: bind parameters `agentSessionActivitySegment.createMany` emits per
 * row. Eleven: the nine mapped columns below, plus the `id` and `createdAt`
 * Prisma materializes client-side from their `@default(...)`s. Hand-maintained
 * against the model — widen it in the same change that adds a column, or the
 * derived chunk size stops bounding the statement.
 */
export const ACTIVITY_SEGMENT_BIND_PARAMETERS_PER_ROW = 11;

/** `createMany` binds nothing outside its per-row `VALUES` tuples. */
export const ACTIVITY_SEGMENT_FIXED_BIND_PARAMETERS = 0;

/**
 * ISS-4541 / ISS-4578: chunk-aware persistence of a session's raw
 * activity-segment tiling (`session_activity_segments`), extracted from
 * `persist-session-children.ts` (davetho P3) so that file stays under the
 * size ceiling and this cohesive concern — validation + replace/append
 * orchestration + row mapping for the activity lane — owns its own module. The
 * only route-facing entry point is `persistSessionActivitySegments`, called from
 * `persistSessionChildren`.
 */

type ActivityTilingValidation = { ok: true } | { ok: false; reason: string };

/**
 * A synced tiling is a set of half-open [startMs, endMs) spans with integer
 * bounds that, once sorted by startMs, do not overlap. Per-row bounds are already
 * enforced by the wire schema; this re-checks defensively and adds the cross-row
 * non-overlap invariant the schema can't express — so a corrupt tiling is
 * rejected (logged + skipped) rather than crashing `createMany` on the unique
 * (agent_session_id, start_ms) key. Non-overlap also guarantees distinct
 * startMs, which the unique key requires.
 */
function validateActivityTiling(
  rows: NonNullable<SyncedAgentSession["activitySegmentRows"]>
): ActivityTilingValidation {
  const sorted = [...rows].sort((left, right) => left.startMs - right.startMs);
  let previousEndMs = Number.NEGATIVE_INFINITY;
  for (const row of sorted) {
    if (
      !(Number.isInteger(row.startMs) && Number.isInteger(row.endMs)) ||
      row.startMs < 0 ||
      row.endMs <= row.startMs
    ) {
      return { ok: false, reason: "segment_bounds_invalid" };
    }
    if (row.startMs < previousEndMs) {
      return { ok: false, reason: "segment_overlap" };
    }
    previousEndMs = row.endMs;
  }
  return { ok: true };
}

/**
 * FEA-3568 (PLN-1398 T3): persist a session's raw activity-segment tiling
 * (`session_lis`) replicated from the desktop. Additive + optional:
 *   - field ABSENT (older desktop build) or an explicit EMPTY array -> no
 *     rows to write. Previously persisted segments are left untouched EXCEPT on
 *     an opening chunk (`shouldReplace`) of an advancing revision, which
 *     clears the stale tiling even when its own slice is empty (see below).
 *     The desktop omits the field for a segment-less session and never emits
 *     `[]`, so an empty payload otherwise only ever arrives as a
 *     stale/degenerate re-delivery — and it carries no classifier version to
 *     attest against the stored tiling, so honoring it as a wipe on a
 *     non-opening apply could only ever downgrade a newer persisted tiling
 *     out-of-order. Treated as "no replacement data", never a clear.
 *   - field PRESENT with rows -> validate tiling sanity (a disjoint slice of a
 *     valid tiling is itself a valid non-overlapping tiling, so per-chunk
 *     validation holds), then persist chunk-aware:
 *
 * ISS-4541 — MULTI-PART (chunked) tiling. An oversized session's tiling is
 * PAGINATED across chunks by the desktop (`chunkOversizedSession`), each chunk
 * carrying a DISJOINT slice of `activitySegmentRows`, so the full tiling reaches
 * the cloud instead of being truncated to a single payload. The chunks arrive as
 * separate transactions; the caller's `resolveChunkGating` decision (`shouldReplace`
 * = chunk 0 of an advancing revision) drives this:
 *   - `shouldReplace` (chunk 0, or an unchunked whole session): REPLACE-ALL —
 *     delete the stored tiling (even when this chunk's own slice is empty, so a
 *     prior revision's segments never survive under a newer sequence), then
 *     insert this chunk's slice. A `classifierVersion >= stored` guard is
 *     defense-in-depth against an out-of-order / stale re-delivery downgrading a
 *     newer tiling.
 *   - a LATER chunk (`!shouldReplace`): APPEND this slice with `skipDuplicates`,
 *     never delete. `skipDuplicates` on the unique `(agentSessionId, startMs)`
 *     key makes re-send + chunk overlap an idempotent no-op, mirroring the
 *     `agent_session_token_events` append lane. The whole per-session apply is
 *     skipped upstream for a FOREIGN chunk (`resolveGateRefusal` in
 *     `session-slice-gating.ts`), so an append only ever runs for a chunk that
 *     belongs to the sequence chunk 0 opened — which is what lets the append
 *     lane admit a slice with nothing stored yet (ISS-10259).
 *
 * Backward compatibility (version skew, both directions):
 *   - OLD desktop replicates the FULL tiling into every chunk (it rode
 *     `...session`). New receiver: chunk 0 replace+insert the full tiling; each
 *     later chunk appends the SAME full tiling with `skipDuplicates`, which all
 *     collide on `startMs` and no-op. Still exactly-once and idempotent.
 *   - NEW desktop only paginates the tiling across chunks after the server
 *     advertised `agentSessionSyncActivityChunking`; against an OLD server it
 *     keeps the full tiling in the base payload, so this receiver change is not
 *     required for an old desktop to keep working.
 *
 * Sanity or stale-version rejection drops ONLY this session's segment set (logged
 * with session id + reason, then skipped), never the batch (the FEA-3267 lesson:
 * one bad session must not fail the whole upsert). The row set is not silently
 * dropped — it is logged, and the session stays dirty on the desktop for retry
 * after the next re-derivation.
 */
export async function persistSessionActivitySegments(
  tx: AgentSessionUpsertTx,
  artifactId: string,
  organizationId: string,
  session: SyncedAgentSession,
  // ISS-4541: chunk-0-of-an-advancing-revision signal from `resolveChunkGating`.
  // Optional/defaulted so the pre-ISS-4541 whole-session callers (and tests) keep
  // the REPLACE-ALL behavior: an unchunked whole session is `shouldReplace = true`.
  shouldReplace = true,
  // ISS-8603: the append lane's refusal is REPORTED here rather than through
  // the return value, which already conflates all three no-write paths and so
  // cannot name the one — or, with the reason, the arm — the counter describes.
  // Optional so every caller that only wants the persisted/not answer stays
  // unchanged.
  skips?: ActivityTilingSkipReport
  // ISS-7265: `true` only when segment rows were actually WRITTEN. Three paths
  // below carry rows on the wire and persist none of them (sanity reject, stale
  // classifier replace, append-lane version mismatch), and the tiling-strip
  // column may not read "the tiling arrived" off a payload whose rows this
  // module then threw away.
): Promise<boolean> {
  // Org isolation (apps/api/AGENTS.md "Org scoping"). JOIN-REACHED child table —
  // org lives on the parent `artifacts` row via `session -> artifact`. The
  // stale-version `findFirst` read and the replace-all `deleteMany` both scope
  // through `session.artifact.organizationId` in-query, so a cross-org
  // artifactId reads/deletes nothing. The final `createMany` has no WHERE to
  // constrain and relies on the caller's single ownership proof (artifactId
  // reaches this helper already proven owned by organizationId), matching the
  // token-usage/event write lanes in persistSessionChildren.
  // ISS-4578 (codex P1): distinguish ABSENT (`activitySegmentRows` key omitted)
  // from an EXPLICIT empty array. The desktop chunker paginates events,
  // tokenEvents and the tiling as SEPARATE streams, so an events-only chunk 0 of
  // a multi-part sequence carries NO `activitySegmentRows` key at all (the base
  // is built from `...session`, and sync-source omits the field for a
  // segment-less base). Collapsing ABSENT -> `[]` with `?? []` and then running
  // the multi-part opening delete below would WIPE the session's stored tiling
  // whenever a non-tiling stream is what forced the chunking — pure data loss.
  // Only an EXPLICIT `[]` (which `chunkOversizedSession.baseFor` stamps on a
  // PAGINATED chunk 0 whose tiling rides its own later chunks) may clear on an
  // opening chunk; an absent field is always "leave the stored tiling untouched"
  // (the AGENTS.md version-skew safe default).
  const tilingFieldPresent = session.activitySegmentRows != null;
  const rows = session.activitySegmentRows ?? [];
  // ISS-4541: is this the OPENING chunk of a genuinely MULTI-PART sequence
  // (chunk 0 of total > 1) that CARRIES the tiling stream (field present)? Only
  // then may an empty slice still run below, to clear the prior revision's tiling
  // before its own (possibly-later) segment chunks append. An UNCHUNKED whole
  // session (no `chunk` marker, or total 1) with an empty tiling must preserve
  // the pre-ISS-4541 "omission/empty never wipes" contract — an empty payload
  // carries no classifier version to attest, so honoring it as a clear could only
  // downgrade a newer persisted tiling. And a multi-part chunk that OMITS the
  // field entirely (an events/tokenEvents chunk) must never clear the tiling.
  const isMultiPartOpening =
    shouldReplace && tilingFieldPresent && (session.chunk?.total ?? 1) > 1;
  if (rows.length === 0 && !isMultiPartOpening) {
    return false;
  }

  if (rows.length > 0) {
    const sanity = validateActivityTiling(rows);
    if (!sanity.ok) {
      log.warn(
        "activity-segment tiling failed sanity validation; skipping segment persistence for this session",
        {
          agentSessionId: artifactId,
          reason: sanity.reason,
          rowCount: rows.length,
        }
      );
      return false;
    }
  }

  // ISS-4578: the APPEND lane belongs ONLY to a genuine LATER chunk of a
  // multi-part sequence (`chunk.index > 0`). `shouldReplace` (from the
  // events-lane `resolveChunkGating`) keys on `dataRevision`, which is a
  // DIFFERENT lifecycle from the tiling's `classifierVersion`: an unchunked
  // whole session whose revision merely equals the committed one — or that
  // carries NO `dataRevision` at all (an older desktop / first backfill sync) —
  // gets `shouldReplace = false`, yet it is NOT a later chunk and its tiling
  // must still be persisted. Routing it through the append lane finds no stored
  // version (`storedVersion: null`) and silently drops the ENTIRE tiling — pure
  // data loss. So a payload that is not a later chunk always REPLACE-alls; the
  // stale/older-version protection lives inside `replaceStoredActivityTiling`'s
  // own `classifierVersion` guard, not in the events-lane revision decision.
  const isLaterChunk = (session.chunk?.index ?? 0) > 0;
  if (!isLaterChunk) {
    return await replaceStoredActivityTiling(
      tx,
      artifactId,
      organizationId,
      rows
    );
  }

  // A later chunk of a paginated tiling: append this disjoint slice only.
  // `skipDuplicates` on the unique `(agentSessionId, startMs)` key makes a
  // re-send / overlapping chunk an idempotent no-op.
  return await appendActivityTilingSlice(
    tx,
    artifactId,
    organizationId,
    rows,
    skips
  );
}

/**
 * ISS-4578 (codex P1 / davetho P1): append one later-chunk slice, gated on the
 * stored tiling's classifier version so the append lane cannot mix versions.
 *
 * The chunk-sequence gate (`resolveChunkGating`) keys on `dataRevision`, but the
 * activity tiling has its OWN `classifierVersion` lifecycle (a classifier
 * backfill re-tiles without advancing `DATA_REVISION`). Without this guard, two
 * failure modes leak in:
 *   - codex pM6VI3Of: when a chunk-0 REPLACE rejects a stale older tiling, its
 *     later slices 1..N are NOT foreign to `resolveChunkGating` (same
 *     `dataRevision` as the staged marker), so they would `createMany` anyway —
 *     leaving the newer tiling PLUS the stale slices, mixed versions, overlapping
 *     spans that double-count in the per-phase aggregation.
 *   - a slice from a DIFFERENT classifier version than the one chunk 0 opened
 *     (a re-tile that raced the sequence) would interleave two tilings.
 *
 * So a later slice is REFUSED exactly when a STORED tiling disagrees with
 * it. A version MISMATCH — older (superseded re-delivery) or newer (a
 * re-tile that never opened its own sequence) — is skipped and logged; the
 * session stays dirty on the desktop and the next in-order chunk 0 of the
 * correct version re-opens and repairs the tiling.
 *
 * ISS-10259: an EMPTY stored tiling is not a third failure mode, it is the
 * ordinary shape of a paginated sequence mid-flight, and refusing it dropped
 * every such tiling permanently. See the guard below.
 */
async function appendActivityTilingSlice(
  tx: AgentSessionUpsertTx,
  artifactId: string,
  organizationId: string,
  rows: NonNullable<SyncedAgentSession["activitySegmentRows"]>,
  skips?: ActivityTilingSkipReport
): Promise<boolean> {
  const stored = await tx.agentSessionActivitySegment.findFirst({
    where: {
      agentSessionId: artifactId,
      // Org-scope the version read through the parent artifact so a cross-org
      // artifactId can never observe another tenant's stored tiling version.
      session: { artifact: { organizationId } },
    },
    select: { classifierVersion: true },
    orderBy: { classifierVersion: "desc" },
  });
  const incomingVersion = maxClassifierVersion(rows);
  // A slice whose version disagrees with the STORED tiling belongs to a
  // different sequence than the one that owns the currently-stored rows — skip
  // it rather than mixing versions.
  //
  // ISS-10259: NO stored tiling is not that case, and refusing it was a
  // permanent data-loss defect. A later chunk reaches this lane only after
  // `resolveChunkGating` matched it against the marker chunk 0 STAGED — one
  // arriving with no sequence staged is FOREIGN and `resolveGateRefusal`
  // returns before any write (`chunk-revision-gating.test.ts`, "flags a
  // non-first chunk when no sequence is staged"). Precisely: reaching here
  // proves chunk 0 staged a marker on the row the PRE-UPSERT READ saw — not
  // that chunk 0's rows are on the artifact being written. So the ORDINARY
  // reading of an empty stored tiling here is not "chunk 0 is still in flight"
  // but "chunk 0 opened the sequence and stored nothing": when the desktop
  // paginates the
  // tiling the other streams pack first (`appendRequiredStreamChunks`) and
  // `createChunkBuilders.baseFor` stamps an explicit `activitySegmentRows: []`
  // on every non-tiling chunk, so chunk 0 clears and inserts none. Every one of
  // the tiling's own slices then found nothing to attest against and was
  // dropped, and the redelivery meant to repair it reproduced the same empty
  // chunk 0 — 78 of 85 affected sessions still had zero stored segments a
  // fortnight on. This slice IS the sequence's first tiling rows; the ones
  // behind it attest against the version it establishes here.
  //
  // TWO narrower shapes also land here with nothing stored, and both are
  // ADMITTED deliberately.
  //
  // The FIRST is a slice of this sequence that `validateActivityTiling` rejected
  // (its own `log.warn`): the ones after it append without it, so the tiling is
  // short by that slice. Refusing them would cost the whole tiling to protect
  // one slice.
  //
  // The SECOND is the ISS-8604 create-arm race — a sweep commits between the
  // gate's read and the upsert, so `writeSessionDetail` mints a fresh artifact
  // and chunk 0's rows stay on the swept one. This one is NOT "short by a
  // slice" (review, davetho): the arriving chunk is the only one that ever
  // reaches the new artifact, so the stored tiling can be as little as the
  // final slice. Admitted anyway, because refusing here protects nothing and
  // heals nothing:
  //   - the SAME race already gives that artifact only this chunk's EVENTS, so
  //     a refusal buys a tiling-less row beside a one-chunk event set rather
  //     than a correct session;
  //   - it cannot make the desktop re-prepare. `upsertSessionSlice` returns
  //     `persisted: true` whatever this lane decides — nothing reads
  //     `ActivityTilingSkipReport` but the ISS-8603 metric — so the session is
  //     echoed in `persistedSessionIds` and the outbox row clears either way;
  //   - and the row is born honest about it: `resolveCreateArmChunkColumns`
  //     re-gates the chunk against no stored sequence, so it commits no
  //     `dataRevision` and stages no marker.
  // Withholding the ACK is what would make that path retry from chunk 0, and
  // that is ISS-8604's contract over every column the race touches, not this
  // lane's to decide one column at a time. Pinned end to end against real
  // Postgres in `session-create-arm-race.integration.test.ts`.
  //
  // One property this DOES spend: the `findFirst` above is org-scoped while the
  // `createMany` below is not (it rests on the caller's ownership proof — see
  // the note on `persistSessionActivitySegments`). A null from that scoped read
  // used to fail CLOSED; it now falls through to the write. Unreachable today,
  // since `artifactId` arrives already proven owned, but it is no longer a
  // second line of defence and should not be counted as one.
  if (stored && incomingVersion !== stored.classifierVersion) {
    // ISS-8603: set INSIDE the refused branch, so the counter measures slices
    // this lane actually threw away rather than appends it merely considered.
    if (skips) {
      skips.refusalReason = ActivityTilingSkipReason.VersionMismatch;
    }
    log.warn(
      "activity-segment append slice does not match the stored tiling classifier version; skipping to avoid a mixed-version tiling",
      {
        agentSessionId: artifactId,
        incomingVersion,
        storedVersion: stored.classifierVersion,
      }
    );
    return false;
  }
  await createActivitySegmentRows(tx, artifactId, rows, {
    skipDuplicates: true,
  });
  return true;
}

/**
 * ISS-4541: REPLACE-ALL the stored tiling for an opening chunk (chunk 0 of an
 * advancing revision, or an unchunked whole session), atomic within the session
 * upsert transaction so no reader ever sees a partial or mixed-version tiling.
 * The delete fires even when `rows` is empty, so a prior revision's segments
 * never survive under a newer sequence that happens to open on an empty slice.
 */
async function replaceStoredActivityTiling(
  tx: AgentSessionUpsertTx,
  artifactId: string,
  organizationId: string,
  rows: NonNullable<SyncedAgentSession["activitySegmentRows"]>
): Promise<boolean> {
  if (rows.length > 0) {
    const incomingVersion = maxClassifierVersion(rows);
    const stored = await tx.agentSessionActivitySegment.findFirst({
      where: {
        agentSessionId: artifactId,
        // Org-scope the version read through the parent artifact so a cross-org
        // artifactId can never observe another tenant's stored tiling version.
        session: { artifact: { organizationId } },
      },
      select: { classifierVersion: true },
      orderBy: { classifierVersion: "desc" },
    });
    if (stored && incomingVersion < stored.classifierVersion) {
      log.warn(
        "activity-segment tiling is older than the stored tiling; skipping stale replace",
        {
          agentSessionId: artifactId,
          incomingVersion,
          storedVersion: stored.classifierVersion,
        }
      );
      return false;
    }
  }

  await tx.agentSessionActivitySegment.deleteMany({
    where: {
      agentSessionId: artifactId,
      // Org-scope the destructive replace-all delete through the parent artifact
      // so a cross-org artifactId can never wipe another tenant's segments.
      session: { artifact: { organizationId } },
    },
  });
  if (rows.length === 0) {
    return false;
  }
  await createActivitySegmentRows(tx, artifactId, rows, {});
  return true;
}

/**
 * ISS-8185: insert a tiling across as many statements as PostgreSQL's
 * bind-parameter ceiling allows, instead of one statement whose width is the
 * payload's. ISS-8051 removed the receive-side `.max()` that used to bound
 * `activitySegmentRows`, and an over-wide statement is rejected outright — the
 * session transaction rolls back and the desktop retries the identical payload
 * forever. Every row still lands, and the loop runs inside the caller's
 * session-upsert transaction, so a chunk that fails rolls the whole tiling back
 * rather than leaving a partial one visible — the property
 * `replaceStoredActivityTiling`'s delete-then-insert already depends on.
 *
 * Chunking is otherwise semantically free here: the rows are non-overlapping by
 * `validateActivityTiling`, so their `(agentSessionId, startMs)` unique keys are
 * distinct and no chunk can collide with another's.
 */
async function createActivitySegmentRows(
  tx: AgentSessionUpsertTx,
  artifactId: string,
  rows: NonNullable<SyncedAgentSession["activitySegmentRows"]>,
  // Spread rather than always passed: the replace lane omits the flag entirely
  // and only the append lane sets it, which is the distinction the suites
  // pinning these two writes read off the call.
  options: { skipDuplicates?: true }
): Promise<void> {
  const chunkSize = bindParameterChunkSize(
    ACTIVITY_SEGMENT_BIND_PARAMETERS_PER_ROW,
    ACTIVITY_SEGMENT_FIXED_BIND_PARAMETERS
  );
  for (let start = 0; start < rows.length; start += chunkSize) {
    await tx.agentSessionActivitySegment.createMany({
      data: rows
        .slice(start, start + chunkSize)
        .map((row) => toActivitySegmentCreateRow(artifactId, row)),
      ...options,
    });
  }
}

/** Map one wire activity-segment row to its persisted create shape. */
function toActivitySegmentCreateRow(
  artifactId: string,
  row: NonNullable<SyncedAgentSession["activitySegmentRows"]>[number]
) {
  return {
    agentSessionId: artifactId,
    phase: row.phase,
    startMs: BigInt(row.startMs),
    endMs: BigInt(row.endMs),
    confidence: row.confidence,
    evidenceLayers: row.evidenceLayers,
    classifierVersion: row.version,
    workItemRef: row.workItemRef ?? null,
    subagentId: row.subagentId ?? null,
  };
}

/**
 * The highest `classifierVersion` across a wire tiling slice.
 *
 * ISS-8330: this was `Math.max(...rows.map((row) => row.version))`. The spread
 * passes one argument per row, and the request byte ceiling
 * (`SYNC_DECOMPRESSED_BYTE_CEILING`) admits ~180k near-identical rows — well
 * past the argument limit, where the spread throws `RangeError: Maximum call
 * stack size exceeded`. That throw escapes `withDb.tx`, and because it is
 * deterministic the session re-throws it on every retry. ISS-8051 removed the
 * `.max()` on this array on purpose, so the bound belongs here, at the fold.
 *
 * Seeded at `-Infinity` to match `Math.max()` exactly on an empty array. No
 * caller reaches either site with an empty `rows` today — `shouldReplace`
 * implies chunk 0, which routes to the replace lane, whose own call is inside
 * `rows.length > 0` — so this is parity kept deliberately rather than a
 * reachable case.
 */
function maxClassifierVersion(
  rows: NonNullable<SyncedAgentSession["activitySegmentRows"]>
): number {
  let max = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    if (row.version > max) {
      max = row.version;
    }
  }
  return max;
}

/**
 * ISS-8603: why the append lane refused a later chunk's tiling slice.
 *
 * ONE arm: a stored tiling EXISTS at another version — a re-tile raced the
 * sequence, or chunk 0 was refused as stale and its later slices arrived
 * anyway.
 *
 * ISS-10259 retired the second, `no_stored_tiling`. It read an EMPTY stored
 * tiling as "chunk 0 has not landed", which the sequence gate makes
 * unreachable; what it actually caught was the ordinary shape of a paginated
 * tiling between its opening chunk and its first slice, and refusing that
 * dropped the whole tiling. The append lane admits it now, so no producer of
 * that reason is left and a facet nothing can emit is one a monitor would read
 * as a clean signal.
 *
 * A reason facet rather than a second metric, on the `SentinelRevisionHeld`
 * precedent — one member, one emission per reason per batch, each carrying a
 * scalar `count` a generator can read.
 */
export const ActivityTilingSkipReason = {
  VersionMismatch: "version_mismatch",
} as const;

export type ActivityTilingSkipReason =
  (typeof ActivityTilingSkipReason)[keyof typeof ActivityTilingSkipReason];

/**
 * ISS-8603: one slice's activity-tiling refusal, filled in by the persistence
 * lane and read by its caller.
 *
 * Mutable and passed down rather than returned, on the
 * `persistSessionAnalytics(..., unstorableCounterFields)` precedent in the same
 * call chain: the boolean this module returns answers "were rows written", and
 * widening it into a result object would rewrite that contract for every caller
 * that only ever wanted the write answer.
 *
 * ONE reason, not a list: exactly one append lane runs per slice, so a second
 * refusal for the same session is not reachable. The batch sums one per session
 * per reason.
 */
export type ActivityTilingSkipReport = {
  /** `null` until the append lane refuses this slice. */
  refusalReason: ActivityTilingSkipReason | null;
};
