/**
 * @file soak-cloud-content.ts
 * @description ISS-6099 — the CONTENT half of the mock cloud's bookkeeping.
 *
 * Before this module the mock retained envelope metadata only
 * (`externalSessionId`, chunk index/total, dataRevision, encoding, batchId), so
 * every number the soak produced measured correctly-identified ENVELOPES
 * arriving. It could not tell a session whose events/agents/tokenEvents/
 * activity segments survived the trip from one that arrived as a husk — which
 * is exactly the shape of this repo's documented `.strict()` boundary-schema
 * trap, where a producer emits a field the boundary rejects and the whole unit
 * is silently dropped and re-dropped on every retry.
 *
 * ## What is retained, and the bound
 *
 * Retention is deliberately O(1) per session, NOT a copy of the 2.1 GB corpus:
 *
 *  - **Per delivered session:** relation counts, a content digest, byte size,
 *    delivery count. ~250 B × ~3,000 sessions ≈ 0.75 MB.
 *  - **Per in-flight chunk sequence:** one 64-char digest per chunk index plus
 *    accumulated counts — chunk BODIES are never held on this path. Released
 *    the moment the sequence assembles.
 *  - **Read-back sample:** full assembled bodies for the first
 *    {@link READBACK_SAMPLE_SESSIONS} sessions, hard-capped at
 *    {@link READBACK_SAMPLE_MAX_BYTES} in total.
 *
 * Ceiling ≈ 10 MiB. A harness that OOMs is not an improvement on a harness that
 * measures the wrong thing.
 *
 * ## Why fidelity is asserted against the SERIALIZED payload, not re-derived SQL
 *
 * ISS-6099 asks for "counts per relation … against the local source". A literal
 * reading — re-run the producer's queries in SQL and demand equality — would be
 * a false-alarm generator, because the payload builder applies documented caps
 * and slices on the way out (`eventRowCap`, `MAX_SYNCED_ARTIFACT_REFS_PRODUCER`,
 * `MAX_SYNCED_SESSION_PR_REFS_PRODUCER`, `SESSION_TRACE_SOURCE_LIMITS`,
 * `ACTIVITY_SEGMENT_SYNC_MAX_ROWS`). A cap is not a drop, and an oracle that
 * cannot tell them apart is worse than no oracle.
 *
 * So fidelity is asserted two ways, both of which a cap can never trip:
 *
 *  1. **Transport fidelity** (this module): the delivered content must be
 *     internally coherent — required schema fields present, chunk sequences
 *     contiguous and total-consistent, and the same (session, dataRevision)
 *     delivered twice must hash identically. A retry that silently drops a
 *     field diverges here.
 *  2. **Cap-safe local cross-check** (`soak-cycle-record.ts`): a session the
 *     local DB says HAS events must not arrive carrying zero of them. One-
 *     directional and therefore cap-proof: no cap turns a non-empty relation
 *     into an empty one.
 */

import { createHash } from "node:crypto";

/**
 * Relation arrays the producer PARTITIONS across a chunk sequence: each chunk
 * carries a disjoint slice, so the assembled session's count is the SUM.
 *
 * `chunkOversizedSession` streams exactly these — `buildEventChunk`,
 * `buildTokenEventChunk` and `buildActivitySegmentChunk` each emit one slice and
 * zero the others. `activitySegmentRows` is only paginated when the server
 * advertises `agentSessionSyncActivityChunking`, which this mock ALWAYS
 * negotiates (see the capability list in `mock-cloud-server.ts`), so under the
 * harness it is genuinely partitioned; were it not, the base would carry the
 * whole tiling on every chunk and belong in the replicated set below.
 */
const PARTITIONED_RELATION_FIELDS = [
  "events",
  "tokenEvents",
  "activitySegmentRows",
] as const;

/**
 * Relation arrays the producer REPLICATES onto every chunk. `baseFor` spreads
 * the whole session into each chunk and overrides only the partitioned streams,
 * so these arrive complete on chunk 0 and again on every chunk after it.
 *
 * They must therefore be counted ONCE, not summed: adding them per chunk
 * multiplies the reported count by the chunk total, and a read-back metric that
 * reports 12 agents for a 12-chunk session with one agent is exactly the
 * lying-number defect this harness exists to remove.
 */
