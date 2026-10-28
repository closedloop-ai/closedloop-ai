/**
 * @file synced-child-row-fingerprint.ts
 * @description The change-gate the DATA_REVISION rebuild uses to decide whether a
 * re-derived session actually differs from the stored one.
 *
 * Extracted from `sqlite.ts` (ISS-4591, PR #4115 review): that file is a
 * god-object the root `AGENTS.md` file-size discipline applies to, and this
 * fingerprint is a cohesive unit with its own contract. Living here also lets it
 * be exercised directly instead of only through a full database open.
 *
 * FEA-3659: the split change-gate in `importPhaseSessionAndMainAgent` derives its
 * content-change signal from the `sessions.metadata` blob ALONE. That blob is a
 * faithful fingerprint of the session ROW, but not of its child projections: a
 * DATA_REVISION bump can re-derive different subagent classifications, tool
 * ownership/events, or component-usage rows from an unchanged transcript while
 * every metadata-blob field stays byte-identical. Because the rebuild physically
 * deletes and re-inserts those rows, that change is real and must reach the
 * cloud — but a metadata-only gate would leave `updated_at` unbumped and the id
 * out of `changedSessionIds`, stranding it under the preserved sync cursor.
 * Comparing this fingerprint before the teardown and after the re-insert closes
 * that gap, while a byte-identical re-derivation stays a true no-op.
 *
 * Computed entirely in SQL, in the rebuild's own transaction: nothing is
 * materialized in JS (the FEA-2038 analytics invariant).
 */

/** The minimal surface this needs — satisfied by a Prisma transaction client. */
export type FingerprintQueryable = {
  $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T>;
};

/**
 * A libSQL build lacking `sha3()` / in-aggregate `ORDER BY` reports itself
 * through one of these. Anything else (busy, I/O, adapter transport) is
 * TRANSIENT and must not be cached as "unsupported" — doing so would let one
 * blip permanently downgrade the process to the portable checksum.
 */
const UNSUPPORTED_FEATURE_MARKERS = [
  "no such function",
  'near "order"',
  "syntax error",
] as const;

export function isUnsupportedFeatureError(error: unknown): boolean {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return UNSUPPORTED_FEATURE_MARKERS.some((marker) => message.includes(marker));
}

/**
 * Probe whether this libSQL build can compute the real row digest: `sha3()`
 * (bundled `ext/misc/shathree.c`) plus in-aggregate `ORDER BY` (SQLite 3.44+).
 * Both ship in every `@libsql/*` platform binary we package, so this resolves
 * true in practice; the probe exists so a build that somehow lacks them degrades
 * to the portable checksum instead of failing every rebuild.
 *
 * The result is cached ONLY when it is conclusive — a recognized
 * unsupported-feature error, or success. A transient failure is retried on the
 * next call rather than memoized, so a single busy/I/O blip cannot permanently
 * strand the process on the fallback gate. The fallback logs because it is
 * slower than the packaged SHA3 path, even though it covers the same content.
 */
export function createRowDigestProbe(
  reader: FingerprintQueryable,
  log: (message: string) => void
): () => Promise<boolean> {
  let cached: Promise<boolean> | null = null;
  return () => {
    cached ??= reader
      .$queryRawUnsafe(
        "SELECT hex(sha3(group_concat(h, '' ORDER BY h))) AS v FROM (SELECT hex(sha3('probe')) AS h)"
      )
      .then(() => true)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (isUnsupportedFeatureError(error)) {
          log(
            `sqlite row-digest fingerprint unavailable on this build, falling back to the portable child-row checksum: ${message}`
          );
          return false;
        }
        // Transient: drop the memo so the next rebuild probes again.
        cached = null;
        log(
          `sqlite row-digest probe failed transiently, using the portable child-row checksum for this attempt only: ${message}`
        );
        return false;
      });
    return cached;
  };
}

/**
 * A deterministic fingerprint of the synced child-row projections of one session.
 *
 * `hasRowDigest` selects the packaged SHA3-256 digest per row. A build without
 * that extension uses two portable modular rolling checksums over every
 * character in the same injective row encoding. Unlike the pre-ISS-8876
 * length/count fallback, an equal-length substitution changes this signal.
 *
 * `ORDER BY` inside the aggregate (SQLite 3.44+) is what makes the fold
 * order-independent: per-row digests are sorted before concatenation, so
 * physical row order cannot move the result while any content change does.
 */
