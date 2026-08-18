import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { LoopSessionOrigin } from "@closedloop-ai/loops-api/events";

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
 * is also a deterministic provenance signal (see {@link SessionOrigin}).
 */
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
 * Provenance of a parsed session, derived deterministically from whether the
 * stream-json `result` envelope was present:
 * - `harness_stdout` — captured stdout of a non-interactive `-p` run; Claude
 *   Code's authoritative {@link HarnessResult} is available.
 * - `persistent_transcript` — an interactive or imported
 *   `~/.claude/projects/**.jsonl` transcript; derived reconstruction only.
 */
export const SessionOrigin = LoopSessionOrigin;
export type SessionOrigin = LoopSessionOrigin;

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

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
  const modelUsage: HarnessResult["modelUsage"] = {};
  if (typeof value !== "object" || value === null) {
    return modelUsage;
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
  return modelUsage;
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

/**
 * Deterministic session provenance: `harness_stdout` when the stream-json
 * `result` envelope is present (authoritative cost available), else
 * `persistent_transcript`. Cheap — reuses the single result scan.
 */
export function detectSessionOrigin(
  harnessResult: HarnessResult | null
): SessionOrigin {
  return harnessResult
    ? SessionOrigin.HarnessStdout
    : SessionOrigin.PersistentTranscript;
}

/**
 * Status of a subscription rate-limit window as reported by a
 * `rate_limit_event`:
 * - `allowed` — within limits.
 * - `allowed_warning` — approaching a threshold (event-driven; the CLI only
 *   emits `utilization` at these warning points).
 * - `rejected` — the window is exhausted and requests are being blocked.
 */
export const RateLimitEventStatus = {
  Allowed: "allowed",
  AllowedWarning: "allowed_warning",
  Rejected: "rejected",
} as const;
export type RateLimitEventStatus =
  (typeof RateLimitEventStatus)[keyof typeof RateLimitEventStatus];

/**
 * Which subscription rate-limit window a `rate_limit_event` refers to. Mirrors
 * the CLI's `rateLimitType` (`SDKRateLimitInfo`): the 5-hour session window, the
 * rolling weekly window (all models + per-model Opus/Sonnet splits + the
 * overage-included weekly variant), or pay-as-you-go overage. Kept in sync with
 * the CLI union — a value we don't recognize narrows to `null` rather than
 * dropping the snapshot (see {@link parseRateLimitEvent}).
 */
export const RateLimitWindowType = {
  FiveHour: "five_hour",
  SevenDay: "seven_day",
  SevenDayOpus: "seven_day_opus",
  SevenDaySonnet: "seven_day_sonnet",
  SevenDayOverageIncluded: "seven_day_overage_included",
  Overage: "overage",
} as const;
export type RateLimitWindowType =
  (typeof RateLimitWindowType)[keyof typeof RateLimitWindowType];

/**
 * A point-in-time subscription session-limit snapshot extracted from the LATEST
 * `{"type":"rate_limit_event"}` record on a run's stdout capture.
 *
 * Coarser than the interactive statusline (event/threshold-driven, so
 * `utilization` is populated only at warning thresholds) — but it covers every
 * `--output-format stream-json` harness run with zero new infrastructure, using
 * the same stdout seam that {@link parseHarnessResult} scans. This is the raw,
 * boundary-safe extraction: it carries nothing credential-derived, and a
 * downstream store maps it into the renderer's window shape.
 */
export type RateLimitEventSnapshot = {
  status: RateLimitEventStatus;
  /**
   * Which window the snapshot refers to, or null. `rateLimitType` is optional on
   * the CLI's `SDKRateLimitInfo` (documented as requiring a newer Claude Code
   * build), so a valid event can arrive with only `status` (+ `utilization`).
   * We keep such an event with a null window rather than dropping it — a
   * downstream store maps a null window to its "unknown/current" slot.
   */
  rateLimitType: RateLimitWindowType | null;
  /** ISO-8601 reset time, or null when the event carried no valid reset. */
  resetsAt: string | null;
  /** Server-computed utilization when present (warning thresholds only). */
  utilization: number | null;
};

const RATE_LIMIT_STATUSES: readonly RateLimitEventStatus[] =
  Object.values(RateLimitEventStatus);
const RATE_LIMIT_WINDOW_TYPES: readonly RateLimitWindowType[] =
  Object.values(RateLimitWindowType);

/**
 * Narrow an unknown value to a member of a const-object enum's value list, or
 * null. `find` returns the matching literal, so the result narrows to `T`
 * without an assertion.
 */
function memberOrNull<T extends string>(
  members: readonly T[],
  value: unknown
): T | null {
  return members.find((member) => member === value) ?? null;
}

/**
 * Convert a Unix epoch (seconds) into an ISO-8601 string. Guards against the
 * `0` sentinel (which would otherwise render as 1970), non-finite values, and
 * out-of-range numbers that produce an invalid `Date`. Returns null on any of
 * these so a bad reset never fabricates a plausible-looking timestamp.
 */
function epochSecondsToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Extract the LATEST subscription session-limit snapshot from a run's stdout
 * capture by scanning `{"type":"rate_limit_event"}` records at the same seam as
 * {@link parseHarnessResult}. Every stream-json run (our Engineer harness and
 * any `-p` run) emits these on the output stream we already persist.
 *
 * Returns null when the capture holds no usable event — either none was emitted
 * (persistent transcripts and interactive runs never carry one), or every
 * `rate_limit_event` lacked a recognized `status`. `status` is the only field
 * the CLI marks required on `SDKRateLimitInfo`; `rateLimitType` is optional
 * (documented as version-gated) and is preserved as null when absent or
 * unrecognized rather than causing the snapshot to be dropped — a status-only
 * event still carries usable limit state. Never throws: records missing a valid
 * `status` are skipped, and the last usable event wins so the result reflects
 * the run's most recent limit state.
 */
export function parseRateLimitEvent(
  claudeWorkDir: string
): RateLimitEventSnapshot | null {
  let latest: RateLimitEventSnapshot | null = null;
  scanJsonlLines(claudeWorkDir, (entry) => {
    if (entry.type !== "rate_limit_event") {
      return;
    }
    const info = entry.rate_limit_info as Record<string, unknown> | undefined;
    if (!info) {
      return;
    }
    const status = memberOrNull(RATE_LIMIT_STATUSES, info.status);
    // `status` is the only required field; without a recognized one the record
    // carries no usable state, so skip it and keep the last usable event.
    if (status === null) {
      return;
    }
    latest = {
      status,
      // Optional on the CLI union: null (absent/unrecognized) is preserved, not
      // a reason to drop the snapshot.
      rateLimitType: memberOrNull(RATE_LIMIT_WINDOW_TYPES, info.rateLimitType),
      resetsAt: epochSecondsToIso(info.resetsAt),
      utilization: numberOrNull(info.utilization),
    };
  });
  return latest;
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
