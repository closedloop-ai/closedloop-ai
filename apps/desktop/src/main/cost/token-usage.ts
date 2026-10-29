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
 * pattern used by {@link parseHarnessResult}.
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

/**
 * One entry of the result envelope's `permission_denials` — a tool call Claude
 * Code refused to run under the run's permission mode.
 *
 * Deliberately NARROWER than the raw record: the CLI's `tool_input` carries the
 * refused call's arguments verbatim (file contents, shell commands, URLs), and
 * this value rides to the cloud in the completed-event payload. The accounting
 * signal is WHICH tool was denied and how often — not the payload — so
 * `tool_input` is dropped at the parse boundary rather than forwarded.
 */
export type HarnessPermissionDenial = {
  toolName: string;
  /** The denied call's id, or null when the record carried none. */
  toolUseId: string | null;
};

/**
 * Claude Code's authoritative per-session accounting, emitted as the final
 * `{"type":"result"}` record on stdout under `--output-format stream-json`
 * (see the leaked CLI `src/cli/print.ts`). This is Claude Code's OWN number —
 * the same total `/cost` reports — computed live from every API response, so it
 * already accounts for web-search requests and fast-mode pricing that a
 * transcript-derived reconstruction can miss.
 *
 * Present ONLY for non-interactive `-p` stdout captures. Persistent transcripts
 * (`~/.claude/projects/**.jsonl`) never carry a `result` record, so its presence
 * is also a deterministic provenance signal.
 */
export type HarnessResult = {
  /** `success` | `error_during_execution` | `error_max_turns` … */
  subtype: string | null;
  isError: boolean;
  /** Claude Code's authoritative total session cost (USD). */
  totalCostUsd: number | null;
  numTurns: number | null;
  durationMs: number | null;
  durationApiMs: number | null;
  stopReason: string | null;
  /** Session-total token usage from the result envelope (fresh-input shape). */
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    webSearchRequests: number;
  } | null;
  /** Per-model breakdown, verbatim from `result.modelUsage`. */
  modelUsage: Record<string, ModelTokenUsage & { costUsd: number | null }>;
  /**
   * Tool calls refused under the run's permission mode.
   *
   * `null` means UNKNOWN — the envelope carried no `permission_denials` array
   * (an older CLI, or a record shape we don't recognize). An empty array means
   * KNOWN-ZERO: the CLI reported the field and nothing was denied. Never
   * collapse the two; a missing field is not "no denials".
   */
  permissionDenials: HarnessPermissionDenial[] | null;
};

/**
 * A COUNT reported by the result envelope (tokens, turns): a non-negative
 * integer, or null when the value is absent or is not one.
 *
 * Counts are discrete, so a negative or fractional "count" is corrupt input,
 * not a number worth reporting. Callers must treat null as UNKNOWN and drop the
 * aggregate it belongs to — coercing it to 0 would turn corrupt JSONL into
 * plausible authoritative accounting, which is the whole hazard this envelope
 * is supposed to remove.
 */
function countOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * A non-negative finite MAGNITUDE (a duration in ms, a dollar cost), or null.
 *
 * Unlike a count these may legitimately be fractional, so only the sign and
 * finiteness are checked. A negative duration or cost cannot be true of a run
 * that happened, so it is rejected rather than stored.
 */
function nonNegativeOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Narrow `result.permission_denials` to valid entries, or null when the field
 * is absent/not an array (UNKNOWN — see {@link HarnessResult.permissionDenials}).
 *
 * Valid-or-absent per entry: an element without a usable `tool_name` carries no
 * signal, so it is skipped rather than stored as a partially-parsed denial. An
 * array whose every element is malformed still yields `[]` — the CLI did report
 * the field, so "known, and nothing usable in it" is the honest answer.
 */
function parsePermissionDenials(
  value: unknown
): HarnessPermissionDenial[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const denials: HarnessPermissionDenial[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const record = raw as Record<string, unknown>;
    const toolName = stringOrNull(record.tool_name);
    if (toolName === null) {
      continue;
    }
    denials.push({ toolName, toolUseId: stringOrNull(record.tool_use_id) });
  }
  return denials;
}

/**
 * Narrow `result.usage` into the session-total block, or null when the envelope
 * carried no usage or carried a corrupt one.
 *
 * Valid-or-absent: every one of the four token counters must parse as a
 * non-negative integer. If any is missing or corrupt the whole block is dropped
 * rather than stored with a fabricated `0` in the bad slot — a partially-zeroed
 * total reads downstream as a real session that used no tokens.
 *
 * `web_search_requests` is the one honest default: the CLI omits
 * `server_tool_use` entirely when no server tool ran, so an absent value is
 * KNOWN-ZERO. A present-but-corrupt one still drops the block.
 */