export async function computeSyncedChildRowFingerprint(
  tx: FingerprintQueryable,
  sessionId: string,
  hasRowDigest: boolean
): Promise<string> {
  const parts: string[] = [];
  for (const projection of SYNCED_CHILD_ROW_PROJECTIONS) {
    parts.push(
      await computeProjectionFingerprint(
        tx,
        projection,
        sessionId,
        hasRowDigest
      )
    );
  }
  return parts.join("#");
}

/** One projection's fold, shared by the whole-session gate and the events-only one. */
async function computeProjectionFingerprint(
  tx: FingerprintQueryable,
  projection: SyncedChildRowProjection,
  sessionId: string,
  hasRowDigest: boolean
): Promise<string> {
  const sql = hasRowDigest
    ? rowDigestSql(projection)
    : portableRowChecksumSql(projection);
  const [row] = await tx.$queryRawUnsafe<{ fp: string }[]>(sql, sessionId);
  return row?.fp ?? "";
}

/**
 * ISS-4591 (PR #4115 review): `json_array()` is an INJECTIVE row encoding, which
 * the previous `COALESCE(col,'')||'|'||…` concatenation was not. That form
 * collapsed NULL into the empty string, and let distinct tuples serialize
 * identically whenever a value contained the delimiter (`["a|b","c"]` and
 * `["a","b|c"]` both became `a|b|c`) — reachable in free-text agent/event columns.
 * SHA3 cannot recover a distinction the encoding already destroyed, so the
 * encoding has to carry it: JSON quotes and escapes every value and emits an
 * explicit `null`.
 */
function rowDigestSql(projection: SyncedChildRowProjection): string {
  const encoded = `json_array(${projection.columns.join(", ")})`;
  return `SELECT COALESCE(hex(sha3(group_concat(h, '' ORDER BY h))), '') AS fp
            FROM (SELECT hex(sha3(${encoded})) AS h
                    FROM ${projection.table} WHERE session_id = $1)`;
}

/**
 * The fallback for a SQLite build without SHA3 or aggregate-local ordering.
 * It hashes every character of the same injective JSON row encoding with two
 * independent 31-bit modular folds, then sorts the fixed-width row checksums in
 * a subquery before concatenation. The sort makes physical row order irrelevant;
 * repeated equal rows remain repeated in the final fingerprint.
 *
 * `rowid` is only a recursion key. All projected tables are ordinary SQLite
 * rowid tables; it is deliberately excluded from the checksum so a replace-all
 * import that preserves content remains a no-op. The arithmetic stays below
 * 2^53 before each modulus, avoiding SQLite's integer-to-REAL overflow path.
 */
function portableRowChecksumSql(projection: SyncedChildRowProjection): string {
  const encoded = `json_array(${projection.columns.join(", ")})`;
  return `WITH RECURSIVE
            encoded_rows(row_key, encoded) AS (
              SELECT rowid, ${encoded}
                FROM ${projection.table} WHERE session_id = $1
            ),
            character_folds(row_key, character_index, checksum_a, checksum_b) AS (
              SELECT row_key, 1, ${PORTABLE_CHECKSUM_SEED_A}, ${PORTABLE_CHECKSUM_SEED_B}
                FROM encoded_rows
              UNION ALL
              SELECT folds.row_key,
                     folds.character_index + 1,
                     (folds.checksum_a * ${PORTABLE_CHECKSUM_MULTIPLIER_A} + UNICODE(SUBSTR(rows.encoded, folds.character_index, 1))) % ${PORTABLE_CHECKSUM_MODULUS_A},
                     (folds.checksum_b * ${PORTABLE_CHECKSUM_MULTIPLIER_B} + UNICODE(SUBSTR(rows.encoded, folds.character_index, 1))) % ${PORTABLE_CHECKSUM_MODULUS_B}
                FROM character_folds AS folds
                JOIN encoded_rows AS rows ON rows.row_key = folds.row_key
               WHERE folds.character_index <= LENGTH(rows.encoded)
            ),
            row_checksums(checksum) AS (
              SELECT PRINTF('%08x%08x', folds.checksum_a, folds.checksum_b)
                FROM character_folds AS folds
                JOIN encoded_rows AS rows ON rows.row_key = folds.row_key
               WHERE folds.character_index > LENGTH(rows.encoded)
            )
          SELECT COALESCE(GROUP_CONCAT(checksum, ''), '') AS fp
            FROM (SELECT checksum FROM row_checksums ORDER BY checksum)`;
}

type SyncedChildRowProjection = {
  table: string;
  columns: readonly string[];
};

