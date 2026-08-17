/**
 * @file activity-segment-backfill.ts
 * @description FEA-2267 (PRD-488): versioned re-derivation of session activity
 * segments. Re-reads raw JSONL transcripts (Claude/Codex/Cursor via the shared
 * BUILTIN_TRANSCRIPT_SOURCES), classifies each session through the pure
 * `classifyActivitySegments`, and replaces its `session_activity_segments` rows
 * for sessions not yet scanned at the current ACTIVITY_CLASSIFIER_VERSION (or
 * whose transcript mtime changed). Mirrors `artifact-link-backfill.ts` almost
 * beat-for-beat: a marker table with an mtime + version high-water mark, a
 * version-bump full re-scan, one atomic prisma.write($transaction) per session,
 * cooperating with the desktop stop/close lifecycle.
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
 * DATA_REVISION bump (see `data-revision.ts` rev 41).
 */
import { statSync } from "node:fs";
import { upsertActivityMetricsRollup } from "../../database/activity-metrics.js";
import type { Prisma } from "../../database/generated/client.js";
import type { DesktopPrisma } from "../../database/prisma-client.js";
import { stampSegmentWorkItemRefs } from "../../database/segment-work-item-stamp.js";
import {
  bumpSessionsUpdatedAt,
  chunkWatermark,
} from "../../database/session-sync-watermark.js";
import { persistActivitySegments } from "../../database/write-core.js";
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

/**
 * FEA-2273: best-effort refresh of one session's activity-metrics rollup after a
 * segment re-tile, in its OWN transaction. Decoupled from the re-tile so a metrics
 * failure never rolls the re-tile back or counts as a re-tile error; the
 * version-aware boot backfill (backfillActivityMetrics) re-derives it if this
 * fails.
 */
async function refreshActivityMetricsBestEffort(
  prisma: DesktopPrisma,
  sessionId: string,
  now: string,
  log: (message: string) => void
): Promise<void> {
  try {
    await prisma.write((client) =>
      client.$transaction((tx) =>
        upsertActivityMetricsRollup(tx, sessionId, now)
      )
    );
  } catch {
    log(`activity-segment backfill: metrics refresh failed for ${sessionId}`);
  }
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

  // FEA-3568: monotonic counter for staggering the per-session sync-dirty bump
  // (chunkWatermark) so a version-bump full re-scan never collapses the sync
  // cursor's top-group onto a single timestamp.
  let syncBumpIndex = 0;

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

    const syncWatermark = chunkWatermark(now, syncBumpIndex);
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
          await markActivitySegmentSeen(tx, sessionId, filePath, mtimeMs);
          // FEA-3568: the re-tile replaced this session's segments, but segment
          // writes don't touch the session row — so bump updated_at inside the
          // same transaction to re-enqueue the session on the metadata sync lane
          // (see write-core's SYNC INVARIANT). Staggered per re-tiled session so a
          // version-bump full re-scan can't collapse the sync cursor's top-group.
          await bumpSessionsUpdatedAt(tx, [sessionId], syncWatermark);
        })
      );
      result.captured += 1;
      syncBumpIndex += 1;
      // FEA-2273: the re-tile just changed this session's segments (possibly at a
      // new ACTIVITY_CLASSIFIER_VERSION), so refresh its metrics rollup — in a
      // SEPARATE best-effort transaction, decoupled from the re-tile above so a
      // metrics failure can neither roll the re-tile back nor count as a re-tile
      // error. The version-aware boot backfill is the safety net if this fails.
      await refreshActivityMetricsBestEffort(prisma, sessionId, now, log);
    } catch {
      // The previous segments + seen marker stay transactionally intact; retry
      // on a later sweep.
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
