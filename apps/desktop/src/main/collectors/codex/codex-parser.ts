/**
 * @file codex-parser.ts
 * @description Desktop file-I/O shell around the shared, browser-safe Codex
 * rollout parser core in `@repo/lib/harness` (FEA-2717; the core was ported
 * from `scripts/agent-monitor-codex/codex-parser.js`, logic preserved). This
 * module streams a Codex rollout JSONL file into the shared `parseCodexRollout`,
 * then adds the pieces that require local disk and are DB-import-specific (not
 * part of the cloud renderer's per-file parse): merging companion
 * `workflow-*.jsonl` journal tokens, stamping the source-file mtime, and reading
 * the burst-detection thresholds from the environment. Both the desktop and the
 * cloud renderer therefore run exactly one parser.
 *
 * Token usage in Codex `token_count` events is CUMULATIVE per session; the core
 * derives per-turn deltas. Model attribution follows CodexBar's rule
 * (`turn_context.model` authoritative). See the core for format details.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  collectCodexUsageIdentities,
  parseCodexRollout,
} from "@repo/lib/harness/codex/parse-codex";
import type { NormalizedParseQuality } from "@repo/lib/harness/parse-quality";
import {
  addStorageTokenCounts,
  InvalidTokenCountError,
} from "@repo/lib/harness/token-counts";
import type { NormalizedSession } from "@repo/lib/harness/types";
import { codexBurstWindowMs } from "../../../shared/codex-burst-window.js";
import { effectiveParsePolicy } from "../../parse-policy/effective-parse-policy.js";
import type { ParsePolicy } from "../../parse-policy/parse-policy.js";
import { foldChildParseQuality } from "../engine/parse-quality-scan.js";
import { stampFileCreatedAt } from "../file-created-at.js";
import {
  findWorkflowJournals,
  scanWorkflowJournal,
  type WorkflowScanResult,
} from "../parsing/codex-workflow-scanner.js";
import { sessionIdFromRolloutPath } from "./codex-home.js";

// `classify` stays part of this module's public surface (re-exported from the
// shared core) so existing importers keep resolving it here.
// biome-ignore lint/performance/noBarrelFile: preserves the module's public `classify` export after the core moved to @repo/lib/harness (FEA-2717)
export {
  type Classified,
  classify,
} from "@repo/lib/harness/codex/parse-codex";

/** Safe env variable read — returns null when unset or empty. */
function safeEnv(name: string): string | null {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export type ParseRolloutFileOptions = {
  mergeWorkflowJournalTokens?: boolean;
  /** Leading cumulative usage snapshots already owned by a present parent fork. */
  replayedUsageIdentities?: ReadonlySet<string>;
  /** ISS-7625: see `ParseCodexRolloutOptions.onUnreadableParse`. */
  onUnreadableParse?: (quality: NormalizedParseQuality) => void;
  /** ISS-12552: the policy to parse under; this process's current one by default. */
  parsePolicy?: ParsePolicy;
};

/**
 * Merge inner-agent token usage from companion Codex workflow journal files
 * into the session's per-model token totals (Gap 9). Desktop-only: it reads
 * sibling files from disk.
 */
async function mergeWorkflowJournalTokens(
  filePath: string,
  session: NormalizedSession
): Promise<void> {
  const sessionDir = path.dirname(filePath);
  const workflowJournals = findWorkflowJournals(sessionDir);
  for (const wfPath of workflowJournals) {
    try {
      const wfResult = await scanWorkflowJournal(wfPath);
      // FEA-2972/FEA-2979: fold this workflow journal's parse-quality into the
      // parent session's parseQuality BEFORE the token merge, so a corrupt
      // journal line — which silently drops that inner-agent's folded token
      // usage below — surfaces rather than reading as clean (a journal with only
      // a bad line has no entries yet still lost data). The shared
      // `foldChildParseQuality` helper discounts this journal's own benign
      // trailing truncation, mirroring the Claude subagent aggregation
      // (FEA-2905); only genuine mid-file corruption inflates the parent's
      // malformed count. This extraction folds into the RETURNED session's
      // `parseQuality` (the core computed the main-file counts, FEA-2717); the
      // core always sets it, so the guard is a type narrow for the optional field.
      if (session.parseQuality) {
        foldChildParseQuality(session.parseQuality, wfResult);
      }
      if (wfResult.entries.length === 0) {
        continue;
      }
      foldWorkflowJournalSpend(session, wfResult);
    } catch (error) {
      if (error instanceof InvalidTokenCountError) {
        throw error;
      }
      // Non-fatal — workflow journal may be incomplete
    }
  }
}

/**
 * Parse a single Codex rollout JSONL file into the normalized session object.
 * Returns null when the file carries no usable timestamp (mirrors
 * parseSessionFile's contract so importSession can treat both identically).
 */
export async function parseRolloutFile(
  filePath: string,
  options: ParseRolloutFileOptions = {}
): Promise<NormalizedSession | null> {
  const sessionId = sessionIdFromRolloutPath(filePath);

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  // Gap 11: Burst detection thresholds are configurable via env vars so users
  // can tune for their workload without code changes.
  // SYMPHONY_CODEX_BURST_RECORD_MIN — minimum records to trigger burst detection
  // SYMPHONY_CODEX_BURST_WINDOW_MS — time window for burst detection (ms)
  const session = await parseCodexRollout(rl, {
    sessionId,
    burstRecordMin: codexBurstRecordMin(),
    burstWindowMs: codexBurstWindowMs(),
    replayedUsageIdentities: options.replayedUsageIdentities,
    attributionEvidence: (options.parsePolicy ?? effectiveParsePolicy())
      .attributionEvidence,
    // ISS-7625: forwarded verbatim; this shell adds workflow-journal tokens and
    // `fileModifiedAt` to a session that EXISTS, and has nothing to add to the
    // no-timestamp path the core reports through here.
    ...(options.onUnreadableParse
      ? { onUnreadableParse: options.onUnreadableParse }
      : {}),
  });
  if (!session) {
    return null;
  }

  // Gap 9: Scan companion Codex workflow journal files for inner-agent token
  // usage and merge into the session's per-model token totals.
  if (options.mergeWorkflowJournalTokens !== false) {
    await mergeWorkflowJournalTokens(filePath, session);
  }

  try {
    const fileStats = fs.statSync(filePath);
    session.fileModifiedAt = fileStats.mtimeMs;
    stampFileCreatedAt(session, fileStats);
  } catch {
    /* non-fatal */
  }

  return session;
}

export async function collectRolloutUsageSnapshotIdentities(
  filePath: string
): Promise<Set<string>> {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  try {
    return await collectCodexUsageIdentities(rl);
  } finally {
    rl.close();
  }
}

/** The burst record minimum, read live (`SYMPHONY_CODEX_BURST_RECORD_MIN`). */
export function codexBurstRecordMin(): number {
  return Number(safeEnv("SYMPHONY_CODEX_BURST_RECORD_MIN") ?? "20");
}

/**
 * ISS-12036: the settings a Codex zero-session parse depends on, for the
 * catch-up cache's no-session mark (`FileCollector.zeroSessionParseKey`).
 */
export function codexZeroSessionParseKey(): string {
  return `burst:${codexBurstRecordMin()}:${codexBurstWindowMs()}`;
}

/**
 * Fold one workflow journal's spend into BOTH `tokensByModel` and
 * `tokenSeries` under the same `workflow-agent` key (Gap 9).
 *
 * ISS-12037: it has to land in both, because `sum(tokenSeries) +
 * tokenSeriesTruncation.droppedTokens === tokensByModel` is a declared
 * invariant of `NormalizedSession` (ISS-7534), and the two desktop token
 * stores are derived one from each side of it — `token_events` from the
 * series, `token_usage` from the aggregate — so an aggregate-only fold made
 * them permanently disagree on any Codex session that also had `token_count`
 * events. Reconciling downstream by matching MODEL NAMES instead cannot work:
 * the series and the aggregate are deliberately different vocabularies
 * (`buildTokensByModel` remaps `codex-auto-review` series rows onto the real
 * model, and Copilot and OpenCode key the two from different fields), so a
 * name match reads a re-keyed row as missing and synthesizes the same spend a
 * second time.
 *
 * The journal records no per-entry instant, so the record carries the
 * session's `startedAt` — the stamp the importer's own aggregate fallback
 * already uses for a series-less model (FEA-1459 Fix C). `inferred` marks it a
 * placeholder rather than an extracted model id, which is what keeps
 * `hasRealModel` from emitting a GenAI request span for a model named
 * `workflow-agent` (gen-ai-request-telemetry.ts).
 */
function foldWorkflowJournalSpend(
  session: NormalizedSession,
  wfResult: WorkflowScanResult
): void {
  const workflowKey = "workflow-agent";
  const existing = session.tokensByModel[workflowKey];
  session.tokensByModel[workflowKey] = {
    input: addStorageTokenCounts(
      existing?.input ?? 0,
      wfResult.totalInput,
      "workflow_input_tokens"
    ),
    output: addStorageTokenCounts(
      existing?.output ?? 0,
      wfResult.totalOutput,
      "workflow_output_tokens"
    ),
    cacheRead: addStorageTokenCounts(
      existing?.cacheRead ?? 0,
      wfResult.totalCacheRead,
      "workflow_cache_read_tokens"
    ),
    cacheWrite: addStorageTokenCounts(
      existing?.cacheWrite ?? 0,
      wfResult.totalCacheWrite,
      "workflow_cache_write_tokens"
    ),
  };
  if (!session.startedAt) {
    return;
  }
  session.tokenSeries.push({
    timestamp: session.startedAt,
    model: workflowKey,
    input: wfResult.totalInput,
    output: wfResult.totalOutput,
    cacheRead: wfResult.totalCacheRead,
    cacheWrite: wfResult.totalCacheWrite,
    inferred: true,
  });
}