/**
 * The `events` projection, named because TWO gates fold it: this module's
 * whole-session fingerprint (the DATA_REVISION rebuild) and, through
 * {@link computeSyncedEventRowFingerprint}, the events phase of the incremental
 * import (ISS-8757). One declaration, so a column added to the sync payload
 * reaches both gates or neither — a second copy here is the SSOT drift that
 * would silently leave the incremental path blind to a field the rebuild sees.
 *
 * `created_at` is the event's transcript timestamp — it rides in the payload and
 * a re-derivation can move it.
 */
const SYNCED_EVENT_ROW_PROJECTION: SyncedChildRowProjection = {
  table: "events",
  columns: [
    "id",
    "agent_id",
    "event_type",
    "tool_name",
    "summary",
    "data",
    "created_at",
  ],
};

/**
 * The synced child-row projections this hashes, in the order they are folded
 * (the order is part of the fingerprint, so reordering forces a one-time
 * re-sync of every session).
 *
 * Each column list must cover every field that table contributes to the sync
 * payload AND that a rebuild can change — a wire field missing here is a
 * correction the gate cannot see, which is the exact defect class ISS-4591
 * exists to close. Deliberately EXCLUDED are columns that churn independently of
 * content (`updated_at`, live-state columns like `current_tool` /
 * `awaiting_input_since`): hashing those would mark every rebuild as changed and
 * destroy the no-op detection the gate is for.
 */
const SYNCED_CHILD_ROW_PROJECTIONS: readonly SyncedChildRowProjection[] = [
  {
    table: "agents",
    // started_at/ended_at are transcript-derived lifecycle bounds on the wire.
    columns: [
      "id",
      "name",
      "type",
      "subagent_type",
      "status",
      "task",
      "parent_agent_id",
      "metadata",
      "started_at",
      "ended_at",
    ],
  },
  SYNCED_EVENT_ROW_PROJECTION,
  {
    table: "token_usage",
    // baseline_* is the durable compaction ledger; the read sites fold it back
    // into effective totals, so a change there is a real payload change.
    columns: [
      "model",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "cache_write_5m_tokens",
      "cache_write_1h_tokens",
      "cost_usd_estimated",
      "baseline_input",
      "baseline_output",
      "baseline_cache_read",
      "baseline_cache_write",
    ],
  },
  {
    table: "token_events",
    columns: [
      "model",
      "created_at",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "cache_write_5m_tokens",
      "cache_write_1h_tokens",
      "cache_creation_cost_usd_estimated",
      "cost_usd_estimated",
    ],
  },
  {
    table: "session_artifact_links",
    // ISS-5236: `observed_at` IS hashed again. ISS-5148 had removed it, and its
    // reasoning was sound for the code as it then stood: the extractor stamped
    // every SCAN-TIME ref from the IMPORT CLOCK (`ctx.observedAt`, fed by
    // `importSessionWithTx`'s `now`), so the value advanced on every rebuild and
    // hashing it made nearly every session report content-changed — the no-op
    // path this gate exists to enable never fired. That comment closed by naming
    // the other half of the fix ("correcting the stamped VALUE ... changes wire
    // data and forces a one-time corpus re-sync, so it is filed separately for
    // the triage owner"). ISS-5236 IS that correction: `observed_at` is now the
    // ref's own transcript event instant, else the session's `startedAt`
    // (`artifact-ref-observed-at.ts`), so re-deriving an unchanged session at a
    // later clock reproduces the identical value.
    //
    // With the churn gone, the ISS-5148 exclusion would now do the opposite of
    // its purpose: `observed_at` rides the wire as `artifactRef.observedAt`
    // (`resolveLinkObservedAt` in sync-source), seeds `artifacts.first_pushed_at`
    // and positions the branch-lifecycle timeline instants, so leaving it out
    // means a re-derivation that CORRECTS it is invisible to the gate, the row's
    // `updated_at` never advances, and the cloud keeps the old import-clock
    // instant forever while local SQLite shows the corrected one. It is a wire
    // field a rebuild can change, which is exactly what this projection must
    // cover. The one-time corpus re-sync that restoring it forces is intended and
    // is what carries the correction to the cloud; the no-op path stays reachable
    // because the value itself no longer churns (`artifact-link-observed-at-noop`
    // pins that, and `artifact-link-observed-at-resync` pins this direction).
    columns: [
      "artifact_id",
      "relation",
      "method",
      "is_primary",
      "status",
      "observed_at",
      "CASE WHEN json_valid(evidence) THEN json_extract(evidence, '$.monitoredSessionActivity') ELSE NULL END",
    ],
  },
  {
    table: "pull_requests",
    columns: ["id", "repo_full_name", "pr_number", "branch_name"],
  },
  {
    table: "agent_component_session_usage",
    columns: [
      "component_kind",
      "component_key",
      "git_branch",
      "invocations",
      "error_count",
      "component_version_hash",
      "agent_component_id",
      "first_invoked_at",
      "last_invoked_at",
    ],
  },
  {
    // FEA-4010: the activity tiling rides in `activitySegmentRows`, so a re-tile
    // that changes nothing else must still advance `updated_at`. Columns mirror
    // `mapSyncedActivitySegment`.
    table: "session_activity_segments",
    columns: [
      "phase",
      "start_ms",
      "end_ms",
      "confidence",
      "evidence_layers",
      "version",
      "work_item_ref",
      "subagent_id",
    ],
  },
  {
    // ISS-10721: the activity-metrics rollup went onto the sync payload, so a
    // rebuild that corrects ONLY this table (segments and everything else
    // byte-identical — a coverage-formula bump is exactly that shape) is a real
    // wire change the gate must see. Without the entry the rebuild computes
    // `contentChanged = false`, the watermark never advances, and the corrected
    // rollup is never re-selected by the sync cursor.
    table: "session_activity_metrics",
    columns: [
      "autonomy_band",
      "coverage",
      "spend_low_conf_usd",
      "spend_medium_conf_usd",
      "spend_high_conf_usd",
      "segment_count",
      "covered_segment_count",
      "version",
      "metric_version",
    ],
  },
];

