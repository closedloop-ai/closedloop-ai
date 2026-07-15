/**
 * @file codex-workflow-scanner.ts
 * @description Codex Workflow tool run journal scanner (Gap 9). Identifies
 * workflow journals by path convention (<sessionDir>/workflow-*.jsonl) and
 * parses inner-agent token usage. Merges the extracted token counts back into
 * the parent session's totals so cost attribution captures inner-agent spend.
 *
 * Codex Workflow sessions are distinct from regular Codex sessions: they run
 * tools that spawn sub-agents whose token consumption is recorded in separate
 * journal files rather than the main session transcript.
 */

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  addStorageTokenCounts,
  parseOptionalStorageTokenCount,
} from "../../token-counts.js";
import {
  createParseQualityScan,
  type ParseQualityScan,
  readJsonlLinesWithQuality,
} from "../engine/parse-quality-scan.js";

export type WorkflowJournalEntry = {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  sessionId: string | null;
};

export type WorkflowScanResult = {
  entries: WorkflowJournalEntry[];
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  /**
   * FEA-2979: parse-quality signal for the workflow journal itself, at parity
   * with the main rollout (FEA-2907) and the Claude subagent sidecars
   * (FEA-2905). A malformed inner-agent line silently drops that turn's folded
   * token usage, so the count must be surfaced to the parent session's
   * `parseQuality` rather than swallowed.
   */
  totalLines: number;
  malformedLines: number;
  /**
   * Whether the final non-blank line was malformed — the benign shape of a
   * truncated in-progress write. Callers discount it when folding into the
   * parent so only genuine mid-file corruption inflates the malformed count.
   */
  truncatedFinalLine: boolean;
};

const WORKFLOW_JOURNAL_GLOB = /^workflow-.+\.jsonl$/i;

/**
 * Detect workflow journal files in a session directory. Returns absolute paths
 * for every file matching the workflow journal naming convention.
 */
export function findWorkflowJournals(sessionDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(sessionDir);
  } catch {
    return [];
  }
  const journals: string[] = [];
  for (const entry of entries) {
    if (WORKFLOW_JOURNAL_GLOB.test(entry)) {
      const absPath = path.join(sessionDir, entry);
      try {
        if (statSync(absPath).isFile()) {
          journals.push(absPath);
        }
      } catch {
        /* race — skip */
      }
    }
  }
  return journals;
}

/**
 * Parse a single Codex workflow journal file and extract inner-agent
 * token usage records.
 */
export async function scanWorkflowJournal(
  filePath: string
): Promise<WorkflowScanResult> {
  try {
    statSync(filePath);
  } catch {
    return emptyScanResult();
  }

  const entries: WorkflowJournalEntry[] = [];
  // FEA-2979: stream through the shared parse-quality scanner so malformed
  // inner-agent lines are counted (not silently swallowed by a JSON.parse
  // try/catch) and can be folded into the parent session's parseQuality.
  const scan = createParseQualityScan();
  for await (const { entry } of readJsonlLinesWithQuality(filePath, scan)) {
    const parsed = parseWorkflowEntry(entry);
    if (parsed) {
      entries.push(parsed);
    }
  }

  return foldWorkflowEntries(entries, scan);
}

function parseWorkflowEntry(
  entry: Record<string, unknown>
): WorkflowJournalEntry | null {
  if (!extractTokenFields(entry)) {
    return null;
  }

  const model =
    typeof entry.model === "string" && entry.model.length > 0
      ? entry.model
      : "unknown";
  const input = coerceInt(entry.tokens_input ?? entry.tokensInput) ?? 0;
  const output = coerceInt(entry.tokens_output ?? entry.tokensOutput) ?? 0;
  const cacheRead =
    coerceInt(entry.tokens_cache_read ?? entry.tokensCacheRead) ?? 0;
  const cacheWrite =
    coerceInt(entry.tokens_cache_creation ?? entry.tokensCacheCreation) ?? 0;
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) {
    return null;
  }

  const journalSessionId =
    typeof entry.session_id === "string" && entry.session_id.length > 0
      ? entry.session_id
      : null;

  return {
    model,
    input,
    output,
    cacheRead,
    cacheWrite,
    sessionId: journalSessionId,
  };
}

function extractTokenFields(entry: Record<string, unknown>): boolean {
  if (
    entry.type === "usage" ||
    entry.type === "token_usage" ||
    entry.tokens_input ||
    entry.tokensOutput
  ) {
    return true;
  }
  if (typeof entry.usage !== "object" || entry.usage === null) {
    return false;
  }
  const u = entry.usage as Record<string, unknown>;
  entry.tokens_input = u.input_tokens ?? u.input ?? null;
  entry.tokensOutput = u.output_tokens ?? u.output ?? null;
  entry.tokensCacheRead = u.cache_read_input_tokens ?? u.cacheRead ?? null;
  entry.tokensCacheCreation =
    u.cache_creation_input_tokens ?? u.cacheWrite ?? null;
  return true;
}

function coerceInt(value: unknown): number | null {
  return parseOptionalStorageTokenCount(value, "workflow_token_count");
}

function foldWorkflowEntries(
  entries: WorkflowJournalEntry[],
  scan: ParseQualityScan
): WorkflowScanResult {
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  for (const e of entries) {
    totalInput = addStorageTokenCounts(
      totalInput,
      e.input,
      "workflow_input_tokens"
    );
    totalOutput = addStorageTokenCounts(
      totalOutput,
      e.output,
      "workflow_output_tokens"
    );
    totalCacheRead = addStorageTokenCounts(
      totalCacheRead,
      e.cacheRead,
      "workflow_cache_read_tokens"
    );
    totalCacheWrite = addStorageTokenCounts(
      totalCacheWrite,
      e.cacheWrite,
      "workflow_cache_write_tokens"
    );
  }
  return {
    entries,
    totalInput,
    totalOutput,
    totalCacheRead,
    totalCacheWrite,
    totalLines: scan.totalLines,
    malformedLines: scan.malformedLines,
    truncatedFinalLine: scan.lastLineMalformed,
  };
}

function emptyScanResult(): WorkflowScanResult {
  return {
    entries: [],
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalLines: 0,
    malformedLines: 0,
    truncatedFinalLine: false,
  };
}
