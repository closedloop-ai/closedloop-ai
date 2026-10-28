/**
 * @file activity-segment-backfill.ts
 * @description FEA-2267 (PRD-488): versioned re-derivation of session activity
 * segments. Re-reads raw JSONL transcripts (Claude/Codex/Cursor via the shared
 * BUILTIN_TRANSCRIPT_SOURCES), classifies each session through the pure
 * `classifyActivitySegments`, and replaces its `session_activity_segments` rows
 * for sessions not yet scanned at the current ACTIVITY_CLASSIFIER_VERSION (or
 * whose transcript mtime changed). Mirrors `artifact-link-backfill.ts` almost
 * beat-for-beat: a marker table with an mtime + version high-water mark, a
 * version-bump full re-scan, and — since ISS-11088 — TWO prisma.write
 * transactions per session: the re-tile itself (segments + work-item stamps +
 * the activity-metrics rollup, committed together so the pair is never skewed),
 * then a publish transaction carrying the seen marker and the sync-lane
 * watermark (see {@link publishRetiledSession}). Cooperates with the desktop
 * stop/close lifecycle.
 *
 * SCOPE (FEA-4184): this classifier-version backfill only enumerates
 * BUILTIN_TRANSCRIPT_SOURCES, which is Claude/Codex/Cursor — the JSONL
 * file-per-session harnesses. Copilot (dual on-disk format) and OpenCode (batch
 * SQLite store) do not fit the file-list+per-file-parse `TranscriptSource` shape
 * and are NOT re-tiled here, so a lone ACTIVITY_CLASSIFIER_VERSION bump would
 * leave their sessions on the previous version. Those two harnesses re-derive
 * instead through the collector-driven DATA_REVISION rebuild
 * (`data-revision-rebuild.ts` → `rebuildSessionFromParse`, which re-runs
 * `classifyActivitySegments` at the current version): OpenCode via its
 * `listSourcesForRebuild` fingerprint bypass, Copilot via the unmapped-source
 * reparse. A classifier bump that must reach every harness therefore pairs with a
 * DATA_REVISION bump (see `docs/desktop-data-revision-history.md` rev 41).
 */
import { statSync } from "node:fs";
import { upsertActivityMetricsRollup } from "../../database/activity-metrics.js";
import type { Prisma } from "../../database/generated/client.js";
import type { DesktopPrisma } from "../../database/prisma-client.js";
import { stampSegmentWorkItemRefs } from "../../database/segment-work-item-stamp.js";
import { advanceSessionSyncWatermark } from "../../database/session-sync-watermark.js";
import { persistActivitySegments } from "../../database/write-core-import-phases-usage.js";
import { sessionIdFromTranscriptPath as claudeSessionId } from "../claude/claude-home.js";
import { parseSessionFile as parseClaudeSession } from "../claude/claude-parser.js";
import { Harness, type NormalizedSession } from "../types.js";
import {
  ACTIVITY_CLASSIFIER_VERSION,
  classifyActivitySegments,
} from "./activity-segment-classifier.js";
import { loadExistingSessionIds } from "./backfill-existing-sessions.js";
import {
  type BackfillTranscriptEntry,
  BUILTIN_TRANSCRIPT_SOURCES,
  collectTranscriptEntries,
} from "./transcript-sources.js";
import { extractWorkItemOccurrences } from "./work-item-occurrences.js";

const ACTIVITY_BACKFILL_WRITE_PAUSE_MS = 50;

export type ActivitySegmentBackfillResult = {
  scanned: number;
  captured: number;
  skipped: number;
  errors: number;
};

/** What {@link publishRetiledSession} needs to close out one re-tiled session. */
type RetilePublishInput = {
  sessionId: string;
  filePath: string;
  mtimeMs: number;
  /** Per-session sync watermark, read fresh at publish time (see
   * {@link createSyncWatermarkClock}). */
  syncWatermark: string;
};

