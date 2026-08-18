/**
 * @file artifact-link-backfill.ts
 * @description FEA-1684 / FEA-1959: Multi-harness backfill that re-reads raw
 * JSONL transcripts from all supported agent harnesses (Claude, Codex, Cursor)
 * and extracts artifact references (ClosedLoop slugs, PRs, branches, commits)
 * for sessions that haven't been scanned or were scanned with an older
 * extractor version.
 */
import { statSync } from "node:fs";
import { parseJsonObjectText } from "../../agent-sync/agent-sync-json-text.js";
import {
  buildRepoResolver,
  persistArtifactLinks,
  type RepoResolver,
} from "../../database/artifact-link-persistence.js";
import type { Prisma } from "../../database/generated/client.js";
import type { DesktopPrisma } from "../../database/prisma-client.js";
import { stampSegmentWorkItemRefs } from "../../database/segment-work-item-stamp.js";
import {
  bumpSessionsUpdatedAt,
  chunkWatermark,
} from "../../database/session-sync-watermark.js";
import {
  MONITORED_ACTIVITY_ONLY_METADATA_KEY,
  monitoredActivityOnlyMetadata,
} from "../../database/synced-monitored-session-activity.js";
import {
  sessionIdFromTranscriptPath as claudeSessionId,
  getProjectsDir,
  listAllTranscriptFiles as listClaudeTranscripts,
} from "../claude/claude-home.js";
import { parseSessionFile as parseClaudeSession } from "../claude/claude-parser.js";
import {
  sessionIdFromRolloutPath as codexSessionId,
  getCodexArchivedDir,
  getCodexSessionsDir,
  listAllRolloutFiles as listCodexTranscripts,
} from "../codex/codex-home.js";
import { parseRolloutFile as parseCodexSession } from "../codex/codex-parser.js";
import {
  sessionIdFromTranscriptPath as cursorSessionId,
  getCursorProjectsDir,
  listAllTranscriptFiles as listCursorTranscripts,
} from "../cursor/cursor-home.js";
import { parseTranscriptFile as parseCursorSession } from "../cursor/cursor-parser.js";
import { isImportableSourcePath } from "../engine/source-admission.js";
import type { NormalizedSession } from "../types.js";
import {
  EXTRACTOR_VERSION,
  extractArtifactRefs,
  LAUNCH_METADATA_REF_METHOD,
} from "./artifact-ref-extractor.js";
import { extractWorkItemOccurrences } from "./work-item-occurrences.js";

type TranscriptSource = {
  listFiles: () => string[];
  sessionIdFromPath: (filePath: string) => string;
  parse: (filePath: string) => Promise<NormalizedSession | null>;
  sourceRoots: () => string[];
};

const BUILTIN_TRANSCRIPT_SOURCES: TranscriptSource[] = [
  {
    listFiles: listClaudeTranscripts,
    sessionIdFromPath: claudeSessionId,
    parse: parseClaudeSession,
    sourceRoots: () => [getProjectsDir()],
  },
  {
    listFiles: listCodexTranscripts,
    sessionIdFromPath: codexSessionId,
    parse: parseCodexSession,
    sourceRoots: () => [getCodexSessionsDir(), getCodexArchivedDir()],
  },
  {
    listFiles: listCursorTranscripts,
    sessionIdFromPath: cursorSessionId,
    parse: parseCursorSession,
    sourceRoots: () => [getCursorProjectsDir()],
  },
];

export type BackfillResult = {
  captured: number;
  deduped: number;
  scanned: number;
  skipped: number;
  errors: number;
  touchedForMarkers: number;
  touchedForMarkerSessionIds: string[];
};

