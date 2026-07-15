/**
 * @file transcript-sources.ts
 * @description Shared per-harness transcript source descriptors for backfills that
 * re-read raw JSONL transcripts. Currently consumed only by the activity-segment
 * derivation backfill (`activity-segment-backfill.ts`). NOTE: `artifact-link-backfill.ts`
 * still carries its OWN legacy copy of this Claude/Codex/Cursor
 * list+parse+sessionId triple (predating this extraction, and without the
 * `harness` field FEA-2269 added here); consolidating it onto this module so a new
 * harness is added exactly once is a pending follow-up, out of scope for FEA-2269.
 */
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
import { Harness, type NormalizedSession } from "../types.js";

export type TranscriptSource = {
  /** The harness this source's transcripts belong to (FEA-2269: selects the
   * FEA-2268 evidence adapter when re-tiling activity segments). */
  harness: Harness;
  listFiles: () => string[];
  sessionIdFromPath: (filePath: string) => string;
  parse: (filePath: string) => Promise<NormalizedSession | null>;
  sourceRoots: () => string[];
};

/** One importable transcript discovered across the configured sources. */
export type BackfillTranscriptEntry = {
  filePath: string;
  sessionId: string;
  /** Owning harness, carried from the source so backfill re-tiling stays
   * harness-aware (FEA-2269) rather than assuming Claude. */
  harness: Harness;
  parse: (filePath: string) => Promise<NormalizedSession | null>;
};

/**
 * Enumerate importable transcript entries across every source, skipping paths
 * outside their roots (source-admission) and logging per-source discovery
 * counts. Shared by the artifact-link and activity-segment backfills so the
 * enumeration + admission + logging plumbing lives in one place
 * (`logPrefix`/`onError` parameterize the only per-caller differences).
 */
export function collectTranscriptEntries(
  sources: TranscriptSource[],
  options: {
    log: (msg: string) => void;
    logPrefix: string;
    onError: () => void;
  }
): BackfillTranscriptEntry[] {
  const { log, logPrefix, onError } = options;
  const entries: BackfillTranscriptEntry[] = [];
  for (const source of sources) {
    let files: string[];
    try {
      files = source.listFiles();
    } catch (e) {
      log(
        `${logPrefix}: failed to list files for source (${source.sourceRoots()[0] ?? "unknown"}): ${e instanceof Error ? e.message : String(e)}`
      );
      onError();
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
        harness: source.harness,
        parse: source.parse,
      });
    }
    if (files.length > 0) {
      log(
        `${logPrefix}: discovered ${files.length} transcripts (${entries.length - beforeCount} importable) from ${roots[0] ?? "unknown"}`
      );
    }
  }
  return entries;
}

export const BUILTIN_TRANSCRIPT_SOURCES: TranscriptSource[] = [
  {
    harness: Harness.Claude,
    listFiles: listClaudeTranscripts,
    sessionIdFromPath: claudeSessionId,
    parse: parseClaudeSession,
    sourceRoots: () => [getProjectsDir()],
  },
  {
    harness: Harness.Codex,
    listFiles: listCodexTranscripts,
    sessionIdFromPath: codexSessionId,
    parse: parseCodexSession,
    sourceRoots: () => [getCodexSessionsDir(), getCodexArchivedDir()],
  },
  {
    harness: Harness.Cursor,
    listFiles: listCursorTranscripts,
    sessionIdFromPath: cursorSessionId,
    parse: parseCursorSession,
    sourceRoots: () => [getCursorProjectsDir()],
  },
];
