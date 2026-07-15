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
import {
  addStorageTokenCounts,
  InvalidTokenCountError,
} from "@repo/lib/harness/token-counts";
import type {
  NormalizedParseQuality,
  NormalizedSession,
  NormalizedTokenCounts,
} from "@repo/lib/harness/types";
import { foldChildParseQuality } from "../engine/parse-quality-scan.js";
import {
  findWorkflowJournals,
  scanWorkflowJournal,
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
};

/**
 * Merge inner-agent token usage from companion Codex workflow journal files
 * into the session's per-model token totals (Gap 9). Desktop-only: it reads
 * sibling files from disk.
 */
async function mergeWorkflowJournalTokens(
  filePath: string,
  tokensByModel: Record<string, NormalizedTokenCounts>,
  parseQuality: NormalizedParseQuality | undefined
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
      if (parseQuality) {
        foldChildParseQuality(parseQuality, wfResult);
      }
      if (wfResult.entries.length === 0) {
        continue;
      }
      // Merge workflow tokens into an aggregate model key
      const workflowKey = "workflow-agent";
      const existing = tokensByModel[workflowKey];
      tokensByModel[workflowKey] = {
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
  const burstRecordMin = Number(
    safeEnv("SYMPHONY_CODEX_BURST_RECORD_MIN") ?? "20"
  );
  const burstWindowMs = Number(
    safeEnv("SYMPHONY_CODEX_BURST_WINDOW_MS") ?? "5000"
  );

  const session = await parseCodexRollout(rl, {
    sessionId,
    burstRecordMin,
    burstWindowMs,
    replayedUsageIdentities: options.replayedUsageIdentities,
  });
  if (!session) {
    return null;
  }

  // Gap 9: Scan companion Codex workflow journal files for inner-agent token
  // usage and merge into the session's per-model token totals.
  if (options.mergeWorkflowJournalTokens !== false) {
    await mergeWorkflowJournalTokens(
      filePath,
      session.tokensByModel,
      session.parseQuality
    );
  }

  try {
    session.fileModifiedAt = fs.statSync(filePath).mtimeMs;
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