// session_artifact_links rows whose `method` marks a producer other than the
// extractArtifactRefs path this backfill re-derives. These must survive the
// delete-and-rederive step or the backfill silently drops links it never
// recreates:
//   - launch_metadata: extractLaunchMetadataRefs (the live import runs it, the
//     backfill does not), so deleting it here would lose it permanently.
//   - normalized_pr: conservative PR fallback added during live SQLite import.
//   - pull_requests_fold: ISS-4651 — a DEAD method, kept only as a preserve-list
//     entry. Its sole minter was the FEA-1899 Postgres migration, which the
//     pglite→SQLite squash to `0001_init` deleted, so no code path can write it
//     and this entry guards rows nothing can create. Retained rather than
//     dropped because removing a compatibility entry needs explicit approval.
//   - branch_pr_association: branch↔PR workspace links minted by propagation
//     (per-import `propagateBranchPrLinks`, boot `propagateAllBranchPrLinks`),
//     not by transcript extraction. This backfill DOES reach propagation on the
//     non-empty ref path — `persistArtifactLinks` runs it as its last step — so
//     there the exclusion only makes that call a no-op for an association that
//     already exists. What it actually protects is the `refs.length === 0`
//     shortcut below, which skips `persistArtifactLinks` entirely: without the
//     exclusion that pass would delete the association with nothing left to
//     re-derive it. Contrast the LIVE import, which always reaches propagation
//     and so deletes and re-derives through the FEA-4377 gate unconditionally
//     (see `importPhaseArtifactLinks`).
const NON_REDERIVED_LINK_METHODS = [
  LAUNCH_METADATA_REF_METHOD,
  "normalized_pr",
  "pull_requests_fold",
  "branch_pr_association",
] as const;

const NON_REDERIVED_LINK_METHODS_PLACEHOLDERS = NON_REDERIVED_LINK_METHODS.map(
  (_, index) => `$${index + 2}`
).join(", ");

// ---------------------------------------------------------------------------
// Backfill-seen cache helpers
// ---------------------------------------------------------------------------

type BackfillSeenRow = {
  file_mtime_ms: number;
  extractor_version: number;
};

// `file_mtime_ms` is a BIGINT column, so a raw query returns it as a JS `bigint`
// (and integer columns can arrive as bigint too depending on the driver). The
// skip check below compares it with `===` against a `number` mtime, and
// `bigint === number` is ALWAYS false, so without normalizing every previously
// seen transcript would fail the skip and be re-parsed every boot. Coerce the
// raw row to plain numbers at the read boundary so the rest of the code can
// compare safely.
type RawBackfillSeenRow = {
  file_mtime_ms: number | bigint | null;
  extractor_version: number | bigint | null;
};

function normalizeBackfillSeenRow(row: RawBackfillSeenRow): BackfillSeenRow {
  return {
    file_mtime_ms: Number(row.file_mtime_ms ?? 0),
    extractor_version: Number(row.extractor_version ?? 0),
  };
}

async function getBackfillSeen(
  prisma: DesktopPrisma,
  sessionId: string
): Promise<BackfillSeenRow | null> {
  const rows = await prisma.client.$queryRawUnsafe<RawBackfillSeenRow[]>(
    "SELECT file_mtime_ms, extractor_version FROM artifact_link_backfill_seen WHERE session_id = $1",
    sessionId
  );
  const row = rows[0];
  return row ? normalizeBackfillSeenRow(row) : null;
}

