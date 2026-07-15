/**
 * @file data-revision-rebuild.ts
 * @description FEA-1785 boot-time data-revision rebuild. After the initial
 * import pass settles, re-derives every session whose `data_revision` differs
 * from the current `DATA_REVISION` and whose source transcript still exists:
 * per-session transactional delete + re-parse + re-insert via the normal
 * import path. Sessions whose source is gone keep their derived rows and their
 * stale revision stamp (the durable marker), but their `session_analytics`
 * rollup IS recomputed from the stored `sessions.metadata` (FEA-2641) so
 * classification fixes reach them despite the missing source; active sessions
 * are skipped — the ordinary reimport path re-derives and stamps them. A
 * surviving source whose parse yields no session under current semantics
 * (e.g. the codex re-serialization burst signature) is an import artifact and
 * its local session row is deleted outright.
 */

import {
  type Harness,
  type HarnessCollector,
  type NormalizedSession,
  narrowHarness,
} from "../types.js";
import { DATA_REVISION } from "./data-revision.js";
import { isHistoricalParseWorkerParserOutputError } from "./historical-parse-worker-protocol.js";
import { isImportableCollectorSource } from "./source-admission.js";

const TERMINAL_STATUS_SET = new Set(["completed", "abandoned", "error"]);
const DATA_REVISION_REBUILD_WRITE_PAUSE_MS = 50;

export type DataRevisionRebuildDatabase = {
  listStaleRevisionSessions(
    currentRevision: number
  ): Promise<Array<{ id: string; harness: string | null; status: string }>>;
  rebuildSessionFromParse(
    session: NormalizedSession,
    harness: Harness
  ): Promise<{
    rebuilt: boolean;
    activeRace: boolean;
    storageReset?: boolean;
  }>;
  deleteSessionRow(sessionId: string): Promise<void>;
  /**
   * FEA-2641: optional hook — recompute `session_analytics` rollups from the
   * STORED session metadata for stale sessions whose source transcript no
   * longer exists (the rebuild cannot re-parse them, but the corrected rollup
   * SQL heals their human/agent classification from what is already in the DB).
   */
  recomputeAnalyticsRollups?(sessionIds: string[]): Promise<void>;
};

export type DataRevisionRebuildOptions = {
  collectors: readonly HarnessCollector[];
  db: DataRevisionRebuildDatabase;
  log?: (message: string) => void;
  /** Parser hook for keeping rebuild parsing off Electron's main process. */
  parseSource?: DataRevisionParseSource;
  /** Cooperative pause between main-process maintenance writes. */
  cooperativeDelay?: (ms: number) => Promise<void>;
  /** Cancellation hook used by the desktop runtime stop/close lifecycle. */
  shouldContinue?: () => boolean;
};

export type DataRevisionRebuildSummary = {
  staleTotal: number;
  rebuilt: number;
  deleted: number;
  skippedActive: number;
  raceSkipped: number;
  missingSource: number;
  unmatchedSource: number;
  parseErrors: number;
  errors: number;
  storageReset: boolean;
  /** FEA-2641: missing-source sessions whose analytics rollup was recomputed
   * from stored metadata (subset of missingSource; 0 when the db hook is
   * absent or the recompute failed). */
  missingSourceRollupsRecomputed: number;
};

export async function runDataRevisionRebuild(
  options: DataRevisionRebuildOptions
): Promise<DataRevisionRebuildSummary> {
  const log = options.log ?? (() => {});
  const parseSource =
    options.parseSource ?? ((collector, source) => collector.parse(source));
  const pauseAfterWrite = () =>
    options.cooperativeDelay?.(DATA_REVISION_REBUILD_WRITE_PAUSE_MS) ??
    Promise.resolve();
  const shouldContinue = options.shouldContinue ?? (() => true);
  const summary: DataRevisionRebuildSummary = {
    staleTotal: 0,
    rebuilt: 0,
    deleted: 0,
    skippedActive: 0,
    raceSkipped: 0,
    missingSource: 0,
    unmatchedSource: 0,
    parseErrors: 0,
    errors: 0,
    storageReset: false,
    missingSourceRollupsRecomputed: 0,
  };

  const stale = await options.db.listStaleRevisionSessions(DATA_REVISION);
  summary.staleTotal = stale.length;
  if (stale.length === 0 || !shouldContinue()) {
    return summary;
  }

  const pendingByHarness = groupTerminalStaleByHarness(stale, summary);

  const missingSourceIds: string[] = [];
  for (const collector of options.collectors) {
    const pending = pendingByHarness.get(collector.key);
    if (!pending?.size) {
      continue;
    }
    await rebuildHarness(
      collector,
      pending,
      options.db,
      summary,
      log,
      parseSource,
      pauseAfterWrite,
      shouldContinue
    );
    if (summary.storageReset) {
      break;
    }
    // Whatever is left has no surviving, positively-mapped source.
    summary.missingSource += pending.size;
    missingSourceIds.push(...pending);
    log(
      `data-revision rebuild [${collector.key}]: missingSource=${pending.size}`
    );
    pendingByHarness.delete(collector.key);
  }

  // Stale sessions whose harness has no collector (null/unknown) can never be
  // re-derived — count them with the missing-source population.
  if (!summary.storageReset) {
    for (const orphaned of pendingByHarness.values()) {
      summary.missingSource += orphaned.size;
      missingSourceIds.push(...orphaned);
    }
  }

  if (!summary.storageReset && shouldContinue()) {
    await recomputeMissingSourceRollups(
      options.db,
      missingSourceIds,
      summary,
      log
    );
  }

  log(
    `data-revision rebuild complete (revision ${DATA_REVISION}): stale=${summary.staleTotal} rebuilt=${summary.rebuilt} deleted=${summary.deleted} skippedActive=${summary.skippedActive} raceSkipped=${summary.raceSkipped} missingSource=${summary.missingSource} missingSourceRollupsRecomputed=${summary.missingSourceRollupsRecomputed} unmatchedSource=${summary.unmatchedSource} parseErrors=${summary.parseErrors} errors=${summary.errors} storageReset=${summary.storageReset}`
  );
  return summary;
}

