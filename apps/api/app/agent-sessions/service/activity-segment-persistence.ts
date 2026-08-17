import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import { log } from "@repo/observability/log";
import type { AgentSessionUpsertTx } from "./records";

/**
 * ISS-4541 / ISS-4578: chunk-aware persistence of a session's raw
 * activity-segment tiling (`session_activity_segments`), extracted from
 * `persist-session-children.ts` (shafty023 P3) so that file stays under the
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
 *     skipped upstream for a FOREIGN chunk (see `service.ts`), so an append only
 *     ever runs for a chunk that belongs to the sequence chunk 0 opened.
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
  shouldReplace = true
): Promise<void> {
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
    return;
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
      return;
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
    await replaceStoredActivityTiling(tx, artifactId, organizationId, rows);
    return;
  }

  // A later chunk of a paginated tiling: append this disjoint slice only.
  // `skipDuplicates` on the unique `(agentSessionId, startMs)` key makes a
  // re-send / overlapping chunk an idempotent no-op.
  await appendActivityTilingSlice(tx, artifactId, organizationId, rows);
}

/**
 * ISS-4578 (codex P1 / shafty023 P1): append one later-chunk slice, gated on the
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
 * So a later slice appends ONLY when its version matches the stored tiling's
 * version (what chunk 0 established). A version MISMATCH — older (superseded
 * re-delivery) or newer (a re-tile that never opened its own sequence) — is
 * skipped and logged; the session stays dirty on the desktop and the next
 * in-order chunk 0 of the correct version re-opens and repairs the tiling.
 */
async function appendActivityTilingSlice(
  tx: AgentSessionUpsertTx,
  artifactId: string,
  organizationId: string,
  rows: NonNullable<SyncedAgentSession["activitySegmentRows"]>
): Promise<void> {
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
  const incomingVersion = Math.max(...rows.map((row) => row.version));
  // If chunk 0 was never staged (no stored tiling), or the slice's version does
  // not match the stored tiling's version, this slice does not belong to the
  // sequence that owns the currently-stored rows — skip it rather than mixing
  // versions. (A missing stored tiling means chunk 0 hasn't landed yet; the
  // sequence self-repairs when it does.)
  if (!stored || incomingVersion !== stored.classifierVersion) {
    log.warn(
      "activity-segment append slice does not match the stored tiling classifier version; skipping to avoid a mixed-version tiling",
      {
        agentSessionId: artifactId,
        incomingVersion,
        storedVersion: stored?.classifierVersion ?? null,
      }
    );
    return;
  }
  await tx.agentSessionActivitySegment.createMany({
    data: rows.map((row) => toActivitySegmentCreateRow(artifactId, row)),
    skipDuplicates: true,
  });
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
): Promise<void> {
  if (rows.length > 0) {
    const incomingVersion = Math.max(...rows.map((row) => row.version));
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
      return;
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
    return;
  }
  await tx.agentSessionActivitySegment.createMany({
    data: rows.map((row) => toActivitySegmentCreateRow(artifactId, row)),
  });
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