const REPLICATED_RELATION_FIELDS = [
  "agents",
  "tokenUsageByModel",
  "activityBuckets",
  "prs",
] as const;

/** Relation arrays counted on every delivered session payload. */
const RELATION_FIELDS = [
  ...PARTITIONED_RELATION_FIELDS,
  ...REPLICATED_RELATION_FIELDS,
] as const;

/** Fields the sync contract requires on every session; absence is a drop. */
const REQUIRED_SESSION_FIELDS = [
  "externalSessionId",
  "status",
  "startedAt",
  "updatedAt",
] as const;

/**
 * The relation arrays production's ingest schema declares WITHOUT `.optional()`
 * / `.nullish()` (`desktopAgentSessionsPayloadObjectSchema` →
 * `syncedAgentSessionSchema`: `agents`, `events`, `tokenUsageByModel`). Every
 * chunk carries them too — `chunkOversizedSession` builds each chunk by
 * spreading the whole session — so absence is checkable on every receive.
 *
 * Absence and emptiness are DIFFERENT facts and this module must not conflate
 * them: an empty array is a legitimate session with nothing of that kind, while
 * an absent key is a producer regression that production rejects outright. The
 * remaining relation fields (`tokenEvents`, `activityBuckets`,
 * `activitySegmentRows`, `prs`) ARE optional upstream, so their absence is not a
 * violation and they are deliberately not listed here.
 */
const REQUIRED_RELATION_FIELDS = [
  "agents",
  "events",
  "tokenUsageByModel",
] as const;

/** Full assembled bodies retained for the read-back pass. */
export const READBACK_SAMPLE_SESSIONS = 25;
/** Hard byte ceiling on the read-back sample, whatever the session sizes. */
export const READBACK_SAMPLE_MAX_BYTES = 8 * 1024 * 1024;
/**
 * Ceiling on concurrently-tracked incomplete chunk sequences. Far above the
 * sender's real in-flight concurrency; it exists so an abandoned sequence
 * cannot accumulate without bound across a multi-hour battery.
 */
export const MAX_TRACKED_CHUNK_SEQUENCES = 2048;
/**
 * Violation records carried on the read-back response. The exact COUNT is
 * always reported, so truncating the list can never make a cycle look cleaner
 * than it was — it only bounds the forensic detail.
 */
export const READBACK_MAX_VIOLATIONS = 200;

export type RelationCounts = Record<(typeof RELATION_FIELDS)[number], number>;

/** What the cloud retained about one fully-delivered (assembled) session. */
export type DeliveredSessionContent = {
  externalSessionId: string;
  dataRevision: number | null;
  chunkTotal: number | null;
  relations: RelationCounts;
  metadataKeys: number;
  /**
   * sha256 over the delivered content. Order-sensitive by design: both sides
   * are the same producer, so this is a CHANGE detector across deliveries and
   * across the chunk boundary, not a semantic-equality proof.
   */
  contentDigest: string;
  payloadBytes: number;
  deliveries: number;
};

export type ContentViolation = {
  externalSessionId: string;
  kind: ContentViolationKind;
  detail: string;
};

