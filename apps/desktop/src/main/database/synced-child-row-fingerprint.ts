/**
 * @file synced-child-row-fingerprint.ts
 * @description The change-gate the DATA_REVISION rebuild uses to decide whether a
 * re-derived session actually differs from the stored one.
 *
 * Extracted from `sqlite.ts` (ISS-4591, PR #4115 review): that file is a
 * grandfathered god-object the root `AGENTS.md` marks shrink-only, and this
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
 * blip permanently downgrade the process to the blind legacy checksum.
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
 * to the legacy checksum instead of failing every rebuild.
 *
 * The result is cached ONLY when it is conclusive — a recognized
 * unsupported-feature error, or success. A transient failure is retried on the
 * next call rather than memoized, so a single busy/I/O blip cannot permanently
 * strand the process on the blind gate. The fallback logs loudly because it
 * silently reinstates the blindness ISS-4591 exists to remove.
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
            `sqlite row-digest fingerprint unavailable on this build, falling back to the legacy child-row checksum (equal-length changes will not be detected): ${message}`
          );
          return false;
        }
        // Transient: drop the memo so the next rebuild probes again.
        cached = null;
        log(
          `sqlite row-digest probe failed transiently, using the legacy child-row checksum for this attempt only: ${message}`
        );
        return false;
      });
    return cached;
  };
}

/**
 * A deterministic fingerprint of the synced child-row projections of one session.
 *
 * `hasRowDigest` selects the REAL gate (a SHA3-256 digest per row, folded into
 * one digest per table) over the legacy fallback. The legacy checksum sums row
 * LENGTHS, counts rows, and samples only the FIRST character of the
 * concatenation, so ANY equal-length substitution past column one is invisible
 * to it — a spike over the frozen golden corpus recorded 971 blind observations
 * across 53 of 56 synced columns (`start_ms`/`end_ms` are uniformly 13-digit
 * epochs, `events.id` is 36 chars, `is_primary` is one). `refChecksum` was the
 * FEA-4010 (AA-10) point fix for exactly one column; the row digest subsumes it.
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
    const sql = hasRowDigest
      ? rowDigestSql(projection)
      : legacyChecksumSql(projection);
    const [row] = await tx.$queryRawUnsafe<{ fp: string }[]>(sql, sessionId);
    parts.push(row?.fp ?? "");
  }
  return parts.join("#");
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

/** The pre-ISS-4591 gate, retained only for a build without `sha3()`. */
function legacyChecksumSql(projection: SyncedChildRowProjection): string {
  const cols = projection.columns
    .map((column) => `COALESCE(${column},'')`)
    .join("||'|'||");
  const checksum =
    `COALESCE(SUM(LENGTH(${cols})), 0) || ':' || COUNT(*) || ':' || ` +
    `COALESCE(SUM(UNICODE(SUBSTR(${cols} || 'x', 1, 1))), 0)`;
  const refSupplement = projection.legacyRefColumn
    ? ` || ':' || ${refChecksumSql(projection.legacyRefColumn)}`
    : "";
  return `SELECT ${checksum}${refSupplement} AS fp FROM ${projection.table} WHERE session_id = $1`;
}

/**
 * FEA-4010 (AA-10): a position-weighted character sum over a fixed 12-character
 * right-aligned window, so a same-width slug swap moves the legacy checksum.
 * Subsumed by the row digest; still applied on the legacy branch so a fallback
 * build keeps the behavior AA-10 shipped.
 */
function refChecksumSql(column: string): string {
  const window = `SUBSTR('${" ".repeat(REF_CHECKSUM_WIDTH)}' || COALESCE(${column}, ''), -${REF_CHECKSUM_WIDTH})`;
  const terms = REF_CHECKSUM_WEIGHTS.map(
    (weight, index) => `${weight} * UNICODE(SUBSTR(${window}, ${index + 1}, 1))`
  ).join(" + ");
  return `COALESCE(SUM(${terms}), 0)`;
}

const REF_CHECKSUM_WIDTH = 12;
const REF_CHECKSUM_WEIGHTS = [1, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37];

type SyncedChildRowProjection = {
  table: string;
  columns: readonly string[];
  /** Legacy-only supplement; subsumed by the row digest. */
  legacyRefColumn?: string;
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
  {
    table: "events",
    // created_at is the event's transcript timestamp — it rides in the payload
    // and a re-derivation can move it.
    columns: [
      "id",
      "agent_id",
      "event_type",
      "tool_name",
      "summary",
      "data",
      "created_at",
    ],
  },
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
      "json_extract(evidence, '$.monitoredSessionActivity')",
    ],
  },
  {
    table: "pull_requests",
    columns: ["id", "repo_full_name", "pr_number", "branch_name", "state"],
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
    legacyRefColumn: "work_item_ref",
  },
];