/**
 * FEA-2273 / ISS-11088: the SECOND transaction of a re-tile — record the
 * backfill marker and advance the sync watermark, together.
 *
 * `sessions.updated_at` is what advertises a session to the metadata sync lane,
 * and since ISS-10721 the activity-metrics rollup rides that lane's payload. The
 * defect was the ORDER: the watermark was bumped in the re-tile transaction while
 * the rollup refresh ran in a separate later one, so a hydration read served in
 * that gap uploaded the NEW tiling with the OLD rollup and nothing was left to
 * re-enqueue the row.
 *
 * The fix has two halves, and the store-side half is now the load-bearing one:
 *
 *  - the ROLLUP commits WITH the segments it summarises, in the re-tile
 *    transaction, so no committed state ever pairs new segments with a stale
 *    rollup. That matters because ordering the advertisement alone would close
 *    the gap only for a reader entering through the `updated_at` cursor, and the
 *    sync lane also drains ids already sitting on its incremental and backfill
 *    queues, which are hydrated without re-consulting `updated_at`
 *    (whitlockk on #7865). A metrics failure now rolls the segments back with it;
 *    that is the intended trade — `persistActivitySegments` is idempotent and the
 *    next sweep re-tiles, so the cost is re-work, and what it buys is that a
 *    half-applied re-tile is never committed at all.
 *  - the MARKER and the WATERMARK ride here, after the re-tile committed. A
 *    THROWN failure must not leave the re-tile marked done, so with the marker in
 *    this transaction a failure leaves the session unseen and the next sweep
 *    re-tiles and retries. That retry does not depend on a classifier bump, nor
 *    on `backfillActivityMetrics`, whose predicate JOINs `session_analytics` and
 *    reads `session_activity_segments`, so it cannot re-select a session that
 *    tiled to zero segments or has no analytics rollup yet. The bump is the
 *    strictly-forward per-row `advanceSessionSyncWatermark` rather than the blind
 *    `SET updated_at` it was (the ISS-8758 rule): this transaction opens after
 *    the re-tile committed, so an import may have moved the row to a later stamp
 *    in between and a blind write would move it BACKWARDS, behind a cursor that
 *    has already read it.
 *
 * A DECLINED watermark advance is NOT a failure and is deliberately committed
 * (tamsinb on #7865). The decline is a pure function of the stored `updated_at`
 * — a legacy non-timestamp, or the four-digit-year ceiling — so re-running the
 * publish recomputes the same decline: retrying buys no advertisement, only an
 * unbounded re-parse-and-re-tile of that session on every sweep, forever, and a
 * permanently non-zero `errors`. The work itself is committed and internally
 * consistent, so committing the marker bounds the sweep and leaves the session to
 * be advertised by whatever write next moves the column into an orderable range.
 * It is logged and still counted as an error, so the run does not report itself
 * complete.
 */
async function publishRetiledSession(
  prisma: DesktopPrisma,
  input: RetilePublishInput,
  log: (message: string) => void
): Promise<RetilePublishOutcome> {
  let advertised = false;
  try {
    await prisma.write((client) =>
      client.$transaction(async (tx) => {
        await markActivitySegmentSeen(
          tx,
          input.sessionId,
          input.filePath,
          input.mtimeMs
        );
        advertised = await advanceSessionSyncWatermark(
          tx,
          input.sessionId,
          input.syncWatermark
        );
      })
    );
  } catch {
    log(`activity-segment backfill: publish failed for ${input.sessionId}`);
    return RetilePublishOutcome.Failed;
  }
  if (!advertised) {
    log(
      `activity-segment backfill: ${input.sessionId} re-tiled and rolled up, but its updated_at has no orderable successor, so the sync lane cannot be told until another write repairs that column`
    );
    return RetilePublishOutcome.Unadvertisable;
  }
  return RetilePublishOutcome.Published;
}

/**
 * Whether a backfill summary changed the session projection payload (any session
 * was re-tiled), so the runtime boundary can invalidate the renderer view.
 */
