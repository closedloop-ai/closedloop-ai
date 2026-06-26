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

import { createReadStream, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  addStorageTokenCounts,
  parseOptionalStorageTokenCount,
} from "../token-counts.js";

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
    return {
      entries: [],
      totalInput: 0,
      totalOutput: 0,
      totalCacheRead: 0,
      totalCacheWrite: 0,
    };
  }

  const entries: WorkflowJournalEntry[] = [];
  let rl: ReturnType<typeof createInterface> | null = null;
  try {
    rl = createInterface({
      input: createReadStream(filePath),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of rl) {
      const parsed = parseWorkflowLine(line);
      if (parsed) {
        entries.push(parsed);
      }
    }
  } finally {
    if (rl) {
      rl.close();
    }
  }

  return foldWorkflowEntries(entries);
}

function parseWorkflowLine(line: string): WorkflowJournalEntry | null {
  if (!line.trim()) {
    return null;
  }
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
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
  entries: WorkflowJournalEntry[]
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
  };
}