export const ContentViolationKind = {
  MissingRequiredField: "missing_required_field",
  /**
   * A relation array production requires was ABSENT (not merely empty). Kept
   * distinct from {@link ContentViolationKind.MissingRequiredField} because the
   * failure it catches is the payload BUILDER dropping a section, which arrives
   * with every scalar field intact and would otherwise score as clean.
   */
  MissingRequiredRelation: "missing_required_relation",
  ChunkIndexOutOfRange: "chunk_index_out_of_range",
  /** The same chunk index arrived twice carrying DIFFERENT content. */
  ChunkDuplicateIndex: "chunk_duplicate_index",
  ChunkTotalConflict: "chunk_total_conflict",
  /**
   * `chunk.total` was not a usable part count (non-integer, `NaN`, or <= 0).
   * Distinct from {@link ContentViolationKind.ChunkTotalConflict}, which is two
   * DIFFERENT valid totals for one revision.
   */
  ChunkTotalInvalid: "chunk_total_invalid",
  /**
   * `dataRevision` was present but not a usable revision. Production bounds it
   * with `.int().min(1).max(MAX_SUPPORTED_DATA_REVISION)`, and a `NaN` here is
   * worse than a wrong number: it makes the redelivery digest comparison, which
   * is keyed on revision equality, permanently unable to fire.
   */
  DataRevisionInvalid: "data_revision_invalid",
  /**
   * A relation the producer replicates onto every chunk reported a DIFFERENT
   * count on a later chunk of the same sequence.
   */
  ReplicatedRelationDivergence: "replicated_relation_divergence",
  DigestDivergence: "digest_divergence",
  ChunkTrackingOverflow: "chunk_tracking_overflow",
  /** The batch declared a wire schema version the mock did not expect. */
  SchemaVersionMismatch: "schema_version_mismatch",
  /**
   * The batch's `sessionCount` did not describe the sessions it carried.
   *
   * The value mirrors production's `session_count_mismatch` reason
   * (`summarizeParseIssues` in `apps/api/lib/desktop-agent-sessions-parse-guards.ts`,
   * raised by the `superRefine` on `desktopAgentSessionsPayloadSchema`). That
   * reason is a bare literal inside an `apps/api` mapper with no exported
   * constant to import, and the desktop harness does not depend on `apps/api`;
   * declaring it here as a named member is what keeps call sites and tests off
   * a re-spelled string.
   */
  SessionCountMismatch: "session_count_mismatch",
  /** Counted as delivered by the envelope path, absent from the read-back. */
  MissingFromReadBack: "missing_from_read_back",
} as const;
export type ContentViolationKind =
  (typeof ContentViolationKind)[keyof typeof ContentViolationKind];

/** One entry of the read-back corpus the mock serves back to the harness. */
export type ReadBackEntry = {
  externalSessionId: string;
  contentDigest: string;
  relations: RelationCounts;
  metadataKeys: number;
  payloadBytes: number;
  deliveries: number;
};

export type ReadBackResponse = {
  /** One entry per session with at least one complete delivery. */
  index: ReadBackEntry[];
  /**
   * What the cloud found wrong with what it was given. Carried on the read-back
   * rather than only in the mock's memory, so the scoring pass reads violations
   * across the same boundary it reads the corpus across.
   */
  violations: ContentViolation[];
  /** Exact total, even when `violations` was truncated to the cap. */
  violationCount: number;
  /** Full assembled bodies, bounded by the sample caps. */
  sample: { externalSessionId: string; session: unknown }[];
  sampleBytes: number;
  /** True once a sample cap stopped further bodies being retained. */
  sampleTruncated: boolean;
};

type ChunkAccumulator = {
  total: number;
  /** index -> per-chunk digest. Chunk BODIES are not held here. */
  chunkDigests: Map<number, string>;
  relations: RelationCounts;
  /**
   * False until a chunk has established the REPLICATED relation counts. They are
   * taken from the first chunk to arrive and then only checked, never re-added.
   */
  replicatedSeen: boolean;
  metadataKeys: number;
  payloadBytes: number;
  /** Retained ONLY while this session is inside the read-back sample. */
  sampleParts: Map<number, unknown> | null;
};

export type ContentState = {
  delivered: Map<string, DeliveredSessionContent>;
  /**
   * Retained violation RECORDS, hard-capped at {@link READBACK_MAX_VIOLATIONS}
   * as they are recorded. The cap has to bind here rather than at serialization:
   * a retry storm records violations for the whole cycle, and a list that only
   * gets trimmed on the way out has already held every one of them in memory.
   */
  violations: ContentViolation[];
  /** Exact number recorded, including those the cap refused to retain. */
  violationCount: number;
  accumulators: Map<string, ChunkAccumulator>;
  /** `${id}#${dataRevision}` -> the chunk total first seen for it. */
  declaredTotals: Map<string, number>;
  sampleBodies: Map<string, unknown>;
  sampleBytes: number;
  /**
   * Sample slots RESERVED by chunk sequences that are still assembling, and the
   * bytes they are already holding.
   *
   * Without these the caps would bind only at COMPLETION time: every concurrent
   * chunk sequence opened while fewer than {@link READBACK_SAMPLE_SESSIONS}
   * sessions had *finished* would independently see a free slot and start
   * retaining bodies, so peak retention scaled with the sender's in-flight
   * concurrency rather than with the cap. Reserving at first chunk makes the
   * ceiling structural instead of incidental.
   */
  pendingSampleSessions: number;
  pendingSampleBytes: number;
  sampleTruncated: boolean;
};