export function backfillChangedActivitySegmentProjection(
  summary: Pick<ActivitySegmentBackfillResult, "captured">
): boolean {
  return summary.captured > 0;
}

// `fileMtimeMs` is a BigInt? column (surfaces as `bigint | null` through the
// typed delegate); coerce to a JS number for the mtime comparison.
// `classifierVersion` is Int (number).
type ActivitySegmentSeen = {
  fileMtimeMs: number | null;
  classifierVersion: number;
};

// Bulk-load the backfill markers ONCE (typed delegate) into a Map, rather than a
// per-session SELECT inside the scan loop: the steady state (every session
// already seen at the current version) would otherwise cost O(N) round-trips on
// every boot. Mirrors the adjacent existingSessionIds bulk-load.
async function loadActivitySegmentSeen(
  prisma: DesktopPrisma
): Promise<Map<string, ActivitySegmentSeen>> {
  const rows = await prisma.client.activitySegmentBackfillSeen.findMany({
    select: { sessionId: true, fileMtimeMs: true, classifierVersion: true },
  });
  const map = new Map<string, ActivitySegmentSeen>();
  for (const row of rows) {
    map.set(row.sessionId, {
      fileMtimeMs: row.fileMtimeMs == null ? null : Number(row.fileMtimeMs),
      classifierVersion: row.classifierVersion,
    });
  }
  return map;
}

