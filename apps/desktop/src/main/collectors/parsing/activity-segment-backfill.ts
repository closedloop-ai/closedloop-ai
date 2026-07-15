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
 */
import { statSync } from "node:fs";
import type { Prisma } from "../../database/generated/client.js";
import type { DesktopPrisma } from "../../database/prisma-client.js";
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

const ACTIVITY_BACKFILL_WRITE_PAUSE_MS = 50;

export type ActivitySegmentBackfillResult = {
  scanned: number;
  captured: number;
  skipped: number;
  errors: number;
};

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
          await markActivitySegmentSeen(tx, sessionId, filePath, mtimeMs);
        })
      );
      result.captured += 1;
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
