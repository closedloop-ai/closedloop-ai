import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Per-model token breakdown. */
export type ModelTokenUsage = {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
};

const CLAUDE_OUTPUT_FILE = "claude-output.jsonl";
const CLAUDE_OUTPUT_SIDECAR_FILE = "claude-output.name.txt";
const CLAUDE_OUTPUT_RENAMED_PREFIX = "claude-output-";
const CLAUDE_OUTPUT_RENAMED_SUFFIX = ".jsonl";

/**
 * Resolve the Claude JSONL output for a run.
 *
 * Resolution order:
 * 1. Sidecar-selected renamed output.
 * 2. Newest renamed output when the sidecar is absent/unreadable/stale.
 * 3. Legacy fixed-path `claude-output.jsonl`.
 *
 * An empty sidecar is a start-of-run sentinel, so it intentionally skips the
 * renamed-file scan and only falls through to the legacy fixed path.
 */
export function resolveClaudeOutputPath(claudeWorkDir: string): string | null {
  const legacyPath = path.join(claudeWorkDir, CLAUDE_OUTPUT_FILE);
  const sidecarPath = path.join(claudeWorkDir, CLAUDE_OUTPUT_SIDECAR_FILE);

  if (existsSync(sidecarPath)) {
    try {
      const sidecarValue = readFileSync(sidecarPath, "utf-8").trim();
      if (sidecarValue.length === 0) {
        return existsSync(legacyPath) ? legacyPath : null;
      }
      const resolvedSidecarPath = resolveSidecarOutputPath(
        claudeWorkDir,
        sidecarValue
      );
      if (resolvedSidecarPath !== null) {
        return resolvedSidecarPath;
      }
    } catch {
      // Fall through to renamed-file scan when the sidecar cannot be read.
    }
  }

  const newestRenamedPath = resolveNewestRenamedOutputPath(claudeWorkDir);
  if (newestRenamedPath !== null) {
    return newestRenamedPath;
  }

  return existsSync(legacyPath) ? legacyPath : null;
}