async function markActivitySegmentSeen(
  tx: Prisma.TransactionClient,
  sessionId: string,
  filePath: string,
  mtimeMs: number
): Promise<void> {
  // `file_mtime_ms` is BIGINT? — coerce the JS number to bigint for the delegate.
  const fields = {
    filePath,
    fileMtimeMs: BigInt(mtimeMs),
    classifierVersion: ACTIVITY_CLASSIFIER_VERSION,
    scannedAt: new Date().toISOString(),
  };
  await tx.activitySegmentBackfillSeen.upsert({
    where: { sessionId },
    create: { sessionId, ...fields },
    update: fields,
    select: { sessionId: true },
  });
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: transcript scanning + mtime/version HWM guard + atomic re-tile is inherently branchy (mirrors artifact-link-backfill)
export async function backfillActivitySegmentsFromTranscripts(
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
    /**
     * Harness the injected `listTranscriptFiles` belong to (FEA-2269: selects the
     * FEA-2268 evidence adapter for re-tiling). Defaults to Claude, matching the
     * default `sessionIdFromPath`/`parseSessionFile`. Ignored on the built-in
     * source path, where each source carries its own harness.
     */
    harness?: Harness;
    /** Parser hook for keeping bulk backfill parsing off Electron's main process. */
    parseSessionFile?: (filePath: string) => Promise<NormalizedSession | null>;
    /** Cooperative pause between main-process maintenance writes. */
    cooperativeDelay?: (ms: number) => Promise<void>;
    /** Cancellation hook used by the desktop runtime stop/close lifecycle. */
    shouldContinue?: () => boolean;
  }
): Promise<ActivitySegmentBackfillResult> {
  const log = options?.log ?? (() => {});
  const pauseAfterWrite = () =>
    options?.cooperativeDelay?.(ACTIVITY_BACKFILL_WRITE_PAUSE_MS) ??
    Promise.resolve();
  const shouldContinue = options?.shouldContinue ?? (() => true);
  const result: ActivitySegmentBackfillResult = {
    scanned: 0,
    captured: 0,
    skipped: 0,
    errors: 0,
  };
  const now = new Date().toISOString();

  let transcriptEntries: BackfillTranscriptEntry[];
  if (options?.listTranscriptFiles) {
    const parseTranscript = options.parseSessionFile ?? parseClaudeSession;
    const sessionIdFromPath = options.sessionIdFromPath ?? claudeSessionId;
    const injectedHarness = options.harness ?? Harness.Claude;
    transcriptEntries = options.listTranscriptFiles().map((filePath) => ({
      filePath,
      sessionId: sessionIdFromPath(filePath),
      harness: injectedHarness,
      parse: parseTranscript,
    }));
  } else {
    const sources = options?.parseSessionFile
      ? BUILTIN_TRANSCRIPT_SOURCES.map((s) => ({
          ...s,
          parse: options.parseSessionFile!,
        }))
      : BUILTIN_TRANSCRIPT_SOURCES;
    transcriptEntries = collectTranscriptEntries(sources, {
      log,
      logPrefix: "activity-segment backfill",
      onError: () => {
        result.errors++;
      },
    });
  }

  if (transcriptEntries.length === 0) {
    return result;
  }

  const existingSessionIds = await loadExistingSessionIds(prisma);

  // Snapshot of the per-session markers, taken once before the scan loop. Each
  // session is processed at most once per run, so a marker written below is never
  // re-read from this map in the same run. A load failure degrades to an empty
  // map (every session re-derived — idempotent), never a crash.
  let seenBySession: Map<string, ActivitySegmentSeen>;
  try {
    seenBySession = await loadActivitySegmentSeen(prisma);
  } catch {
    seenBySession = new Map();
  }

  // FEA-3568 / ISS-11088: the per-session sync-dirty stamp. Strictly increasing
  // so a version-bump full re-scan never collapses the sync cursor's top-group
  // onto a single timestamp, and read from the LIVE clock at publish time rather
  // than derived from this pass's base `now` (see {@link createSyncWatermarkClock}).
  const nextSyncWatermark = createSyncWatermarkClock();

  for (const {
    filePath,
    sessionId,
    harness,
    parse: parseTranscript,
  } of transcriptEntries) {
    if (!shouldContinue()) {
      return result;
    }

    // Skip transcripts whose session row does not exist yet — there is no FK
    // parent for their segments. Counts as skipped (not an error) and is left
    // unseen so a later sweep retries once the session row exists.
    if (existingSessionIds && !existingSessionIds.has(sessionId)) {
      result.skipped++;
      continue;
    }

    let mtimeMs: number;
    try {
      mtimeMs = Math.floor(statSync(filePath).mtimeMs);
    } catch {
      // File disappeared between listing and stat — preserve existing rows.
      continue;
    }

    // Skip when already scanned at an unchanged mtime AND a current-or-newer
    // classifier version (the mtime + version high-water mark). A version bump
    // makes every marker stale, so every session is re-scanned and re-tiled.
    const seen = seenBySession.get(sessionId);
    if (
      seen &&
      seen.fileMtimeMs === mtimeMs &&
      seen.classifierVersion >= ACTIVITY_CLASSIFIER_VERSION
    ) {
      result.skipped++;
      continue;
    }

    result.scanned++;

    let session: NormalizedSession | null;
    try {
      session = await parseTranscript(filePath);
    } catch {
      log(`activity-segment backfill: parse error for ${sessionId}`);
      result.errors++;
      continue;
    }

    if (!session) {
      // No usable session — mark seen so we don't re-parse it every boot.
      if (!shouldContinue()) {
        return result;
      }
      try {
        await prisma.write((client) =>
          client.$transaction((tx) =>
            markActivitySegmentSeen(tx, sessionId, filePath, mtimeMs)
          )
        );
      } catch {
        result.errors++;
      }
      await pauseAfterWrite();
      continue;
    }

    const segments = classifyActivitySegments(session, harness);
    if (!shouldContinue()) {
      return result;
    }

    try {
      await prisma.write((client) =>
        client.$transaction(async (tx) => {
          await persistActivitySegments(tx, sessionId, segments, now);
          // FEA-2272: a re-tile writes work_item_ref = NULL, so re-stamp the just
          // -written segments from the session's persisted links (a no-op when it
          // has none) to keep the optional label across classifier-version bumps.
          // The mention stream comes from the same parsed session the re-tile used,
          // so AA-10's per-segment resolution is identical on this path and import.
          await stampSegmentWorkItemRefs(
            tx,
            sessionId,
            extractWorkItemOccurrences(session)
          );
          // ISS-11088 (whitlockk on #7865): the rollup commits WITH the segments it
          // summarises, so the store is never in a new-segments/old-rollup state
          // at all. Ordering the advertisement after a separate rollup commit
          // closed that pair only for a reader entering through the
          // `updated_at` cursor; a session id already sitting on the sync lane's
          // incremental or backfill queue is hydrated without re-consulting
          // `updated_at` (`agent-session-sync-service.ts` incrementalQueue /
          // backfillQueue), and `loadSyncedSessions` reads segments and the
          // rollup on a reader connection that sees this transaction's commit.
          // Making the pair atomic is what closes that entry path too.
          await upsertActivityMetricsRollup(tx, sessionId, now);
        })
      );
      result.captured += 1;
      // ISS-11088: the re-tile is committed and durable, but nothing has
      // advertised it yet. The rollup refresh, the backfill marker and the
      // FEA-3568 sync-lane bump land together in the next transaction so the
      // session is never published carrying a rollup it has outgrown. The
      // watermark is read HERE, after the re-tile committed, so it is never
      // below a cursor that moved while this pass was parsing transcripts.
      const published = await publishRetiledSession(
        prisma,
        { sessionId, filePath, mtimeMs, syncWatermark: nextSyncWatermark() },
        log
      );
      if (published !== RetilePublishOutcome.Published) {
        result.errors += 1;
      }
    } catch {
      // The previous segments stay transactionally intact and the seen marker is
      // untouched, so a later sweep retries this session.
      log(`activity-segment backfill: persist failed for ${sessionId}`);
      result.errors++;
    }
    await pauseAfterWrite();
  }

  log(
    `activity-segment backfill complete: scanned=${result.scanned} captured=${result.captured} skipped=${result.skipped} errors=${result.errors}`
  );
  return result;
}

