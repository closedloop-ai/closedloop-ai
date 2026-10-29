import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import {
  countProjected,
  INDEX_KEY_MAX_BYTES,
  INDEX_KEY_PROJECTED_METRIC,
  projectIndexKey,
} from "@/lib/index-key-projection";
import {
  IndexKeyProjectionEmissionGate,
  IndexKeyProjectionReason,
} from "@/lib/index-key-projection-telemetry";

/**
 * ISS-8125: `SessionTranscript` identity, with both of its string columns
 * projected down to a size a btree tuple can physically hold.
 *
 * `externalSessionId` and `fileKey` do not each ride their own index — they
 * SHARE two tuples: `@@unique([computeTargetId, externalSessionId, fileKey])`
 * and `@@index([organizationId, computeTargetId, externalSessionId, fileKey])`.
 * Neither arrives bounded (`transcriptFileIdentitySchema` constrains the SHAPE
 * of both — path-safe, `main` or `subagent:{id}` — and the LENGTH of neither),
 * and the route's 8 KB body budget leaves ample room for either to blow past
 * Postgres's 2704-byte tuple limit. Verified against Postgres 16: a 4096-byte
 * high-entropy `external_session_id` raises `index row size 4136 exceeds btree
 * version 4 maximum 2704 for index
 * "session_transcript_compute_target_id_external_session_id_fi_key"`.
 *
 * PROJECTED AS ONE IDENTITY, not per column, because `objectStorageKey` is
 * DERIVED from both (`resolveTranscriptObjectKey`). Bounding the columns while
 * `resolveTranscriptObjectKey` still read the raw pair would trade a Postgres
 * throw for an S3 one — an object key may not exceed 1024 bytes either — so the
 * row would land and the bytes still would not. One projected identity feeds the
 * columns and the key it derives.
 *
 * TWO BUDGETS, and which string gets which is the load-bearing part.
 * `externalSessionId` is the SHARED session identity — `SessionDetail` stores
 * the same value under {@link INDEX_KEY_MAX_BYTES} and three call sites join the
 * two tables on it by equality — so it takes that same budget here and the S3
 * headroom is spent entirely on `fileKey`, which nothing joins on. See
 * {@link TRANSCRIPT_FILE_KEY_MAX_BYTES}.
 *
 * Deterministic, so every re-plan, complete and skip of the same file resolves
 * to the same row and the same object. NOT idempotent — see
 * {@link projectTranscriptIdentity}.
 */
export type TranscriptFileIdentity = {
  computeTargetId: string;
  externalSessionId: string;
  fileKey: string;
};

export type ProjectedTranscriptIdentity = TranscriptFileIdentity & {
  /** How many of the two string columns the budget actually bound. */
  projectedCount: number;
};

/**
 * S3's own hard limit on an object key, in bytes. Quoted rather than derived:
 * this is the number the AWS API rejects on, so it is the number the budget
 * below is computed from.
 */
const S3_OBJECT_KEY_MAX_BYTES = 1024;

/**
 * Everything `resolveTranscriptObjectKey` puts in the key that is NOT one of the
 * two projected strings, at its worst: two 36-byte uuids and their separators,
 * the `/subagent/` infix, and the `.jsonl` suffix.
 *
 * `36 + "/" + 36 + "/" + <sid> + "/subagent/" + <fileId> + ".jsonl"`, and the
 * `subagent:` prefix does not appear — `fileKey` carries it but the key is built
 * from the id AFTER that prefix is sliced off, so it costs nothing here.
 */
const TRANSCRIPT_OBJECT_KEY_OVERHEAD_BYTES = 36 + 1 + 36 + 1 + 10 + 6;

/** `subagent:`, which `resolveTranscriptObjectKey` slices off `fileKey`. */
const SUBAGENT_FILE_KEY_PREFIX_BYTES = "subagent:".length;

/**
 * ISS-8125 (review, whitlockk): the S3 object key is DERIVED from both projected
 * strings, so the identity has to fit 1024 bytes as well as the btree tuple.
 * Two strings at the shared `INDEX_KEY_MAX_BYTES` build a 1105-byte key, and
 * `defaultS3Port` passes that straight through: the API accepts a request S3
 * then rejects, so the row lands and the bytes never do.
 *
 * THE S3 HEADROOM IS SPENT ON `fileKey`, AND ALL OF IT, because
 * `externalSessionId` is not this table's to bound (ISS-8125, operator review).
 * It is the SHARED session identity: `SessionDetail` stores the same value
 * projected at {@link INDEX_KEY_MAX_BYTES} (ISS-8069), and six call sites join
 * the two tables on it by PLAIN EQUALITY, in both directions —
 * `agent-sessions/retention-service.ts` and
 * `agent-sessions/phantom-retention-service.ts` reap a deleted session's
 * transcripts and reclaim their S3 archives; `transcript-read-service.ts`,
 * `agent-sessions/service.ts` and `service/list-transcript-dispositions.ts` read
 * a session's transcript files for download, detail and list; and
 * `backfillOrphanTranscriptsBatch` goes the other way, resolving a transcript's
 * session from the transcript's own stored value.
 *
 * A transcript-local budget makes the two columns hold DIFFERENT strings for one
 * session, and neither is derivable from the other: the projection is lossy, so
 * the raw id that would produce the sibling key is gone. All six then miss
 * silently — a session whose transcripts read as absent, an orphan that never
 * links, and a deleted session whose transcript rows and their S3 archives (up
 * to ~53 GB) are never reclaimed.
 *
 * So `externalSessionId` keeps the shared budget and `fileKey` takes what is
 * left. SOLVED, not picked, from the limit that actually binds: the worst key
 * shape is `{org}/{ct}/{sid}/subagent/{fileId}.jsonl`, costing
 * `overhead + INDEX_KEY_MAX_BYTES + (B - "subagent:".length)`, and requiring
 * that to fit {@link S3_OBJECT_KEY_MAX_BYTES} gives the `B` below. Derived
 * rather than written as a literal so a change to the key shape or to the shared
 * budget moves this with it instead of silently reopening the overflow.
 *
 * Still far above any legitimate value: `fileKey` is `main` or
 * `subagent:{uuid}`, and it is local to this table — nothing joins on it.
 */