/**
 * `externalSessionId` for a violation about the BATCH ENVELOPE rather than any
 * one session. Exported so the scoring pass and the mock agree on the sentinel
 * instead of each spelling it.
 */
export const BATCH_SCOPED_VIOLATION_ID = "-";

export function freshContentState(): ContentState {
  return {
    delivered: new Map(),
    violations: [],
    violationCount: 0,
    accumulators: new Map(),
    declaredTotals: new Map(),
    sampleBodies: new Map(),
    sampleBytes: 0,
    pendingSampleSessions: 0,
    pendingSampleBytes: 0,
    sampleTruncated: false,
  };
}

/**
 * A complete, zero-valued {@link RelationCounts}.
 *
 * Exported because `soak-cycle-record.ts` needs the same canonical shape when a
 * read-back fails: `{} as RelationCounts` satisfies the compiler and then
 * serializes as `{}`, so a consumer reading `relationTotals.events` gets
 * `undefined` where the type promises a number. An absent field and a zero are
 * different facts, and the cycle record must not blur them.
 */
export function zeroRelations(): RelationCounts {
  const counts = {} as RelationCounts;
  for (const field of RELATION_FIELDS) {
    counts[field] = 0;
  }
  return counts;
}

function countRelations(session: Record<string, unknown>): RelationCounts {
  const counts = zeroRelations();
  for (const field of RELATION_FIELDS) {
    const value = session[field];
    counts[field] = Array.isArray(value) ? value.length : 0;
  }
  return counts;
}

/**
 * Fold one chunk's relation counts into the sequence accumulator.
 *
 * Partitioned streams accumulate; replicated ones are taken from the first chunk
 * and thereafter only CHECKED. `baseFor` spreads the same session into every
 * chunk, so a replicated count that changes mid-sequence is a producer
 * inconsistency — recorded rather than silently resolved, since picking a winner
 * would be inventing a number the payload never actually agreed on.
 */
function mergeChunkRelations(
  state: ContentState,
  id: string,
  accumulator: ChunkAccumulator,
  from: RelationCounts
): void {
  for (const field of PARTITIONED_RELATION_FIELDS) {
    accumulator.relations[field] += from[field];
  }
  if (!accumulator.replicatedSeen) {
    for (const field of REPLICATED_RELATION_FIELDS) {
      accumulator.relations[field] = from[field];
    }
    accumulator.replicatedSeen = true;
    return;
  }
  const diverged = REPLICATED_RELATION_FIELDS.filter(
    (field) => accumulator.relations[field] !== from[field]
  );
  if (diverged.length > 0) {
    recordViolation(
      state,
      id,
      ContentViolationKind.ReplicatedRelationDivergence,
      diverged
        .map(
          (field) =>
            `${field} ${accumulator.relations[field]} then ${from[field]}`
        )
        .join(",")
    );
  }
}

function countMetadataKeys(session: Record<string, unknown>): number {
  const metadata = session.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return 0;
  }
  return Object.keys(metadata).length;
}

function digestOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function missingRequiredFields(session: Record<string, unknown>): string[] {
  return REQUIRED_SESSION_FIELDS.filter((field) => {
    const value = session[field];
    return typeof value !== "string" || value.length === 0;
  });
}

/**
 * Required relation arrays that were ABSENT from the payload. Presence is
 * tested before anything counts them, because `countRelations` folds a missing
 * key to `0` — indistinguishable from a legitimately empty array, which is the
 * whole reason a dropped section could reach the read-back scoring as clean.
 */