/**
 * ISS-11088 (tamsinb on #7865): the per-session sync watermark, read from the
 * LIVE clock at publish time rather than offset off the pass's base `now`.
 *
 * A classifier-version bump re-scans every transcript, which runs for minutes.
 * Live imports stamp the wall clock through their own
 * `advanceSessionSyncWatermark` calls, so the metadata sync lane's cursor can
 * pass this pass's start time mid-sweep. Every session published after that at
 * `runStart + k ms` then sits BELOW `updated_at > $1` in
 * `listUpdatedSessionCursorRows` and is never selected again —
 * `advanceSessionSyncWatermark` guards only against the row's OWN stored stamp,
 * not against the lane cursor. Since ISS-11088 the publish transaction is the
 * only thing that advertises a re-tile, so that stranding is permanent.
 *
 * The monotonic step keeps FEA-3485's other property: consecutive publishes
 * inside the same millisecond still get DISTINCT, strictly increasing stamps, so
 * a full re-scan never folds an O(corpus) set into the cursor's
 * `observedIdsAtTopUpdatedAt` group. `toISOString` millisecond precision matches
 * every other writer of this column, so lexical ordering stays chronological.
 */
function createSyncWatermarkClock(
  readNowMs: () => number = Date.now
): () => string {
  let lastMs = 0;
  return () => {
    const fresh = readNowMs();
    lastMs = fresh > lastMs ? fresh : lastMs + 1;
    return new Date(lastMs).toISOString();
  };
}

/**
 * How one re-tile's publish transaction ended. `Unadvertisable` is committed
 * work the sync lane cannot be told about (see {@link publishRetiledSession});
 * `Failed` is a thrown, rolled-back publish the next sweep retries. Both count
 * toward `errors`, so neither lets a run report itself complete.
 */
export const RetilePublishOutcome = {
  Published: "published",
  Unadvertisable: "unadvertisable",
  Failed: "failed",
} as const;
export type RetilePublishOutcome =
  (typeof RetilePublishOutcome)[keyof typeof RetilePublishOutcome];