export const TRANSCRIPT_FILE_KEY_MAX_BYTES =
  S3_OBJECT_KEY_MAX_BYTES +
  SUBAGENT_FILE_KEY_PREFIX_BYTES -
  TRANSCRIPT_OBJECT_KEY_OVERHEAD_BYTES -
  INDEX_KEY_MAX_BYTES;

/**
 * Project one transcript file identity: `externalSessionId` at the shared
 * {@link INDEX_KEY_MAX_BYTES}, `fileKey` at
 * {@link TRANSCRIPT_FILE_KEY_MAX_BYTES}. A no-op for every identity inside those
 * budgets and outside the reserved namespace, which is all of them in practice.
 *
 * NOT IDEMPOTENT, because {@link projectIndexKey} is not and provably cannot be
 * (ISS-8254 reserved the marker, so a projected value re-enters the projected
 * branch). A caller holding an identity read back OUT of the columns must NOT
 * pass it through here — that digests the projection rather than the original
 * and silently mints a key that matches nothing. Resolve such a value with
 * `storedIndexKeyCandidates` instead.
 */
export function projectTranscriptIdentity(
  identity: TranscriptFileIdentity
): ProjectedTranscriptIdentity {
  const externalSessionId = projectIndexKey(
    identity.externalSessionId,
    INDEX_KEY_MAX_BYTES
  );
  const fileKey = projectIndexKey(
    identity.fileKey,
    TRANSCRIPT_FILE_KEY_MAX_BYTES
  );
  return {
    computeTargetId: identity.computeTargetId,
    externalSessionId: externalSessionId.value,
    fileKey: fileKey.value,
    projectedCount: countProjected(externalSessionId, fileKey),
  };
}

/**
 * The two identity COLUMNS of a `SessionTranscript` create payload, projected.
 * Spread into the `create` so the row is written with exactly the values the
 * sibling `identityWhere` matched on — a raw pair here would write a row this
 * request's own `where` could never find again.
 */
export function projectedIdentityColumns(identity: TranscriptFileIdentity): {
  externalSessionId: string;
  fileKey: string;
} {
  const projected = projectTranscriptIdentity(identity);
  return {
    externalSessionId: projected.externalSessionId,
    fileKey: projected.fileKey,
  };
}

export function reportTranscriptIndexKeyProjections(
  organizationId: string,
  projected: ProjectedTranscriptIdentity
): void {
  if (projected.projectedCount === 0) {
    return;
  }
  const scope = {
    computeTargetId: projected.computeTargetId,
    organizationId,
  };
  try {
    if (!transcriptIndexKeyProjectionGate.record(scope, Date.now())) {
      return;
    }
    log.warn(TRANSCRIPT_INDEX_KEY_PROJECTED_MESSAGE, {
      ...scope,
      event: TRANSCRIPT_INDEX_KEY_PROJECTED_EVENT,
      projectedCount: projected.projectedCount,
      occurrences: 1,
    });
    emitTelemetryMetric({
      metric: INDEX_KEY_PROJECTED_METRIC,
      organizationId,
      computeTargetId: projected.computeTargetId,
      count: projected.projectedCount,
    });
  } catch (error) {
    log.warn("[desktop/transcripts] Failed to report projected index keys", {
      event: TRANSCRIPT_INDEX_KEY_PROJECTED_EVENT,
      computeTargetId: projected.computeTargetId,
      error: parseError(error),
    });
  }
}

export const TRANSCRIPT_INDEX_KEY_PROJECTED_EVENT =
  "desktop_transcript_index_key_projected";

/**
 * The human-readable message every occurrence carries, kept beside the event
 * name so the log line stays readable to someone who is not querying by facet.
 */
export const TRANSCRIPT_INDEX_KEY_PROJECTED_MESSAGE =
  "Projected transcript index keys";

/**
 * This lane's instance of the shared org/reason choke point.
 *
 * Exported so tests can reset it between cases; production code must not reach
 * into it beyond {@link reportTranscriptIndexKeyProjections}.
 */
export const transcriptIndexKeyProjectionGate =
  new IndexKeyProjectionEmissionGate({
    reason: IndexKeyProjectionReason.Transcript,
    onRollup: (scope, occurrences, flushedBy) =>
      log.warn(TRANSCRIPT_INDEX_KEY_PROJECTED_MESSAGE, {
        ...scope,
        event: TRANSCRIPT_INDEX_KEY_PROJECTED_EVENT,
        occurrences,
        aggregated: true,
        flushedBy,
      }),
  });