function missingRequiredRelations(session: Record<string, unknown>): string[] {
  return REQUIRED_RELATION_FIELDS.filter(
    (field) => !Array.isArray(session[field])
  );
}

function recordViolation(
  state: ContentState,
  externalSessionId: string,
  kind: ContentViolationKind,
  detail: string
): void {
  // Counted before the cap so the exact total survives a storm the retained
  // list cannot: truncating the forensic detail must never make a cycle look
  // cleaner than it was.
  state.violationCount += 1;
  if (state.violations.length >= READBACK_MAX_VIOLATIONS) {
    return;
  }
  state.violations.push({ externalSessionId, kind, detail });
}

/**
 * Retain a delivered session's content and, when the same (session,
 * dataRevision) has already been delivered, assert the redelivery hashes
 * identically. A retry path that silently drops a field diverges here instead
 * of scoring as a second clean delivery.
 */
function commitDelivery(
  state: ContentState,
  entry: Omit<DeliveredSessionContent, "deliveries">
): void {
  const existing = state.delivered.get(entry.externalSessionId);
  if (!existing) {
    state.delivered.set(entry.externalSessionId, { ...entry, deliveries: 1 });
    return;
  }
  if (
    existing.dataRevision === entry.dataRevision &&
    existing.contentDigest !== entry.contentDigest
  ) {
    recordViolation(
      state,
      entry.externalSessionId,
      ContentViolationKind.DigestDivergence,
      `dataRevision ${String(entry.dataRevision)}: ${existing.contentDigest.slice(0, 12)} then ${entry.contentDigest.slice(0, 12)}`
    );
  }
  existing.deliveries += 1;
  existing.dataRevision = entry.dataRevision;
  existing.contentDigest = entry.contentDigest;
  existing.relations = entry.relations;
  existing.metadataKeys = entry.metadataKeys;
  existing.payloadBytes = entry.payloadBytes;
  existing.chunkTotal = entry.chunkTotal;
}

/**
 * True while this session may still contribute a body to the read-back sample.
 *
 * Counts RESERVED (still-assembling) slots and bytes alongside the retained
 * ones, so N concurrent chunk sequences cannot each see the same free slot.
 */
function isSampleEligible(state: ContentState, id: string): boolean {
  if (state.sampleBodies.has(id)) {
    return true;
  }
  return (
    state.sampleBodies.size + state.pendingSampleSessions <
      READBACK_SAMPLE_SESSIONS &&
    state.sampleBytes + state.pendingSampleBytes < READBACK_SAMPLE_MAX_BYTES
  );
}

/**
 * Stop an assembling sequence from retaining bodies and give its reservation
 * back — on completion, on abandonment, or when it outgrows the byte cap while
 * still in flight. Idempotent: an accumulator whose `sampleParts` is already
 * `null` holds no reservation.
 */
function releaseSampleReservation(
  state: ContentState,
  accumulator: ChunkAccumulator,
  markTruncated: boolean
): void {
  if (!accumulator.sampleParts) {
    return;
  }
  accumulator.sampleParts = null;
  state.pendingSampleSessions = Math.max(0, state.pendingSampleSessions - 1);
  state.pendingSampleBytes = Math.max(
    0,
    state.pendingSampleBytes - accumulator.payloadBytes
  );
  if (markTruncated) {
    state.sampleTruncated = true;
  }
}

function retainSampleBody(
  state: ContentState,
  id: string,
  body: unknown,
  bytes: number
): void {
  if (state.sampleBodies.has(id)) {
    return;
  }
  if (
    state.sampleBodies.size >= READBACK_SAMPLE_SESSIONS ||
    state.sampleBytes + bytes > READBACK_SAMPLE_MAX_BYTES
  ) {
    state.sampleTruncated = true;
    return;
  }
  state.sampleBodies.set(id, body);
  state.sampleBytes += bytes;
}