/**
 * ISS-8757: the same fold as {@link computeSyncedChildRowFingerprint}, narrowed to
 * the `events` projection, so the INCREMENTAL import path can bracket its events
 * phase with a CONTENT signal instead of a population one.
 *
 * ISS-8699 bracketed that phase with the stored row COUNT, which answers only
 * "were rows appended or removed". The reachable equal-cardinality case it cannot
 * see is a tool call whose `tool_result` arrives on a later parse:
 * `importToolEventData` then writes `isError` / `resultTimestamp` /
 * `detail.tool_response` into `events.data`, while `deterministicEventId` — keyed
 * on the tool_USE instant — keeps the row's id and the count stays put.
 *
 * WHAT THIS PROJECTION IS NOT: a list of the columns on the sync wire. It is the
 * rebuild gate's projection, and it is a strict SUPERSET of them. FEA-2718
 * removed `summary` and `data` from the cloud lane entirely — the drain hydrates
 * with `omitEventData`, `sanitizeSessionForSync` rebuilds each event from five
 * fields (`externalEventId`, `agentExternalId`, `eventType`, `toolName`,
 * `createdAt`), the ingest schema accepts only those five, and
 * `AgentSessionEvent` has no column to hold the rest. So a `data`-only change
 * moves this digest and advances the watermark, and the re-upload it triggers
 * carries a byte-identical event payload. Turn/tool detail reaches the cloud
 * through the FEA-2717 transcript archive, on a lane this fold does not touch.
 * ISS-8876 holds the open question of whether that re-selection is worth its cost.
 *
 * Directionality, stated exactly:
 * - No false negative: every column the sync payload carries is in the digest, so
 *   any durable change to a synced event column moves it.
 * - False POSITIVES with respect to the wire, by the superset above: a change
 *   confined to `summary`/`data` moves the digest without changing the payload.
 * - No false positive with respect to the STORE: the projection excludes what
 *   churns independently of content, and this phase re-derives events purely from
 *   the parsed session (no clock, no `now`), so a byte-identical re-import folds
 *   to the identical value and stays a true no-op. A signal that reported
 *   "changed" every pass would re-sync the whole corpus forever.
 *
 * `hasRowDigest` false uses the ISS-8876 portable rolling checksum, NOT a silent
 * return to the count. It folds every character of this same projection, so an
 * equal-length substitution still moves the signal.
 */
export function computeSyncedEventRowFingerprint(
  tx: FingerprintQueryable,
  sessionId: string,
  hasRowDigest: boolean
): Promise<string> {
  return computeProjectionFingerprint(
    tx,
    SYNCED_EVENT_ROW_PROJECTION,
    sessionId,
    hasRowDigest
  );
}

const PORTABLE_CHECKSUM_SEED_A = 2_166_136_261;
const PORTABLE_CHECKSUM_SEED_B = 5381;
const PORTABLE_CHECKSUM_MULTIPLIER_A = 257;
const PORTABLE_CHECKSUM_MULTIPLIER_B = 263;
const PORTABLE_CHECKSUM_MODULUS_A = 2_147_483_647;
const PORTABLE_CHECKSUM_MODULUS_B = 2_147_483_629;