function parseHarnessUsage(value: unknown): HarnessResult["usage"] {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const input = countOrNull(raw.input_tokens);
  const output = countOrNull(raw.output_tokens);
  const cacheRead = countOrNull(raw.cache_read_input_tokens);
  const cacheWrite = countOrNull(raw.cache_creation_input_tokens);
  if (
    input === null ||
    output === null ||
    cacheRead === null ||
    cacheWrite === null
  ) {
    return null;
  }
  const serverToolUse = raw.server_tool_use as Record<string, unknown> | null;
  const rawWebSearch =
    typeof serverToolUse === "object" && serverToolUse !== null
      ? serverToolUse.web_search_requests
      : undefined;
  const webSearchRequests =
    rawWebSearch === undefined ? 0 : countOrNull(rawWebSearch);
  if (webSearchRequests === null) {
    return null;
  }
  return { input, output, cacheRead, cacheWrite, webSearchRequests };
}

/**
 * Narrow `result.modelUsage` into the per-model breakdown.
 *
 * Each row is valid-or-absent on its own: a row whose counters do not all parse
 * as non-negative integers is SKIPPED, never stored zero-filled, so a corrupt
 * row cannot masquerade as a model that ran for free. `costUSD` is nullable by
 * contract, so a corrupt cost narrows to null (UNKNOWN) while the row's still
 * valid token counts survive.
 */
function parseHarnessModelUsage(value: unknown): HarnessResult["modelUsage"] {
  // ISS-8565: null-prototype container so a key literally named `__proto__`
  // becomes an own property instead of hitting the inherited `__proto__`
  // setter, which creates no own key and silently drops the entry.
  const modelUsage: HarnessResult["modelUsage"] = Object.create(null);
  if (typeof value !== "object" || value === null) {
    return { ...modelUsage };
  }
  for (const [model, row] of Object.entries(value)) {
    if (typeof row !== "object" || row === null) {
      continue;
    }
    const m = row as Record<string, unknown>;
    const input = countOrNull(m.inputTokens);
    const output = countOrNull(m.outputTokens);
    const cacheRead = countOrNull(m.cacheReadInputTokens);
    const cacheCreation = countOrNull(m.cacheCreationInputTokens);
    if (
      input === null ||
      output === null ||
      cacheRead === null ||
      cacheCreation === null
    ) {
      continue;
    }
    modelUsage[model] = {
      input,
      output,
      cacheRead,
      cacheCreation,
      costUsd: nonNegativeOrNull(m.costUSD),
    };
  }
  // Spread restores a normal prototype for downstream consumers (object
  // spread defines rather than assigns, so an own `__proto__` key survives).
  return { ...modelUsage };
}

/**
 * Parse Claude Code's authoritative `{"type":"result"}` envelope from a run's
 * stdout capture. Returns `null` when no result record is present — which is
 * itself the signal that the session is a persistent transcript rather than a
 * harness stdout capture.
 *
 * The LAST result record wins. The harness APPENDS to `claude-output.jsonl`
 * when a work dir is reused, so a retried run's capture holds the previous
 * attempt's envelope ahead of its own. Stopping at the first record would post
 * the prior attempt's cost, turns, and permission denials as this run's
 * authoritative accounting — stale numbers presented as ground truth. Scanning
 * to end of file costs nothing extra: `scanJsonlLines` already reads the whole
 * capture into memory before iterating.
 */
export function parseHarnessResult(
  claudeWorkDir: string
): HarnessResult | null {
  let parsed: HarnessResult | null = null;
  scanJsonlLines(claudeWorkDir, (entry) => {
    if (entry.type !== "result") {
      return;
    }
    parsed = {
      subtype: stringOrNull(entry.subtype),
      isError: entry.is_error === true,
      totalCostUsd: nonNegativeOrNull(entry.total_cost_usd),
      numTurns: countOrNull(entry.num_turns),
      durationMs: nonNegativeOrNull(entry.duration_ms),
      durationApiMs: nonNegativeOrNull(entry.duration_api_ms),
      stopReason: stringOrNull(entry.stop_reason),
      usage: parseHarnessUsage(entry.usage),
      modelUsage: parseHarnessModelUsage(entry.modelUsage),
      permissionDenials: parsePermissionDenials(entry.permission_denials),
    };
  });
  return parsed;
}