/**
 * Group terminal stale sessions by harness key. Non-terminal sessions
 * (active, running, etc.) heal via ordinary reimport (which stamps the
 * revision) — rebuilding mid-capture would race the live write paths — so
 * they only bump `skippedActive`.
 */
function groupTerminalStaleByHarness(
  stale: Array<{ id: string; harness: string | null; status: string }>,
  summary: DataRevisionRebuildSummary
): Map<string, Set<string>> {
  const pendingByHarness = new Map<string, Set<string>>();
  for (const row of stale) {
    if (!TERMINAL_STATUS_SET.has(row.status)) {
      summary.skippedActive++;
      continue;
    }
    const key = row.harness ?? "";
    const existing = pendingByHarness.get(key);
    if (existing) {
      existing.add(row.id);
    } else {
      pendingByHarness.set(key, new Set([row.id]));
    }
  }
  return pendingByHarness;
}

/**
 * FEA-2641: sessions without a surviving source can't be re-parsed, but their
 * analytics rollup CAN be recomputed from the stored metadata — the corrected
 * human/agent classification must reach them too, or they keep their polluted
 * is_human forever. Their stale revision stamp is preserved (rows were not
 * re-derived from source), so this re-runs each boot over the small
 * missing-source population. Best-effort: a failure stays stale and retries
 * next boot.
 */