/** An unchunked payload: one receive is one complete delivery. */
function recordWholeSession(
  state: ContentState,
  id: string,
  session: Record<string, unknown>,
  dataRevision: number | null
): void {
  const serialized = JSON.stringify(session);
  const relations = countRelations(session);
  const metadataKeys = countMetadataKeys(session);
  const payloadBytes = Buffer.byteLength(serialized, "utf8");
  // Called unconditionally: `retainSampleBody` owns the cap check AND the
  // `sampleTruncated` flag, so gating it on eligibility here would make the
  // sample silently stop growing with nothing recording that it had been cut
  // short — the exact "looks complete, isn't" failure this ticket is about.
  retainSampleBody(state, id, session, payloadBytes);
  commitDelivery(state, {
    externalSessionId: id,
    dataRevision,
    chunkTotal: null,
    relations,
    metadataKeys,
    contentDigest: digestOf(serialized),
    payloadBytes,
  });
}

/**
 * Score a chunk index that has arrived before.
 *
 * A repeat is NOT evidence of corruption on its own. An `appkill` cycle
 * interrupted after some chunks were acknowledged leaves the durable session
 * queued, and the relaunched service legitimately restarts the sequence at index
 * 0 — so scoring every repeated index as a content violation false-positives the
 * harness's own kill/restart cycles.
 *
 * The digest is what separates the two cases, so it is what is compared:
 *  - identical digest ⇒ an idempotent retry. Not recorded, and (via the caller's
 *    early return) never re-counted into the accumulator's relation totals.
 *  - DIFFERENT digest at the same index ⇒ the content changed under a re-send.
 *    That is a real divergence and is still recorded, so suppressing the false
 *    positive does not buy a blind spot.
 */
function recordChunkRepeat(
  state: ContentState,
  id: string,
  chunk: { index: number; total: number },
  priorDigest: string,
  digest: string
): void {
  if (priorDigest === digest) {
    return;
  }
  recordViolation(
    state,
    id,
    ContentViolationKind.ChunkDuplicateIndex,
    `index ${chunk.index} of total ${chunk.total} re-sent with different content: ${priorDigest.slice(0, 12)} then ${digest.slice(0, 12)}`
  );
}

/**
 * Accumulate one chunk. The assembled digest is the ordered hash of the per-
 * chunk digests, so reassembly is asserted on CONTENT rather than on a count of
 * arrivals — the ~348 chunked sends per cycle that were previously graded by
 * arithmetic alone.
 */