function resolveSidecarOutputPath(
  claudeWorkDir: string,
  sidecarValue: string
): string | null {
  if (path.basename(sidecarValue) !== sidecarValue) {
    return null;
  }
  if (
    !(
      sidecarValue.startsWith(CLAUDE_OUTPUT_RENAMED_PREFIX) &&
      sidecarValue.endsWith(CLAUDE_OUTPUT_RENAMED_SUFFIX)
    )
  ) {
    return null;
  }
  const candidate = path.join(claudeWorkDir, sidecarValue);
  if (!existsSync(candidate)) {
    return null;
  }
  try {
    return statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function resolveNewestRenamedOutputPath(claudeWorkDir: string): string | null {
  let newest: { path: string; mtimeMs: number; name: string } | null = null;
  let entries: string[];
  try {
    entries = readdirSync(claudeWorkDir);
  } catch {
    return null;
  }

  for (const name of entries) {
    if (
      !(
        name.startsWith(CLAUDE_OUTPUT_RENAMED_PREFIX) &&
        name.endsWith(CLAUDE_OUTPUT_RENAMED_SUFFIX)
      )
    ) {
      continue;
    }
    const candidate = path.join(claudeWorkDir, name);
    try {
      const stats = statSync(candidate);
      if (!stats.isFile()) {
        continue;
      }
      if (
        newest === null ||
        stats.mtimeMs > newest.mtimeMs ||
        (stats.mtimeMs === newest.mtimeMs && name > newest.name)
      ) {
        newest = { path: candidate, mtimeMs: stats.mtimeMs, name };
      }
    } catch {
      // Ignore entries that disappear or cannot be statted.
    }
  }
  return newest?.path ?? null;
}

/**
 * Outcome of iterating a Claude JSONL output file with {@link scanJsonlLines}.
 *
 * - `"missing"` — the file could not be resolved (not yet written or cleaned up).
 * - `"unreadable"` — the file exists but `readFileSync` threw; `error` carries
 *   the platform-specific message.
 * - `"completed"` — the file was read and every non-empty line was visited
 *   (whether the callback short-circuited or every line was processed).
 */
type ScanJsonlResult =
  | { outcome: "missing" }
  | { outcome: "unreadable"; error: string }
  | { outcome: "completed" };

/**
 * Resolve, read, and iterate the Claude JSONL output for a run, invoking
 * `onEntry` once per successfully-parsed line. Malformed lines are skipped.
 * Return `true` from `onEntry` to stop iteration early.
 *
 * Centralizes the `resolveClaudeOutputPath → readFileSync → split → JSON.parse`
 * pattern shared by {@link parseTokenUsage}, {@link detectSuccessFromOutput},
 * and {@link parseApiKeySource}, so fallback-resolution and read-error semantics
 * stay aligned across callers.
 */
function scanJsonlLines(
  claudeWorkDir: string,
  onEntry: (entry: Record<string, unknown>) => boolean | void
): ScanJsonlResult {
  const outputFile = resolveClaudeOutputPath(claudeWorkDir);
  if (outputFile === null) {
    return { outcome: "missing" };
  }
  let content: string;
  try {
    content = readFileSync(outputFile, "utf-8");
  } catch (err) {
    return {
      outcome: "unreadable",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  for (const line of content.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (onEntry(entry) === true) {
        break;
      }
    } catch {
      // Skip malformed lines
    }
  }
  return { outcome: "completed" };
}

/** Parse token usage from Claude JSONL stream output. */
export function parseTokenUsage(claudeWorkDir: string): {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  turns: number;
  models: string[];
  tokensByModel: Record<string, ModelTokenUsage>;
} {
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    turns: 0,
    models: [] as string[],
    tokensByModel: {} as Record<string, ModelTokenUsage>,
  };
  const modelSet = new Set<string>();
  const perModel = new Map<string, ModelTokenUsage>();
  scanJsonlLines(claudeWorkDir, (entry) => {
    if (entry.type !== "assistant") {
      return;
    }
    totals.turns += 1;
    const message = entry.message as Record<string, unknown> | undefined;
    const model =
      typeof message?.model === "string" && message.model.length > 0
        ? message.model
        : undefined;
    if (model) {
      modelSet.add(model);
    }
    const usage = message?.usage as Record<string, number> | undefined;
    if (!usage) {
      return;
    }
    const inputTk = usage.input_tokens ?? 0;
    const outputTk = usage.output_tokens ?? 0;
    const cacheCreationTk = usage.cache_creation_input_tokens ?? 0;
    const cacheReadTk = usage.cache_read_input_tokens ?? 0;
    totals.inputTokens += inputTk;
    totals.outputTokens += outputTk;
    totals.cacheCreationInputTokens += cacheCreationTk;
    totals.cacheReadInputTokens += cacheReadTk;
    if (!model) {
      return;
    }
    const existing = perModel.get(model);
    if (existing) {
      existing.input += inputTk;
      existing.output += outputTk;
      existing.cacheCreation += cacheCreationTk;
      existing.cacheRead += cacheReadTk;
    } else {
      perModel.set(model, {
        input: inputTk,
        output: outputTk,
        cacheCreation: cacheCreationTk,
        cacheRead: cacheReadTk,
      });
    }
  });
  totals.models = [...modelSet];
  totals.tokensByModel = Object.fromEntries(perModel);
  return totals;
}

/**
 * Outcome of a JSONL success-record scan.
 *
 * - `"success"` — a `{"type":"result","subtype":"success"}` record was found.
 * - `"missing"` — the JSONL output file could not be resolved (not yet written,
 *   or worktree was cleaned up).
 * - `"unreadable"` — the file exists but could not be read or parsed at the
 *   file level; `error` carries the underlying message.
 * - `"no-success"` — the file was read successfully but contained no success
 *   record.
 */
export type DetectSuccessOutcome =
  | { outcome: "success" }
  | { outcome: "missing" }
  | { outcome: "unreadable"; error: string }
  | { outcome: "no-success" };

/**
 * Scan the Claude JSONL output for a run and return a structured outcome
 * indicating whether a `{"type":"result","subtype":"success"}` record was
 * found, or why the check could not be completed.
 *
 * The JSONL file is read once synchronously; no retry or polling is performed
 * because the file is guaranteed to be flushed before the Claude Code process
 * exits.
 */
export function detectSuccessFromOutput(
  claudeWorkDir: string
): DetectSuccessOutcome {
  let success = false;
  const result = scanJsonlLines(claudeWorkDir, (entry) => {
    if (entry.type === "result" && entry.subtype === "success") {
      success = true;
      return true;
    }
  });
  if (result.outcome === "missing") {
    return { outcome: "missing" };
  }
  if (result.outcome === "unreadable") {
    return { outcome: "unreadable", error: result.error };
  }
  return success ? { outcome: "success" } : { outcome: "no-success" };
}

/** Extract apiKeySource from the init record in Claude JSONL stream output. */
export function parseApiKeySource(claudeWorkDir: string): string | null {
  let apiKeySource: string | null = null;
  scanJsonlLines(claudeWorkDir, (entry) => {
    if (
      entry.type === "system" &&
      entry.subtype === "init" &&
      typeof entry.apiKeySource === "string"
    ) {
      apiKeySource = entry.apiKeySource;
      return true;
    }
  });
  return apiKeySource;
}