async function markBackfillSeen(
  tx: Prisma.TransactionClient,
  sessionId: string,
  filePath: string,
  mtimeMs: number
): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO artifact_link_backfill_seen
       (session_id, file_path, file_mtime_ms, extractor_version, scanned_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(session_id) DO UPDATE SET
       file_path = EXCLUDED.file_path,
       file_mtime_ms = EXCLUDED.file_mtime_ms,
       extractor_version = EXCLUDED.extractor_version,
       scanned_at = EXCLUDED.scanned_at`,
    sessionId,
    filePath,
    mtimeMs,
    EXTRACTOR_VERSION,
    new Date().toISOString()
  );
}

// ---------------------------------------------------------------------------
// Main backfill
// ---------------------------------------------------------------------------

type BackfillTranscriptEntry = {
  filePath: string;
  sessionId: string;
  parse: (filePath: string) => Promise<NormalizedSession | null>;
};

async function collectAllTranscriptEntries(
  sources: TranscriptSource[],
  log: (msg: string) => void,
  result: BackfillResult,
  cooperativeDelay?: (ms: number) => Promise<void>
): Promise<BackfillTranscriptEntry[]> {
  const entries: BackfillTranscriptEntry[] = [];
  for (const source of sources) {
    let files: string[];
    try {
      files = source.listFiles();
    } catch (e) {
      log(
        `artifact-link backfill: failed to list files for source (${source.sourceRoots()[0] ?? "unknown"}): ${e instanceof Error ? e.message : String(e)}`
      );
      result.errors++;
      continue;
    }
    const roots = source.sourceRoots();
    const beforeCount = entries.length;
    for (const filePath of files) {
      if (!isImportableSourcePath(filePath, roots)) {
        continue;
      }
      entries.push({
        filePath,
        sessionId: source.sessionIdFromPath(filePath),
        parse: source.parse,
      });
    }
    if (files.length > 0) {
      log(
        `artifact-link backfill: discovered ${files.length} transcripts (${entries.length - beforeCount} importable) from ${roots[0] ?? "unknown"}`
      );
    }
    // FEA-2264: yield between sources so enumerating each harness's transcript
    // tree (codex alone can be thousands of files) doesn't chain into one
    // unbroken synchronous block before the per-session loop even begins.
    await cooperativeDelay?.(ARTIFACT_BACKFILL_WRITE_PAUSE_MS);
  }
  return entries;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: transcript scanning + mtime guard + batch persist is inherently branchy
export async function backfillArtifactLinksFromTranscripts(
  prisma: DesktopPrisma,
  options?: {
    log?: (msg: string) => void;
    /** Test hook for avoiding reads from the user's real transcript tree. */
    listTranscriptFiles?: () => string[];
    /**
     * Session-id extractor paired with `listTranscriptFiles`. Defaults to the
     * Claude transcript-path parser; pass a harness-appropriate extractor when
     * the injected files are Codex/Cursor paths so session ids resolve correctly.
     */
    sessionIdFromPath?: (filePath: string) => string;
    /** Parser hook for keeping bulk backfill parsing off Electron's main process. */
    parseSessionFile?: (filePath: string) => Promise<NormalizedSession | null>;
    /** Cooperative pause between main-process maintenance writes. */
    cooperativeDelay?: (ms: number) => Promise<void>;
    /** Cancellation hook used by the desktop runtime stop/close lifecycle. */
    shouldContinue?: () => boolean;
  }
): Promise<BackfillResult> {
  const log = options?.log ?? (() => {});
  const pauseAfterWrite = () =>
    options?.cooperativeDelay?.(ARTIFACT_BACKFILL_WRITE_PAUSE_MS) ??
    Promise.resolve();
  const shouldContinue = options?.shouldContinue ?? (() => true);
  const result: BackfillResult = {
    captured: 0,
    deduped: 0,
    scanned: 0,
    skipped: 0,
    errors: 0,
    touchedForMarkers: 0,
    touchedForMarkerSessionIds: [],
  };
  const now = new Date().toISOString();

  let transcriptEntries: BackfillTranscriptEntry[];
  if (options?.listTranscriptFiles) {
    const parseTranscript = options.parseSessionFile ?? parseClaudeSession;
    const sessionIdFromPath = options.sessionIdFromPath ?? claudeSessionId;
    transcriptEntries = options.listTranscriptFiles().map((filePath) => ({
      filePath,
      sessionId: sessionIdFromPath(filePath),
      parse: parseTranscript,
    }));
  } else {
    const sources = options?.parseSessionFile
      ? BUILTIN_TRANSCRIPT_SOURCES.map((s) => ({
          ...s,
          parse: options.parseSessionFile!,
        }))
      : BUILTIN_TRANSCRIPT_SOURCES;
    transcriptEntries = await collectAllTranscriptEntries(
      sources,
      log,
      result,
      options?.cooperativeDelay
    );
  }

  if (transcriptEntries.length === 0) {
    await runMarkerTouchMaintenance(prisma, result, shouldContinue, now, {
      cooperativeDelay: options?.cooperativeDelay,
    });
    return result;
  }

  let existingSessionIds: Set<string> | null = null;
  try {
    const rows = await prisma.client.$queryRawUnsafe<{ id: string }[]>(
      "SELECT id FROM sessions"
    );
    existingSessionIds = new Set(rows.map((row) => row.id));
  } catch {
    existingSessionIds = null;
  }

  // FEA-2264: batch-load the whole backfill-seen table ONCE, the same way
  // `existingSessionIds` is loaded above, so the per-transcript mtime/version
  // skip check below is an in-memory Map lookup instead of a separate SQLite
  // read per transcript. A skip-heavy rescan over ~8k transcripts otherwise
  // fired thousands of `getBackfillSeen` round-trips on the db-host's single
  // synchronous JS thread (the dominant first-launch freeze). A null map means
  // the batch load failed, so the loop falls back to the per-row read.
  let seenBySessionId: Map<string, BackfillSeenRow> | null = null;
  try {
    const rows = await prisma.client.$queryRawUnsafe<
      ({ session_id: string } & RawBackfillSeenRow)[]
    >(
      "SELECT session_id, file_mtime_ms, extractor_version FROM artifact_link_backfill_seen"
    );
    seenBySessionId = new Map(
      rows.map((row) => [row.session_id, normalizeBackfillSeenRow(row)])
    );
  } catch {
    seenBySessionId = null;
  }

  // FEA-2777: build the repo resolver for the sweep instead of rebuilding it per
  // session (a full `SELECT … FROM repos` + two lookup Maps) inside every
  // per-transcript write transaction — the same per-row read cost the FEA-2264
  // seen-map batch-load already eliminated. Built from the read client outside
  // any write transaction; on failure leave it undefined so persistArtifactLinks
  // falls back to building it per session (unchanged behavior).
  //
  // The resolver is deliberately NOT snapshotted once for the whole sweep:
  // `repos` is not static for the sweep's duration. The startup sweep runs right
  // after collector import, and repo identity capture is fire-and-forget from
  // `onPostImport`, so rows can land in `repos` WHILE this loop runs. A single
  // up-front snapshot would miss them — bare repo refs for a just-captured repo
  // would persist without canonical `owner/repo`/`git_dir` and then be marked
  // seen at the current extractor version, so the sweep would never retry them
  // until the transcript changes. We refresh the resolver on the same fixed
  // cadence as the cooperative yield below (a few hundred refreshes over the
  // whole corpus — one cheap `SELECT … FROM repos` each, NOT the per-session
  // rebuild the perf fix removed), so mid-sweep captures become visible to later
  // write transactions.
  let repoResolver = await tryBuildRepoResolver(prisma);

  let transcriptsSinceYield = 0;
  // FEA-3568: staggers the per-session updated_at bump when a re-derivation
  // actually changes a segment's work_item_ref, so a full re-scan can't collapse
  // the sync cursor's top-group onto one timestamp (mirrors the re-tile backfill).
  let syncBumpIndex = 0;
  for (const {
    filePath,
    sessionId,
    parse: parseTranscript,
  } of transcriptEntries) {
    if (!shouldContinue()) {
      return result;
    }

    // FEA-2264: yield on a fixed cadence so a skip-heavy rescan (most
    // transcripts already seen at their current mtime/extractor version) still
    // returns control to the host event loop. The write path below yields via
    // `pauseAfterWrite`, but a skipped transcript `continue`s without ever
    // pausing, so without this a rescan of thousands of seen transcripts would
    // hold the db-host loop and re-freeze the dashboard. The cadence keeps the
    // added yields negligible (a few hundred over the whole corpus).
    if (++transcriptsSinceYield >= ARTIFACT_BACKFILL_YIELD_EVERY_TRANSCRIPTS) {
      transcriptsSinceYield = 0;
      await pauseAfterWrite();
      // FEA-2777: refresh the repo resolver on the yield cadence so repos
      // captured mid-sweep (fire-and-forget from `onPostImport`) become visible
      // to the transactions that follow. A rebuild that fails leaves the prior
      // resolver in place rather than reverting to per-session rebuilds.
      const refreshed = await tryBuildRepoResolver(prisma);
      if (refreshed) {
        repoResolver = refreshed;
      }
    }

    // Skip transcripts whose session has not been imported yet — there is no FK
    // target for their links. Counts as skipped (not an error) and is left
    // unseen so a later sweep retries once the session row exists.
    if (existingSessionIds && !existingSessionIds.has(sessionId)) {
      result.skipped++;
      continue;
    }

    // Stat the file for mtime-based skip check
    let mtimeMs: number;
    try {
      mtimeMs = Math.floor(statSync(filePath).mtimeMs);
    } catch {
      // File disappeared between listing and stat — preserve existing rows
      continue;
    }

    // Check if already scanned with current or newer extractor version. Uses
    // the batch-loaded seen map (FEA-2264) so this is an in-memory lookup, not a
    // per-transcript SQLite read; falls back to the per-row read only if the
    // batch load failed.
    try {
      const seen = seenBySessionId
        ? (seenBySessionId.get(sessionId) ?? null)
        : await getBackfillSeen(prisma, sessionId);
      if (!shouldContinue()) {
        return result;
      }
      if (
        seen &&
        seen.file_mtime_ms === mtimeMs &&
        seen.extractor_version >= EXTRACTOR_VERSION
      ) {
        result.skipped++;
        continue;
      }
    } catch {
      // DB read failure — skip this session to be safe
      result.errors++;
      continue;
    }

    result.scanned++;

    // Parse the transcript into a NormalizedSession
    let session: NormalizedSession | null;
    try {
      session = await parseTranscript(filePath);
    } catch {
      log(`artifact-link backfill: parse error for ${sessionId}`);
      result.errors++;
      continue;
    }

    if (!session) {
      // No usable timestamp — mark as seen so we don't retry every boot
      if (!shouldContinue()) {
        return result;
      }
      try {
        await prisma.write((client) =>
          client.$transaction((tx) =>
            markBackfillSeen(tx, sessionId, filePath, mtimeMs)
          )
        );
      } catch {
        result.errors++;
      }
      await pauseAfterWrite();
      continue;
    }

    // Extract artifact refs from the session
    const refs = extractArtifactRefs(session, now);
    const regularRefs = refs.filter((ref) => !ref.monitoredActivityOnly);
    if (!shouldContinue()) {
      return result;
    }

    try {
      await prisma.write((client) =>
        client.$transaction(async (tx) => {
          // FEA-3851 / ISS-5236: capture the pre-image of the re-derived links'
          // synced projection so a correction that moves no work_item_ref can
          // still re-enqueue the session for cloud sync — a method-ONLY flip
          // (e.g. a reviewed-PR link going pr_review_feedback_command →
          // pr_review_command, same target/relation) or an `observed_at`-ONLY
          // re-stamp off the source instead of the import clock.
          // `stampSegmentWorkItemRefs` below only detects work_item_ref changes,
          // so without this neither would bump sessions.updated_at and the stale
          // cloud row would never be replaced.
          const projectionsBefore = await readRederivedLinkProjections(
            tx,
            sessionId
          );
          await tx.$executeRawUnsafe(
            `DELETE FROM session_artifact_links
           WHERE session_id = $1
             AND method NOT IN (${NON_REDERIVED_LINK_METHODS_PLACEHOLDERS})`,
            sessionId,
            ...NON_REDERIVED_LINK_METHODS
          );
          const { captured, droppedUnresolvedBareRepo } =
            regularRefs.length === 0
              ? { captured: 0, droppedUnresolvedBareRepo: false }
              : await persistArtifactLinks(
                  tx,
                  sessionId,
                  regularRefs,
                  now,
                  log,
                  repoResolver
                );
          if (captured !== regularRefs.length) {
            throw new Error("partial artifact-link persistence");
          }
          const activityOnlyMetadataChanged =
            await replaceMonitoredActivityOnlyMetadata(tx, sessionId, refs);
          // FEA-2875: if a ref's non-null BARE repo name was null-dropped
          // (FEA-2866) because it doesn't resolve yet, the artifact still
          // persists (repo_full_name NULL) so `captured === refs.length` holds —
          // but stamping the session seen here would let the seen-guard skip it
          // on every later boot even after the repo lands in `repos`, and the
          // one-time repair sweep can't rescue a NULL repo_full_name. Leave such
          // a session unseen so a later sweep — the resolver is refreshed
          // mid-sweep and rebuilt each boot — retries it once the repo is
          // captured. Sessions whose bare name never resolves (ephemeral
          // worktree/temp dirs) are re-scanned each boot; the cooperative yields
          // above keep that off the freeze path.
          if (!droppedUnresolvedBareRepo) {
            await markBackfillSeen(tx, sessionId, filePath, mtimeMs);
          }
          // FEA-2272: re-derived links (incl. a slug now gone) must re-stamp this
          // session's existing segments, clearing a stale work_item_ref back to
          // NULL. Reads the just-written links; a no-op when the session has no
          // segments yet (FEA-2269 hasn't tiled it).
          const changedRefs = await stampSegmentWorkItemRefs(
            tx,
            sessionId,
            extractWorkItemOccurrences(session)
          );
          // FEA-3851 / ISS-5236: a link's synced payload can change on
          // re-derivation without any work_item_ref moving — its METHOD (which
          // the cloud maps to a branch-lifecycle boundary kind — ReviewFeedback
          // vs read-only), or its `observed_at` (which positions the timeline
          // instant itself). `changedRefs` alone misses both. Compare the
          // re-derived projection against the pre-image; either must re-enqueue.
          const projectionsAfter = await readRederivedLinkProjections(
            tx,
            sessionId
          );
          const linkProjectionsChanged = !areLinkProjectionsEqual(
            projectionsBefore,
            projectionsAfter
          );
          // FEA-3568: work_item_ref rides the cloud sync wire, but this backfill
          // writes only segment/link rows — it never touches the session row, so
          // the metadata sync lane (keyed on sessions.updated_at) would never
          // re-enqueue a ref that changed here (e.g. an extractor-version bump
          // re-deriving links on an unchanged transcript). Dirty-mark the session
          // in THIS transaction when a ref actually changed so the new tiling
          // reaches the cloud; staggered so a full re-scan can't collapse the
          // cursor's top-group.
          if (
            changedRefs > 0 ||
            linkProjectionsChanged ||
            activityOnlyMetadataChanged
          ) {
            await bumpSessionsUpdatedAt(
              tx,
              [sessionId],
              chunkWatermark(now, syncBumpIndex)
            );
            syncBumpIndex += 1;
          }
          result.captured += captured;
          result.deduped += regularRefs.length - captured;
        })
      );
    } catch {
      // One expected ref failed to persist. Keep the previous links/seen marker
      // transactionally intact and retry on a later sweep.
      log(`artifact-link backfill: persist failed for ${sessionId}`);
      result.errors++;
    }
    await pauseAfterWrite();
  }

  await runMarkerTouchMaintenance(prisma, result, shouldContinue, now, {
    cooperativeDelay: options?.cooperativeDelay,
  });
  log(
    `artifact-link backfill complete: scanned=${result.scanned} captured=${result.captured} deduped=${result.deduped} skipped=${result.skipped} errors=${result.errors} touchedForMarkers=${result.touchedForMarkers}`
  );
  return result;
}

const ARTIFACT_BACKFILL_WRITE_PAUSE_MS = 50;
// FEA-2264: cooperative-yield cadence for the per-transcript scan loop. Covers
// skip iterations (already-seen transcripts) that bypass the write-path pause,
// so a rescan can never hold the db-host loop for the whole corpus.
const ARTIFACT_BACKFILL_YIELD_EVERY_TRANSCRIPTS = 50;
const SESSION_ARTIFACT_MARKER_TOUCH_REVISION = 2;
const SESSION_ARTIFACT_MARKER_TOUCH_SOURCE_PREFIX = `desktop_session_artifact_markers:v${SESSION_ARTIFACT_MARKER_TOUCH_REVISION}:`;
const SESSION_ARTIFACT_MARKER_TOUCH_BATCH_SIZE = 100;
const SESSION_ARTIFACT_MARKER_TOUCH_MAX_PER_RUN = 500;

type MarkerTouchCandidateRow = {
  session_id: string;
  marker_state: string;
};

/** Returns whether a backfill summary changed the session projection payload. */
export function backfillChangedSessionProjection(
  summary: Pick<BackfillResult, "captured"> & Partial<BackfillResult>
): boolean {
  return summary.captured > 0 || (summary.touchedForMarkers ?? 0) > 0;
}

/**
 * Touches historical sessions whose marker-eligible local artifact links have
 * not been observed by this maintenance revision. The sync_state sentinel is
 * keyed by the marker-relevant projection so later qualifying links can advance
 * sessions.updated_at while unchanged projections stay idempotent.
 */
export async function touchSessionsWithArtifactMarkerLinks(
  prisma: DesktopPrisma,
  now: string,
  options?: {
    cooperativeDelay?: (ms: number) => Promise<void>;
    shouldContinue?: () => boolean;
  }
): Promise<string[]> {
  const shouldContinue = options?.shouldContinue ?? (() => true);
  const pauseAfterBatch = () =>
    options?.cooperativeDelay?.(ARTIFACT_BACKFILL_WRITE_PAUSE_MS) ??
    Promise.resolve();
  const touchedSessionIds: string[] = [];

  while (
    shouldContinue() &&
    touchedSessionIds.length < SESSION_ARTIFACT_MARKER_TOUCH_MAX_PER_RUN
  ) {
    const remainingLimit =
      SESSION_ARTIFACT_MARKER_TOUCH_MAX_PER_RUN - touchedSessionIds.length;
    const batchLimit = Math.min(
      SESSION_ARTIFACT_MARKER_TOUCH_BATCH_SIZE,
      remainingLimit
    );
    const candidates = await prisma.client.$queryRawUnsafe<
      MarkerTouchCandidateRow[]
    >(
      `
        SELECT projected.session_id, projected.marker_state
        FROM (
          SELECT marker_rows.session_id, GROUP_CONCAT(marker_rows.marker_key, char(10) ORDER BY marker_rows.marker_key ASC) AS marker_state
          FROM (
            SELECT
              s.id AS session_id,
              a.kind
                || '|relation=' || COALESCE(sal.relation, '')
                || '|repo=' || COALESCE(a.repo_full_name, '')
                || '|pr=' || COALESCE(a.pr_number, '')
                || '|sha=' || COALESCE(a.sha, '')
                || '|title=' || COALESCE(a.title, '')
                || '|linkObserved=' || COALESCE(sal.observed_at, '')
                || '|committed=' || COALESCE(a.committed_at, '')
                || '|artifactObserved=' || COALESCE(a.observed_at, '')
                || '|lastSeen=' || COALESCE(a.last_seen_at, '') AS marker_key
            FROM sessions s
            JOIN session_artifact_links sal ON sal.session_id = s.id
            JOIN artifacts a ON a.id = sal.artifact_id
            WHERE (
              (a.kind = 'commit' AND sal.relation = 'created' AND a.sha IS NOT NULL AND a.sha <> '')
              OR (
                a.kind = 'pull_request'
                AND sal.relation IN ('created', 'workspace')
                AND a.repo_full_name IS NOT NULL
                AND a.repo_full_name <> ''
                AND a.pr_number IS NOT NULL
              )
            )
          ) marker_rows
          GROUP BY marker_rows.session_id
        ) projected
        LEFT JOIN sync_state marker_seen
          ON marker_seen.source_key = $1 || projected.session_id || ':' || projected.marker_state
        WHERE marker_seen.source_key IS NULL
        ORDER BY projected.session_id ASC
        LIMIT $2
      `,
      SESSION_ARTIFACT_MARKER_TOUCH_SOURCE_PREFIX,
      batchLimit
    );
    const batchSessionIds = candidates.map((row) => row.session_id);
    if (batchSessionIds.length === 0) {
      break;
    }
    if (!shouldContinue()) {
      break;
    }

    await prisma.write((client) =>
      client.$transaction(async (tx) => {
        const updatePlaceholders = batchSessionIds
          .map((_, index) => `$${index + 2}`)
          .join(", ");
        await tx.$executeRawUnsafe(
          `UPDATE sessions SET updated_at = $1 WHERE id IN (${updatePlaceholders})`,
          now,
          ...batchSessionIds
        );
        for (const row of candidates) {
          await tx.$executeRawUnsafe(
            `INSERT OR IGNORE INTO sync_state
             (source_key, observed_top_updated_at, observed_ids_at_top_updated_at, data_revision, updated_at)
           VALUES ($1, $2, $3, $4, $5)`,
            `${SESSION_ARTIFACT_MARKER_TOUCH_SOURCE_PREFIX}${row.session_id}:${row.marker_state}`,
            now,
            "[]",
            SESSION_ARTIFACT_MARKER_TOUCH_REVISION,
            now
          );
        }
      })
    );
    touchedSessionIds.push(...batchSessionIds);
    await pauseAfterBatch();
  }

  return touchedSessionIds;
}

async function runMarkerTouchMaintenance(
  prisma: DesktopPrisma,
  result: BackfillResult,
  shouldContinue: () => boolean,
  now: string,
  options?: {
    cooperativeDelay?: (ms: number) => Promise<void>;
  }
): Promise<void> {
  if (!shouldContinue()) {
    return;
  }
  try {
    const touchedSessionIds = await touchSessionsWithArtifactMarkerLinks(
      prisma,
      now,
      {
        cooperativeDelay: options?.cooperativeDelay,
        shouldContinue,
      }
    );
    result.touchedForMarkers = touchedSessionIds.length;
    result.touchedForMarkerSessionIds = touchedSessionIds;
  } catch {
    result.errors++;
  }
}

// FEA-2777: build the repo resolver from the read-only client outside any write
// transaction. Returns undefined on failure so callers can fall back to
// per-session resolver builds (the pre-FEA-2777 behavior) or keep a prior
// resolver rather than reverting.
async function tryBuildRepoResolver(
  prisma: DesktopPrisma
): Promise<RepoResolver | undefined> {
  try {
    return await buildRepoResolver(prisma.client);
  } catch {
    return undefined;
  }
}

// FEA-3851 / ISS-5236: read the SYNCED PROJECTION of the links this backfill
// re-derives (everything except the preserved NON_REDERIVED_LINK_METHODS
// producers), keyed by the link identity `(artifact_id, relation)`. Compared
// before/after the delete-and-rederive so a correction that moves no
// `work_item_ref` — which is all `stampSegmentWorkItemRefs` can see — still
// re-enqueues the session for cloud sync.
//
// The projected columns mirror `SYNCED_CHILD_ROW_PROJECTIONS`'s
// `session_artifact_links` entry (`synced-child-row-fingerprint.ts`) on purpose:
// that list is the definition of "this link's wire payload changed", and the two
// gates guard the same corpus from opposite ends — the fingerprint gates the
// DATA_REVISION rebuild, this gates the EXTRACTOR_VERSION sweep. FEA-3851 needed
// only `method`; ISS-5236 adds `observed_at`, which rides the wire as
// `artifactRef.observedAt` and positions the branch-lifecycle instants, so an
// extractor-version bump that re-stamps it off the source (rather than the
// import clock) is a real payload change and must advance `updated_at` instead
// of healing local SQLite only. Encoded with `JSON.stringify` so the join is
// injective — a bare delimiter join would let a value containing the delimiter
// collide with a different tuple, the same trap the fingerprint's `json_array()`
// encoding exists to avoid.
async function readRederivedLinkProjections(
  tx: Prisma.TransactionClient,
  sessionId: string
): Promise<Map<string, string>> {
  const rows = await tx.$queryRawUnsafe<
    {
      artifact_id: string;
      relation: string;
      method: string;
      is_primary: number | bigint | boolean | null;
      status: string | null;
      observed_at: string | null;
      monitored_activity: string | null;
    }[]
  >(
    `SELECT artifact_id, relation, method, is_primary, status, observed_at,
            json_extract(evidence, '$.monitoredSessionActivity') AS monitored_activity
       FROM session_artifact_links
      WHERE session_id = $1
        AND method NOT IN (${NON_REDERIVED_LINK_METHODS_PLACEHOLDERS})`,
    sessionId,
    ...NON_REDERIVED_LINK_METHODS
  );
  const projectionByLink = new Map<string, string>();
  for (const row of rows) {
    projectionByLink.set(
      JSON.stringify([row.artifact_id, row.relation]),
      JSON.stringify([
        row.method,
        // `is_primary` arrives as 0/1, bigint, or boolean depending on the
        // driver; normalize so a driver difference cannot read as a change.
        Boolean(row.is_primary),
        row.status,
        row.observed_at,
        row.monitored_activity,
      ])
    );
  }
  return projectionByLink;
}

async function replaceMonitoredActivityOnlyMetadata(
  tx: Prisma.TransactionClient,
  sessionId: string,
  refs: Parameters<typeof monitoredActivityOnlyMetadata>[0]
): Promise<boolean> {
  const [row] = await tx.$queryRawUnsafe<{ metadata: string | null }[]>(
    "SELECT metadata FROM sessions WHERE id = $1",
    sessionId
  );
  const current = parseJsonObjectText(row?.metadata ?? null) ?? {};
  const next = { ...current };
  Reflect.deleteProperty(next, MONITORED_ACTIVITY_ONLY_METADATA_KEY);
  Object.assign(next, monitoredActivityOnlyMetadata(refs));
  const currentText = JSON.stringify(current);
  const nextText = JSON.stringify(next);
  if (currentText === nextText) {
    return false;
  }
  await tx.$executeRawUnsafe(
    "UPDATE sessions SET metadata = $1 WHERE id = $2",
    nextText,
    sessionId
  );
  return true;
}

// True when the two link→projection maps are identical (same links, same synced
// payload). A difference means the re-derivation added, removed, re-classified,
// or re-dated a link, so the session must re-sync so the cloud can replace the
// stale row.
function areLinkProjectionsEqual(
  before: Map<string, string>,
  after: Map<string, string>
): boolean {
  if (before.size !== after.size) {
    return false;
  }
  for (const [key, projection] of before) {
    if (after.get(key) !== projection) {
      return false;
    }
  }
  return true;
}