function recordChunk(
  state: ContentState,
  id: string,
  session: Record<string, unknown>,
  dataRevision: number | null,
  chunk: { index: number; total: number }
): boolean {
  // Validated BEFORE the total is compared or remembered. `chunk.index` beside
  // it already had `Number.isInteger`; `chunk.total` did not, and the asymmetry
  // was the whole bug: a `NaN` total passes `chunk.index >= chunk.total`
  // (always false), builds an accumulator whose `total` is `NaN`, and then
  // `chunkDigests.size < accumulator.total` is also always false — so
  // `finishAssembly` never runs and the entry leaks for the life of the battery.
  // Checking it here rather than in the range guard below also stops a `NaN`
  // being stored as the declared total, which would make every later valid
  // chunk of that revision report a spurious total conflict.
  if (!Number.isInteger(chunk.total) || chunk.total <= 0) {
    recordViolation(
      state,
      id,
      ContentViolationKind.ChunkTotalInvalid,
      `total ${String(chunk.total)} is not a usable part count`
    );
    return false;
  }
  const revisionKey = `${id}#${String(dataRevision)}`;
  const declaredTotal = state.declaredTotals.get(revisionKey);
  if (declaredTotal !== undefined && declaredTotal !== chunk.total) {
    recordViolation(
      state,
      id,
      ContentViolationKind.ChunkTotalConflict,
      `total ${declaredTotal} then ${chunk.total} at revision ${String(dataRevision)}`
    );
  }
  if (declaredTotal === undefined) {
    state.declaredTotals.set(revisionKey, chunk.total);
  }
  if (
    !Number.isInteger(chunk.index) ||
    chunk.index < 0 ||
    chunk.index >= chunk.total
  ) {
    recordViolation(
      state,
      id,
      ContentViolationKind.ChunkIndexOutOfRange,
      `index ${chunk.index} of total ${chunk.total}`
    );
    return false;
  }

  const key = `${revisionKey}#${chunk.total}`;
  let accumulator = state.accumulators.get(key);
  if (!accumulator) {
    if (state.accumulators.size >= MAX_TRACKED_CHUNK_SEQUENCES) {
      recordViolation(
        state,
        id,
        ContentViolationKind.ChunkTrackingOverflow,
        `refused to track a ${chunk.total}-chunk sequence beyond ${MAX_TRACKED_CHUNK_SEQUENCES} in flight`
      );
      return false;
    }
    const reserveSample = isSampleEligible(state, id);
    accumulator = {
      total: chunk.total,
      chunkDigests: new Map(),
      relations: zeroRelations(),
      replicatedSeen: false,
      metadataKeys: 0,
      payloadBytes: 0,
      sampleParts: reserveSample ? new Map() : null,
    };
    if (reserveSample) {
      state.pendingSampleSessions += 1;
    }
    state.accumulators.set(key, accumulator);
  }
  const serialized = JSON.stringify(session);
  const chunkDigest = digestOf(serialized);
  const priorDigest = accumulator.chunkDigests.get(chunk.index);
  if (priorDigest !== undefined) {
    recordChunkRepeat(state, id, chunk, priorDigest, chunkDigest);
    return false;
  }
  accumulator.chunkDigests.set(chunk.index, chunkDigest);
  mergeChunkRelations(state, id, accumulator, countRelations(session));
  accumulator.metadataKeys = Math.max(
    accumulator.metadataKeys,
    countMetadataKeys(session)
  );
  const chunkBytes = Buffer.byteLength(serialized, "utf8");
  accumulator.payloadBytes += chunkBytes;
  if (accumulator.sampleParts) {
    accumulator.sampleParts.set(chunk.index, session);
    state.pendingSampleBytes += chunkBytes;
    if (
      state.sampleBytes + state.pendingSampleBytes >
      READBACK_SAMPLE_MAX_BYTES
    ) {
      // Give the reservation back mid-flight rather than at completion: an
      // oversized sequence must stop holding bodies the moment it outgrows the
      // cap, not after it has already held them all.
      releaseSampleReservation(state, accumulator, true);
    }
  }

  if (accumulator.chunkDigests.size < accumulator.total) {
    return false;
  }
  finishAssembly(state, id, dataRevision, key, accumulator);
  return true;
}

function finishAssembly(
  state: ContentState,
  id: string,
  dataRevision: number | null,
  key: string,
  accumulator: ChunkAccumulator
): void {
  const ordered: string[] = [];
  for (let index = 0; index < accumulator.total; index++) {
    const digest = accumulator.chunkDigests.get(index);
    if (digest === undefined) {
      // Unreachable while indices are range-checked on arrival; recorded rather
      // than thrown so a future protocol change surfaces as a violation.
      recordViolation(
        state,
        id,
        ContentViolationKind.ChunkIndexOutOfRange,
        `assembled ${accumulator.total} chunks with index ${index} absent`
      );
      releaseSampleReservation(state, accumulator, false);
      state.accumulators.delete(key);
      return;
    }
    ordered.push(digest);
  }
  if (accumulator.sampleParts) {
    const parts = accumulator.sampleParts;
    const body = {
      externalSessionId: id,
      chunkTotal: accumulator.total,
      chunks: ordered.map((_digest, index) => parts.get(index)),
    };
    // Convert the reservation into a real retention: release first so the
    // sequence's bytes are counted once, under `sampleBytes`, not twice.
    releaseSampleReservation(state, accumulator, false);
    retainSampleBody(state, id, body, accumulator.payloadBytes);
  }
  commitDelivery(state, {
    externalSessionId: id,
    dataRevision,
    chunkTotal: accumulator.total,
    relations: accumulator.relations,
    metadataKeys: accumulator.metadataKeys,
    contentDigest: digestOf(ordered.join("|")),
    payloadBytes: accumulator.payloadBytes,
  });
  // Drop the accumulator entirely: a full re-send rebuilds it, which is what
  // makes a duplicate delivery visible instead of vanishing into a satisfied
  // set — and it is what keeps retention bounded by IN-FLIGHT sequences.
  state.accumulators.delete(key);
}