async function recomputeMissingSourceRollups(
  db: DataRevisionRebuildDatabase,
  missingSourceIds: string[],
  summary: DataRevisionRebuildSummary,
  log: (message: string) => void
): Promise<void> {
  if (missingSourceIds.length === 0 || !db.recomputeAnalyticsRollups) {
    return;
  }
  try {
    await db.recomputeAnalyticsRollups(missingSourceIds);
    summary.missingSourceRollupsRecomputed = missingSourceIds.length;
  } catch (error) {
    log(
      `data-revision rebuild: missing-source rollup recompute failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function rebuildHarness(
  collector: HarnessCollector,
  pending: Set<string>,
  db: DataRevisionRebuildDatabase,
  summary: DataRevisionRebuildSummary,
  log: (message: string) => void,
  parseSource: DataRevisionParseSource,
  pauseAfterWrite: () => Promise<void>,
  shouldContinue: () => boolean
): Promise<void> {
  // Narrow the discriminant: listSourcesForRebuild is batch-only,
  // sessionIdForSource is file-only. Each view is undefined for the other kind,
  // preserving the prior optional-chaining fallbacks.
  const { fileCollector, batchCollector } = narrowHarness(collector);
  const sources =
    batchCollector?.listSourcesForRebuild?.() ?? collector.listSources();
  const unmappedParserErrorPending = new Set<string>();
  for (const source of sources) {
    if (pending.size === 0) {
      return;
    }
    if (!shouldContinue()) {
      countUnmappedParserErrors(pending, summary, unmappedParserErrorPending);
      return;
    }
    if (!isImportableCollectorSource(collector, source)) {
      continue;
    }
    const sid = fileCollector?.sessionIdForSource?.(source) ?? null;
    if (sid === null) {
      await rebuildUnmappedSource(
        collector,
        source,
        pending,
        db,
        summary,
        log,
        parseSource,
        pauseAfterWrite,
        shouldContinue,
        unmappedParserErrorPending
      );
      continue;
    }
    if (!pending.has(sid)) {
      continue;
    }
    await rebuildMappedSource(
      collector,
      source,
      sid,
      pending,
      db,
      summary,
      log,
      parseSource,
      pauseAfterWrite,
      shouldContinue
    );
    if (summary.storageReset) {
      return;
    }
  }
  countUnmappedParserErrors(pending, summary, unmappedParserErrorPending);
}

function countUnmappedParserErrors(
  pending: Set<string>,
  summary: DataRevisionRebuildSummary,
  unmappedParserErrorPending: Set<string>
): void {
  for (const sid of unmappedParserErrorPending) {
    if (pending.delete(sid)) {
      summary.parseErrors++;
    }
  }
}

/**
 * A source that positively maps to a stale session id. If current parsers
 * yield no session for it, the row is an import artifact and is deleted
 * (FEA-1785 §4); the cloud copy is handled by FEA-1787's phantom purge.
 */
async function rebuildMappedSource(
  collector: HarnessCollector,
  source: string,
  sid: string,
  pending: Set<string>,
  db: DataRevisionRebuildDatabase,
  summary: DataRevisionRebuildSummary,
  log: (message: string) => void,
  parseSource: DataRevisionParseSource,
  pauseAfterWrite: () => Promise<void>,
  shouldContinue: () => boolean
): Promise<void> {
  if (!shouldContinue()) {
    return;
  }
  let sessions: NormalizedSession[];
  try {
    sessions = await parseSource(collector, source);
  } catch (error) {
    if (isHistoricalParseWorkerParserOutputError(error)) {
      summary.parseErrors++;
      pending.delete(sid);
      log(
        `data-revision rebuild [${collector.key}]: parseError=${sid} ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return; // unreadable mid-write file — stays stale, retried next boot
  }
  const match = sessions.find((s) => s.sessionId === sid);
  if (match) {
    if (!shouldContinue()) {
      return;
    }
    await applyRebuild(collector.key, match, pending, db, summary);
    if (summary.storageReset) {
      return;
    }
    await pauseAfterWrite();
    return;
  }
  if (sessions.length === 0) {
    // Empty parse: could be a burst artifact, an incomplete file, or a
    // no-timestamp source. Only delete with an explicit classifier.
    if (!collector.batch && collector.isBurstArtifactSource?.(source)) {
      if (!shouldContinue()) {
        return;
      }
      await db.deleteSessionRow(sid);
      summary.deleted++;
      pending.delete(sid);
      await pauseAfterWrite();
      log(
        `data-revision rebuild [${collector.key}]: deleted import artifact ${sid} (current parser skips its source)`
      );
    }
  } else {
    // Source parsed but no session matches the mapped id — distinct from
    // missing-source (file exists and parses fine).
    summary.unmatchedSource++;
    pending.delete(sid);
  }
}

/**
 * A source whose session id is unknowable from the path (copilot chat,
 * opencode batch store): parse, then rebuild any stale ids it contains.
 * Never deletes — there is no positive source→id mapping to justify it.
 */
async function rebuildUnmappedSource(
  collector: HarnessCollector,
  source: string,
  pending: Set<string>,
  db: DataRevisionRebuildDatabase,
  summary: DataRevisionRebuildSummary,
  log: (message: string) => void,
  parseSource: DataRevisionParseSource,
  pauseAfterWrite: () => Promise<void>,
  shouldContinue: () => boolean,
  unmappedParserErrorPending: Set<string>
): Promise<void> {
  if (!shouldContinue()) {
    return;
  }
  let sessions: NormalizedSession[];
  try {
    sessions = await parseSource(collector, source);
  } catch (error) {
    if (isHistoricalParseWorkerParserOutputError(error)) {
      for (const sid of pending) {
        unmappedParserErrorPending.add(sid);
      }
      log(
        `data-revision rebuild [${collector.key}]: parseError=unmapped-source ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return;
  }
  for (const session of sessions) {
    if (pending.size === 0 || !shouldContinue()) {
      return;
    }
    if (pending.has(session.sessionId)) {
      await applyRebuild(collector.key, session, pending, db, summary);
      if (summary.storageReset) {
        return;
      }
      await pauseAfterWrite();
    }
  }
}

async function applyRebuild(
  harness: Harness,
  session: NormalizedSession,
  pending: Set<string>,
  db: DataRevisionRebuildDatabase,
  summary: DataRevisionRebuildSummary
): Promise<void> {
  const result = await db.rebuildSessionFromParse(session, harness);
  if (result.storageReset) {
    summary.storageReset = true;
    return;
  }
  if (result.rebuilt) {
    summary.rebuilt++;
  } else if (result.activeRace) {
    summary.raceSkipped++;
  } else {
    summary.errors++;
  }
  pending.delete(session.sessionId);
}

export type DataRevisionParseSource = (
  collector: HarnessCollector,
  source: string
) => Promise<NormalizedSession[]>;