/**
 * The delivered `dataRevision`, or `null` when the payload declared none.
 *
 * Third instance of the same defect class as the `chunk.total` and page-read
 * `total` guards: `typeof x === "number"` admits `NaN`, and a `NaN` revision is
 * not merely a wrong label. `commitDelivery` gates its digest comparison on
 * `existing.dataRevision === entry.dataRevision`, and `NaN === NaN` is false, so
 * a redelivery at a `NaN` revision could NEVER report a digest divergence — the
 * check silently unable to fire, which is the thing this harness exists to stop.
 *
 * Production bounds the field with `.int().min(1).max(MAX_SUPPORTED_DATA_REVISION)`
 * and `.nullish()`, so absent is legal but an unusable value is not. An unusable
 * one is recorded AND folded to `null`, which is the honest "unknown" and, unlike
 * `NaN`, compares equal to itself so the divergence check keeps working.
 */
function resolveDataRevision(
  state: ContentState,
  id: string,
  declared: unknown
): number | null {
  if (declared === undefined || declared === null) {
    return null;
  }
  if (
    typeof declared === "number" &&
    Number.isInteger(declared) &&
    declared >= 1
  ) {
    return declared;
  }
  recordViolation(
    state,
    id,
    ContentViolationKind.DataRevisionInvalid,
    `dataRevision ${String(declared)} is not a usable revision`
  );
  return null;
}

/**
 * Record one session payload's CONTENT. Returns true when this receive
 * completed a delivery (an unchunked payload, or the final chunk of a
 * sequence) — the envelope bookkeeping in `mock-cloud-server.ts` owns the
 * delivery COUNTS, this module owns what was inside them.
 */
export function recordSessionContent(
  state: ContentState,
  session: Record<string, unknown>,
  chunk: { index: number; total: number } | null
): void {
  const id =
    typeof session.externalSessionId === "string" &&
    session.externalSessionId.length > 0
      ? session.externalSessionId
      : "unknown-session";
  const missing = missingRequiredFields(session);
  if (missing.length > 0) {
    recordViolation(
      state,
      id,
      ContentViolationKind.MissingRequiredField,
      missing.join(",")
    );
  }
  const missingRelations = missingRequiredRelations(session);
  if (missingRelations.length > 0) {
    recordViolation(
      state,
      id,
      ContentViolationKind.MissingRequiredRelation,
      `${missingRelations.join(",")} absent (an empty array is legitimate, an absent key is not)`
    );
  }
  const dataRevision = resolveDataRevision(state, id, session.dataRevision);
  if (chunk) {
    recordChunk(state, id, session, dataRevision, chunk);
    return;
  }
  recordWholeSession(state, id, session, dataRevision);
}

/**
 * Record a violation about the batch envelope — a field describing the batch as
 * a whole rather than one session inside it.
 */
export function recordBatchViolation(
  state: ContentState,
  kind: ContentViolationKind,
  detail: string
): void {
  recordViolation(state, BATCH_SCOPED_VIOLATION_ID, kind, detail);
}

/** The corpus the mock serves back over HTTP for the read-back pass. */
export function buildReadBackResponse(state: ContentState): ReadBackResponse {
  const index: ReadBackEntry[] = [];
  for (const [id, content] of state.delivered) {
    index.push({
      externalSessionId: id,
      contentDigest: content.contentDigest,
      relations: content.relations,
      metadataKeys: content.metadataKeys,
      payloadBytes: content.payloadBytes,
      deliveries: content.deliveries,
    });
  }
  index.sort((a, b) =>
    a.externalSessionId.localeCompare(b.externalSessionId, "en")
  );
  const sample = [...state.sampleBodies].map(
    ([externalSessionId, session]) => ({
      externalSessionId,
      session,
    })
  );
  return {
    index,
    // Already capped at record time; no slice needed here.
    violations: state.violations,
    violationCount: state.violationCount,
    sample,
    sampleBytes: state.sampleBytes,
    sampleTruncated: state.sampleTruncated,
  };
}
