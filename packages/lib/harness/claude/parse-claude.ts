/**
 * @file parse-claude.ts
 * @description Browser-safe Claude Code transcript parser core (FEA-1503; ported
 * from the vendor `scripts/import-history.js` `parseSessionFile`, logic
 * preserved; extracted to `@repo/lib/harness` for FEA-2717). Consumes an
 * (async) iterable of JSONL lines — the desktop shell streams them from a file,
 * the cloud renderer splits the archived transcript — and produces the shared
 * `NormalizedSession`. The desktop-only sidecar-subagent-file merge, mtime read,
 * and path handling stay in `apps/desktop/.../claude-parser.ts`; the pure
 * helpers that merge needs (`extractDedupedUsage`, `createSidecarSubagent`,
 * `parseJsonValue`, `isoTs`, `asRecord`) are exported here so both surfaces run
 * exactly one parser.
 *
 * FEA-1459: Token usage is deduped by (message.id, requestId). Claude Code writes
 * one JSONL line per content block, all sharing the same message.id and the same
 * final usage snapshot — naive per-line sum inflates 2.8-3.5× typical, 68× worst.
 * After the scan, the dedup map is folded into tokensByModel and tokenSeries.
 */
import {
  baseName,
  collectArtifacts,
  computeLineDelta,
  stringValue,
  truncateText,
} from "../parser-utils";
import { InvalidTokenCountError, readStorageTokenCount } from "../token-counts";
import type {
  NormalizedApiError,
  NormalizedDiffStats,
  NormalizedMessage,
  NormalizedSession,
  NormalizedSubagent,
  NormalizedToolResultError,
  NormalizedToolUse,
  NormalizedTurnDuration,
} from "../types";
import { createNormalizedSession } from "../types";
import {
  foldDedupMap,
  recordUsageLine,
  type UsageDedupEntry,
} from "../usage-dedup";

/**
 * FEA-1899: strips the Read tool's "<n>\t" line-number prefix back to raw file
 * text so a later Write of the same path diffs against the underlying content.
 */
const READ_LINE_NUMBER_PREFIX_RE = /^\s*\d+\t/;
const CLAUDE_SUBAGENT_FILE_PREFIX_RE = /^agent-/;

/**
 * FEA-2641: first-match extraction of the expanded slash-command XML the
 * harness injects for command turns, so a wake-up re-injection can be matched
 * back to its recorded ScheduleWakeup prompt. `<command-name>` content already
 * includes the leading slash; `<command-args>` may be empty.
 */
const COMMAND_NAME_TAG_RE = /<command-name>([^<]+)<\/command-name>/;
const COMMAND_ARGS_TAG_RE = /<command-args>([^<]*)<\/command-args>/;

/**
 * Marker prefix for local command OUTPUT echoed back under the `user` role.
 * Shared by isAutomatedPromptInjection (excludes it from human turns) and
 * isLocalCommandStdout (records it as a role:"system" message) so the two
 * classifications can never drift apart.
 */
const LOCAL_COMMAND_STDOUT_PREFIX = "<local-command-stdout>";

/**
 * FEA-3112 (semantic ruling: echoes are system messages): a
 * `<local-command-stdout>` entry is local command OUTPUT echoed back under the
 * `user` role — not human input, so it is excluded from human turns (via
 * isAutomatedPromptInjection). But it IS part of the transcript, so rather than
 * dropping it we record it as a role:"system" message (rendered as a
 * SystemMessage in the session-detail trace). This keeps the transcript faithful
 * while never crediting a human turn or inflating the is_human/human_turns count
 * (which counts only role:"human" over $.messages).
 */
function isLocalCommandStdout(text: string): boolean {
  return text.trim().startsWith(LOCAL_COMMAND_STDOUT_PREFIX);
}

/** Mirror the vendor's lenient timestamp handling: epoch number → ISO, string as-is. */
export function isoTs(ts: unknown): string | null {
  if (ts == null) {
    return null;
  }
  if (typeof ts === "number") {
    return new Date(ts).toISOString();
  }
  if (typeof ts === "string") {
    return ts;
  }
  return null;
}

/**
 * The Claude parser's tolerant record coercion: non-objects become `{}` (never
 * null), so downstream field reads no-op instead of throwing. Deliberately
 * different from the shared `asRecord` in `../type-guards.js`, which returns
 * null. Exported for the desktop shell's `collectEntriesFromFile`.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/** Parse a JSON string, returning `undefined` on failure. */
export function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function tokenCount(value: unknown, fieldName: string): number {
  return readStorageTokenCount(value, fieldName);
}

/**
 * FEA-1459: Extract deduped token usage from a stream of parsed JSONL entries.
 * Uses the shared usage-dedup module for the canonical dedup key formula and
 * accumulation logic. Returns the dedup map; caller folds via `foldDedupMap`.
 */
export function extractDedupedUsage(
  entries: Array<{ entry: Record<string, unknown>; iso: string | null }>
): Map<string, UsageDedupEntry> {
  const dedupMap = new Map<string, UsageDedupEntry>();
  for (const { entry, iso } of entries) {
    const msg = asRecord(entry.message);
    const msgModel = typeof msg.model === "string" ? msg.model : null;
    if (!msgModel || msgModel === "<synthetic>" || !msg.usage) {
      continue;
    }
    const usage = asRecord(msg.usage);
    const messageId =
      typeof msg.id === "string" && msg.id.length > 0 ? msg.id : null;
    const requestId =
      typeof entry.requestId === "string" && entry.requestId.length > 0
        ? entry.requestId
        : null;
    const lineUuid =
      typeof entry.uuid === "string" && entry.uuid.length > 0
        ? entry.uuid
        : null;
    // Canonical fresh shape (see NormalizedTokenCounts): Anthropic reports
    // `input_tokens` as FRESH/uncached with cache_read/cache_creation as
    // separate additive fields, so we store them verbatim — no subtraction.
    recordUsageLine(dedupMap, {
      messageId,
      lineUuid,
      requestId,
      timestamp: iso ?? "",
      model: msgModel,
      input: tokenCount(usage.input_tokens, "input_tokens"),
      output: tokenCount(usage.output_tokens, "output_tokens"),
      cacheRead: tokenCount(
        usage.cache_read_input_tokens,
        "cache_read_input_tokens"
      ),
      cacheWrite: tokenCount(
        usage.cache_creation_input_tokens,
        "cache_creation_input_tokens"
      ),
    });
  }
  return dedupMap;
}

/**
 * Mutable accumulator shared by every per-entry / per-block / per-tool handler
 * below. Collecting the whole scan state in one object lets the line loop
 * delegate to small typed handlers (entry-type registry → content-block
 * dispatch → tool-name registry) instead of one mega-branch — the cyclomatic
 * complexity hotspot this module was carved out for. Behavior is unchanged.
 */
type SessionAccumulator = {
  cwd: string | null;
  model: string | null;
  version: string | null;
  slug: string | null;
  gitBranch: string | null;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  entrypoint: string | null;
  permissionMode: string | null;
  userMessageCount: number;
  thinkingBlockCount: number;
  // CR-4: aggregate diff stats
  totalAdded: number;
  totalRemoved: number;
  readonly teams: Set<string>;
  readonly serviceTiers: Set<string>;
  readonly speeds: Set<string>;
  readonly inferenceGeos: Set<string>;
  readonly diffFiles: Set<string>;
  readonly toolUses: NormalizedToolUse[];
  readonly compactions: Array<{
    uuid: string | null;
    timestamp: string | null;
  }>;
  readonly apiErrors: NormalizedApiError[];
  readonly turnDurations: NormalizedTurnDuration[];
  readonly toolResultErrors: NormalizedToolResultError[];
  // CR-1: ordered messages
  readonly messages: NormalizedMessage[];
  // FEA-1459: Collect assistant entries for deduped usage extraction.
  readonly assistantEntries: Array<{
    entry: Record<string, unknown>;
    iso: string | null;
  }>;
  // CR-7: slash commands
  readonly slashCommands: Array<{ name: string; timestamp: string }>;
  // CR-3: map tool_use_id → index in toolUses for back-linking tool results
  readonly toolUseIdIndex: Map<string, number>;
  // FEA-1899 (AC-5): most recent Read result content per file path, so a Write
  // that overwrites a previously-read file diffs Read-vs-Write instead of
  // counting the whole new file as additions. Stored untruncated and with the
  // Read tool's "<n>\t" line-number prefixes stripped back to raw file text.
  readonly readContentByPath: Map<string, string>;
  readonly subagents: Map<string, NormalizedSubagent>;
  // FEA-2641: prompts recorded from ScheduleWakeup tool_use inputs, keyed by
  // prompt text with a pending-firing count. Each scheduled wake-up fires (and
  // re-injects its prompt as a `user` entry) at most once, so matching
  // CONSUMES one count — a later GENUINE typed prompt with identical text is
  // not swallowed once every recorded firing has been matched.
  readonly scheduledPrompts: Map<string, number>;
};

function createAccumulator(): SessionAccumulator {
  return {
    cwd: null,
    model: null,
    version: null,
    slug: null,
    gitBranch: null,
    firstTimestamp: null,
    lastTimestamp: null,
    entrypoint: null,
    permissionMode: null,
    userMessageCount: 0,
    thinkingBlockCount: 0,
    totalAdded: 0,
    totalRemoved: 0,
    teams: new Set<string>(),
    serviceTiers: new Set<string>(),
    speeds: new Set<string>(),
    inferenceGeos: new Set<string>(),
    diffFiles: new Set<string>(),
    toolUses: [],
    compactions: [],
    apiErrors: [],
    turnDurations: [],
    toolResultErrors: [],
    messages: [],
    assistantEntries: [],
    slashCommands: [],
    toolUseIdIndex: new Map<string, number>(),
    readContentByPath: new Map<string, string>(),
    subagents: new Map<string, NormalizedSubagent>(),
    scheduledPrompts: new Map<string, number>(),
  };
}

/** CR-7: Scan a text blob for <command-name> slash-command tags. */
function appendSlashCommands(
  acc: SessionAccumulator,
  text: string,
  timestamp: string | null
): void {
  if (!timestamp) {
    return;
  }
  const cmdRe = /<command-name>([^<]+)<\/command-name>/g;
  let cmdMatch: RegExpExecArray | null;
  while ((cmdMatch = cmdRe.exec(text)) !== null) {
    acc.slashCommands.push({ name: cmdMatch[1].trim(), timestamp });
  }
}

/**
 * Non-type-specific per-line capture: compaction markers, both API-error shapes,
 * the six session-metadata fields, timestamp bounds, and team membership. Runs
 * for every entry before entry-type dispatch, preserving the original flat-loop
 * order (metadata + timestamp are captured before the user/assistant handlers).
 */
function captureCommonMetadata(
  acc: SessionAccumulator,
  entry: Record<string, unknown>
): void {
  if (entry.isCompactSummary) {
    acc.compactions.push({
      uuid: (entry.uuid as string) || null,
      timestamp: (entry.timestamp as string) || null,
    });
  }

  // isApiErrorMessage entries (quota/rate limits, invalid_request).
  if (entry.isApiErrorMessage) {
    const message = asRecord(entry.message);
    const errContent = Array.isArray(message.content) ? message.content : [];
    const first = asRecord(errContent[0]);
    const errText =
      typeof first.text === "string"
        ? first.text.slice(0, 500)
        : "Unknown error";
    acc.apiErrors.push({
      type: (entry.error as string) || "unknown_error",
      message: errText,
      timestamp: isoTs(entry.timestamp),
    });
  }
  // Raw API error responses (type: "error" at message level).
  const rawMsg = asRecord(entry.message ?? entry);
  if (rawMsg.type === "error" && rawMsg.error) {
    const err = asRecord(rawMsg.error);
    acc.apiErrors.push({
      type: (err.type as string) || "unknown_error",
      message: (err.message as string) || "Unknown API error",
      timestamp: isoTs(entry.timestamp),
    });
  }

  if (!acc.cwd && typeof entry.cwd === "string") {
    acc.cwd = entry.cwd;
  }
  if (!acc.slug && typeof entry.slug === "string") {
    acc.slug = entry.slug;
  }
  if (!acc.gitBranch && typeof entry.gitBranch === "string") {
    acc.gitBranch = entry.gitBranch;
  }
  if (!acc.version && typeof entry.version === "string") {
    acc.version = entry.version;
  }
  if (!acc.entrypoint && typeof entry.entrypoint === "string") {
    acc.entrypoint = entry.entrypoint;
  }
  if (!acc.permissionMode && typeof entry.permissionMode === "string") {
    acc.permissionMode = entry.permissionMode;
  }

  const ts = entry.timestamp;
  if (ts) {
    const iso = isoTs(ts);
    if (iso) {
      if (!acc.firstTimestamp || iso < acc.firstTimestamp) {
        acc.firstTimestamp = iso;
      }
      if (!acc.lastTimestamp || iso > acc.lastTimestamp) {
        acc.lastTimestamp = iso;
      }
    }
  }

  if (typeof entry.teamName === "string") {
    acc.teams.add(entry.teamName);
  }
}

/** `system` entries: today only turn_duration measurements. */
function handleSystemEntry(
  acc: SessionAccumulator,
  entry: Record<string, unknown>
): void {
  if (entry.subtype === "turn_duration" && entry.durationMs) {
    acc.turnDurations.push({
      durationMs: num(entry.durationMs),
      timestamp: isoTs(entry.timestamp),
    });
  }
}

/**
 * CR-3: Apply a user-turn tool_result block — back-link its content to the
 * originating tool_use, capture Read output for later Write diffing (FEA-1899),
 * and record the result timestamp for subagent duration (FEA-1459 Fix 8).
 */
function applyToolResult(
  acc: SessionAccumulator,
  entry: Record<string, unknown>,
  block: Record<string, unknown>
): void {
  const resultContent = Array.isArray(block.content) ? block.content : [];
  const resultTextParts: string[] = [];
  for (const rc of resultContent) {
    const rcBlock = asRecord(rc);
    if (typeof rcBlock.text === "string") {
      resultTextParts.push(rcBlock.text);
    }
  }
  // Also handle string content directly
  if (typeof block.content === "string") {
    resultTextParts.push(block.content);
  }
  const resultText = resultTextParts.join("\n");
  const tuIdx = acc.toolUseIdIndex.get(block.tool_use_id as string);
  if (tuIdx === undefined || !acc.toolUses[tuIdx]) {
    return;
  }
  const tu = acc.toolUses[tuIdx];
  tu.output = truncateText(resultText);
  if (block.is_error) {
    tu.isError = true;
  }
  // FEA-1899 (AC-5): retain raw Read content per path so a later Write of the
  // same file diffs against it. Strip the Read tool's "<n>\t" line-number
  // prefixes back to the underlying file text.
  if (!block.is_error && tu.name === "Read") {
    const readInput = asRecord(tu.input);
    // A Read with offset/limit returns only a slice of the file, so it must not
    // be cached as the full-file baseline for a later Write diff.
    const isPartialRead = readInput.offset != null || readInput.limit != null;
    if (typeof readInput.file_path === "string" && !isPartialRead) {
      acc.readContentByPath.set(
        readInput.file_path,
        resultText
          .split("\n")
          .map((l) => l.replace(READ_LINE_NUMBER_PREFIX_RE, ""))
          .join("\n")
      );
    }
  }
  // FEA-1459 Fix 8: Record the tool_result timestamp for subagent ended_at (real
  // duration = spawn → result).
  const resultTs = isoTs(entry.timestamp);
  if (resultTs) {
    tu.resultTimestamp = resultTs;
  }
}

/**
 * Per-tool-name registry sharing the accumulator: each handler mutates the
 * NormalizedToolUse (and diff aggregates) for one tool. Tools not present here
 * (e.g. Read, Bash) need no extra extraction.
 */
const TOOL_USE_HANDLERS = new Map<
  string,
  (acc: SessionAccumulator, tu: NormalizedToolUse, toolInput: unknown) => void
>([
  // CR-8: Extract skill name from Skill tool.
  [
    "Skill",
    (_acc, tu, toolInput) => {
      const inp = asRecord(toolInput);
      if (typeof inp.skill === "string") {
        tu.skillName = inp.skill;
      }
    },
  ],
  // FEA-2641: Record ScheduleWakeup prompts so their later harness
  // re-injections as `user` entries are excluded from human messages (see
  // isAutomatedPromptInjection).
  [
    "ScheduleWakeup",
    (acc, _tu, toolInput) => {
      const raw = asRecord(toolInput).prompt;
      if (typeof raw === "string") {
        const prompt = raw.trim();
        if (prompt.length > 0) {
          acc.scheduledPrompts.set(
            prompt,
            (acc.scheduledPrompts.get(prompt) ?? 0) + 1
          );
        }
      }
    },
  ],
  // CR-4: Compute diffDelta for Edit tool uses.
  [
    "Edit",
    (acc, tu, toolInput) => {
      const inp = asRecord(toolInput);
      const oldStr = typeof inp.old_string === "string" ? inp.old_string : null;
      const newStr = typeof inp.new_string === "string" ? inp.new_string : null;
      tu.diffDelta = computeLineDelta(oldStr, newStr);
      acc.totalAdded += tu.diffDelta.add;
      acc.totalRemoved += tu.diffDelta.del;
      if (typeof inp.file_path === "string") {
        acc.diffFiles.add(inp.file_path);
      }
    },
  ],
  // CR-4 / FEA-1899 (AC-5): Compute diffDelta for Write tool uses.
  [
    "Write",
    (acc, tu, toolInput) => {
      const inp = asRecord(toolInput);
      const fileContent = typeof inp.content === "string" ? inp.content : "";
      const filePath = typeof inp.file_path === "string" ? inp.file_path : null;
      // FEA-1899 (AC-5): if this path was Read earlier in the session the Write
      // is an overwrite — diff Read-vs-Write so deletions are counted. Without a
      // prior Read it is a fresh file (all added).
      const priorRead =
        filePath == null ? undefined : acc.readContentByPath.get(filePath);
      tu.diffDelta =
        priorRead === undefined
          ? { add: fileContent.split("\n").length, del: 0 }
          : computeLineDelta(priorRead, fileContent);
      acc.totalAdded += tu.diffDelta.add;
      acc.totalRemoved += tu.diffDelta.del;
      if (filePath != null) {
        acc.diffFiles.add(filePath);
        // A Write makes its content the new known state for any later Write of
        // the same path in this session.
        acc.readContentByPath.set(filePath, fileContent);
      }
    },
  ],
]);

/** Per-block context the assistant content-block handlers need. */
type AssistantBlockContext = {
  iso: string | null;
  msgModel: string | null;
  textParts: string[];
};

function ensureSidechainSubagent(
  acc: SessionAccumulator,
  entry: Record<string, unknown>,
  timestamp: string | null
): NormalizedSubagent | null {
  if (entry.isSidechain !== true) {
    return null;
  }
  const idFromUuid = stringValue(entry.uuid);
  const nativeId =
    idFromUuid ?? stringValue(entry.parentUuid) ?? stringValue(entry.sessionId);
  if (!nativeId) {
    return null;
  }
  const id = nativeId;
  const parentId = idFromUuid ? stringValue(entry.parentUuid) : null;
  const existing = acc.subagents.get(id);
  if (existing) {
    if (!existing.parentId) {
      existing.parentId = parentId;
    }
    return existing;
  }
  const subagent: NormalizedSubagent = {
    id,
    parentId,
    name: `Claude subagent ${id.slice(0, 8)}`,
    startedAt: timestamp,
    endedAt: timestamp,
    status: "completed",
    nativeSubagentId: id,
    toolUses: [],
    metadata: {
      parentUuid: stringValue(entry.parentUuid),
    },
  };
  acc.subagents.set(id, subagent);
  return subagent;
}

/**
 * Build a subagent shell for a Claude sidecar `agent-*.jsonl` file. Exported for
 * the desktop shell, whose sidecar-file merge synthesizes one when no in-line
 * sidechain subagent already represents the file.
 */
export function createSidecarSubagent(
  nativeSubagentId: string,
  timestamp: string | null
): NormalizedSubagent {
  return {
    id: nativeSubagentId,
    parentId: null,
    name: `Claude subagent ${nativeSubagentId
      .replace(CLAUDE_SUBAGENT_FILE_PREFIX_RE, "")
      .slice(0, 8)}`,
    startedAt: timestamp,
    endedAt: timestamp,
    status: "completed",
    nativeSubagentId,
    toolUses: [],
  };
}

/**
 * Content-block dispatch for an assistant message: text accumulates, tool_use
 * builds a NormalizedToolUse (via the tool-name registry), thinking emits a
 * redacted message. Block types are disjoint, so the original sequential ifs map
 * 1:1 to this dispatch.
 */
function handleAssistantBlock(
  acc: SessionAccumulator,
  entry: Record<string, unknown>,
  block: Record<string, unknown>,
  ctx: AssistantBlockContext
): void {
  if (block.type === "text" && typeof block.text === "string") {
    ctx.textParts.push(block.text);
    return;
  }
  if (block.type === "tool_use" && typeof block.name === "string") {
    const subagent = ensureSidechainSubagent(acc, entry, ctx.iso);
    const toolName = block.name;
    const toolInput = block.input ?? null;
    const tu: NormalizedToolUse = {
      name: toolName,
      timestamp: ctx.iso || acc.firstTimestamp,
      input: toolInput,
      subagentId: subagent?.id ?? null,
      // The branch the user was on WHEN this tool ran (per-line, not the
      // session's stale start branch) — authoritative for `gh pr create`
      // head-ref attribution.
      gitBranch: typeof entry.gitBranch === "string" ? entry.gitBranch : null,
    };

    TOOL_USE_HANDLERS.get(toolName)?.(acc, tu, toolInput);

    // CR-3: Track tool_use_id for back-linking tool results.
    // FEA-1459 Fix 8: Also store the id on the NormalizedToolUse for stable
    // subagent identity (toolu_*).
    if (typeof block.id === "string") {
      acc.toolUseIdIndex.set(block.id, acc.toolUses.length);
      tu.id = block.id;
    }
    acc.toolUses.push(tu);
    if (subagent) {
      const toolUses = subagent.toolUses;
      if (toolUses) {
        toolUses.push(tu);
      } else {
        subagent.toolUses = [tu];
      }
    }
    return;
  }
  if (block.type === "thinking") {
    acc.thinkingBlockCount++;
    // CR-1: Emit a NormalizedMessage for thinking blocks (text redacted).
    acc.messages.push({
      role: "assistant",
      timestamp: ctx.iso,
      text: null,
      model: ctx.msgModel,
      isThinking: true,
    });
  }
}

/**
 * FEA-2192: not every `user`-role transcript entry is human input. The agent
 * runtime reuses the `user` role for synthetic turns that must NOT be recorded
 * as human steering:
 *   - `isMeta` — injected meta turns such as slash-command expansions;
 *   - `isCompactSummary` — auto-compaction continuation summaries;
 *   - `origin.kind` — runtime-generated notifications, e.g. background-task
 *     completions (`origin.kind === "task-notification"`) — EXCEPT
 *     `origin.kind === "human"`: newer harness versions stamp that on
 *     genuinely-typed prompts, so it marks human input, not a synthetic turn
 *     (FEA-2641; verified by census across real transcripts, where the only
 *     kinds in the wild are absent, "human", and "task-notification").
 * (Tool-result-only turns are detected separately in handleUserEntry.) Genuine
 * human prompts have `isMeta`/`isCompactSummary` unset and `origin` either
 * null or `{kind: "human"}`.
 */
function isSyntheticUserEntry(entry: Record<string, unknown>): boolean {
  if (entry.isMeta === true || entry.isCompactSummary === true) {
    return true;
  }
  const kind = asRecord(entry.origin).kind;
  return typeof kind === "string" && kind.length > 0 && kind !== "human";
}

/**
 * FEA-2641: automated prompt injections are delivered as `user` entries with
 * NO distinguishing entry fields (no `isMeta`, no `origin`; `userType:
 * "external"` like a real prompt), so they are detectable only from the text
 * plus session context:
 *   - ScheduleWakeup re-injections — when a scheduled wake-up fires, the
 *     harness re-injects the recorded prompt verbatim (plain text) or as
 *     expanded slash-command XML. Matched EXACTLY against prompts recorded
 *     from ScheduleWakeup tool_use inputs; the reconstructed typed form is
 *     also tried with the leading slash stripped because older transcripts
 *     record the prompt without it. No fuzzy matching — the `/loop`
 *     autonomous sentinel (`<<autonomous-loop-dynamic>>`) resolves to
 *     different text at fire time and is an accepted miss.
 *   - `<local-command-stdout>` echoes — local command OUTPUT, not input.
 *   - Teammate messages injected by agent-to-agent messaging.
 */
function isAutomatedPromptInjection(
  acc: SessionAccumulator,
  text: string
): boolean {
  const trimmed = text.trim();
  if (
    isLocalCommandStdout(trimmed) ||
    trimmed.startsWith("Another Claude session sent a message:")
  ) {
    return true;
  }
  if (acc.scheduledPrompts.size === 0) {
    return false;
  }
  if (consumeScheduledPrompt(acc, trimmed)) {
    return true;
  }
  const nameMatch = COMMAND_NAME_TAG_RE.exec(text);
  if (!nameMatch) {
    return false;
  }
  const name = nameMatch[1].trim();
  const argsMatch = COMMAND_ARGS_TAG_RE.exec(text);
  const args = argsMatch ? argsMatch[1].trim() : "";
  const typedForm = args ? `${name} ${args}` : name;
  return (
    consumeScheduledPrompt(acc, typedForm) ||
    (typedForm.startsWith("/") &&
      consumeScheduledPrompt(acc, typedForm.slice(1)))
  );
}

/**
 * FEA-2641: match-and-consume one pending scheduled-wakeup firing for `key`.
 * Consuming keeps the exclusion one-to-one with recorded firings, so a later
 * genuine typed prompt that happens to equal an already-fired wake-up prompt
 * still counts as human.
 */
function consumeScheduledPrompt(acc: SessionAccumulator, key: string): boolean {
  const pending = acc.scheduledPrompts.get(key);
  if (!pending) {
    return false;
  }
  if (pending === 1) {
    acc.scheduledPrompts.delete(key);
  } else {
    acc.scheduledPrompts.set(key, pending - 1);
  }
  return true;
}

/**
 * FEA-2641 (PM ruling 2026-07-10): session-terminating commands are not human
 * steering. A typed `/exit` arrives as a plain user entry (expanded command
 * XML, no marker fields), but cleanly ending a session says nothing about a
 * human directing the work — counting it pushed kickoff-plus-/exit overnight
 * sessions over the is_human threshold, painting their entire autonomous event
 * stream Human on the activity heatmap. `/quit` is the CLI alias (a census
 * over local transcripts found only `/exit` in the wild). The typed command is
 * still recorded in slashCommands; only the role:"human" message and its
 * human-turn credit are withheld.
 */
const NON_STEERING_COMMANDS = new Set(["/exit", "/quit"]);

function isNonSteeringCommandEntry(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("<command-name>")) {
    return false;
  }
  const match = COMMAND_NAME_TAG_RE.exec(trimmed);
  return match !== null && NON_STEERING_COMMANDS.has(match[1].trim());
}

/** `user` entries: text + tool_result content blocks, slash commands, errors. */
function handleUserEntry(
  acc: SessionAccumulator,
  entry: Record<string, unknown>
): void {
  // CR-1: Build NormalizedMessage for user messages.
  const userMsg = asRecord(entry.message);
  const userContent = Array.isArray(userMsg.content) ? userMsg.content : [];
  const userTextParts: string[] = [];
  let hasToolResult = false;
  if (typeof userMsg.content === "string") {
    userTextParts.push(userMsg.content);
  }
  for (const raw of userContent) {
    const block = asRecord(raw);
    if (block.type === "text" && typeof block.text === "string") {
      userTextParts.push(block.text);
    }
    // CR-3: Capture tool_result content and back-link to the originating tool_use.
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      hasToolResult = true;
      applyToolResult(acc, entry, block);
    }
  }
  const userTextJoined = userTextParts.join("\n");

  // FEA-2192: only record a human message + count it for genuine human turns.
  // The agent runtime reuses the `user` role for synthetic turns that are not
  // human steering — tool-result-only turns (no human-authored text, detected
  // here) plus meta/compaction/notification turns (see isSyntheticUserEntry)
  // plus automated prompt injections that carry no marker fields at all
  // (FEA-2641; see isAutomatedPromptInjection) plus typed session-terminating
  // commands (see NON_STEERING_COMMANDS). Recording any of these as a
  // role:"human" message over-counts it everywhere downstream that keys on
  // human turns: the session-timeline "Human steering" markers
  // (buildTraceTimelineRows → traceMarkerKind), the is_human session
  // classification (which counts role:"human" turns in session metadata), and the
  // userMessages stat. Tool-result content is still captured via applyToolResult
  // above and the toolUseResult error tracking below, so dropping the synthetic
  // message loses no information.
  const isToolResultOnlyTurn =
    hasToolResult && userTextJoined.trim().length === 0;
  // Checked before isAutomatedPromptInjection so a non-steering command never
  // consumes a pending scheduled-wakeup prompt as a side effect.
  const isNonSteeringCommand = isNonSteeringCommandEntry(userTextJoined);
  if (
    !(
      isToolResultOnlyTurn ||
      isSyntheticUserEntry(entry) ||
      isNonSteeringCommand ||
      isAutomatedPromptInjection(acc, userTextJoined)
    )
  ) {
    acc.userMessageCount++;
    acc.messages.push({
      role: "human",
      timestamp: isoTs(entry.timestamp),
      text: truncateText(userTextJoined) || null,
    });

    // CR-7: Scan user message text for <command-name> XML tags (slash commands).
    appendSlashCommands(acc, userTextJoined, isoTs(entry.timestamp));
  } else if (isNonSteeringCommand) {
    // A typed /exit is still a command the human ran — keep the slash-command
    // record; only the human-turn credit is withheld (see NON_STEERING_COMMANDS).
    appendSlashCommands(acc, userTextJoined, isoTs(entry.timestamp));
  } else if (isLocalCommandStdout(userTextJoined)) {
    // FEA-3112: command OUTPUT echoed under the user role is not human input, but
    // it belongs in the transcript — record it as a role:"system" message instead
    // of dropping it. No human-turn credit (userMessageCount is untouched).
    acc.messages.push({
      role: "system",
      timestamp: isoTs(entry.timestamp),
      text: truncateText(userTextJoined) || null,
    });
  }

  // Existing: toolUseResult error tracking (top-level shorthand).
  const toolUseResult = entry.toolUseResult;
  if (toolUseResult && typeof toolUseResult === "object") {
    const tur = toolUseResult as Record<string, unknown>;
    if (tur.is_error) {
      const content =
        typeof tur.content === "string"
          ? tur.content.slice(0, 500)
          : JSON.stringify(tur.content ?? "").slice(0, 500);
      acc.toolResultErrors.push({
        content,
        timestamp: isoTs(entry.timestamp),
      });
    }
  }
}

/** `assistant` entries: model/usage extras, content blocks, slash commands. */
function handleAssistantEntry(
  acc: SessionAccumulator,
  entry: Record<string, unknown>
): void {
  const iso = isoTs(entry.timestamp);
  const msg = asRecord(entry.message);
  const msgModel = typeof msg.model === "string" ? msg.model : null;
  if (!acc.model && msgModel && msgModel !== "<synthetic>") {
    acc.model = msgModel;
  }
  // FEA-1459: Collect entry for deduped usage extraction (replaces naive
  // per-line accumulation that inflated tokens 2.8-68×).
  if (msgModel && msgModel !== "<synthetic>" && msg.usage) {
    acc.assistantEntries.push({ entry, iso });
  }
  const usage = asRecord(msg.usage);
  if (msg.usage) {
    if (typeof usage.service_tier === "string") {
      acc.serviceTiers.add(usage.service_tier);
    }
    if (typeof usage.speed === "string") {
      acc.speeds.add(usage.speed);
    }
    if (
      typeof usage.inference_geo === "string" &&
      usage.inference_geo !== "not_available"
    ) {
      acc.inferenceGeos.add(usage.inference_geo);
    }
  }
  const content = msg.content;
  // CR-1: Collect text blocks for the assistant NormalizedMessage.
  const assistantTextParts: string[] = [];
  if (Array.isArray(content)) {
    const ctx: AssistantBlockContext = {
      iso,
      msgModel,
      textParts: assistantTextParts,
    };
    for (const raw of content) {
      handleAssistantBlock(acc, entry, asRecord(raw), ctx);
    }
  }
  // CR-1: Build main assistant NormalizedMessage.
  const assistantText = assistantTextParts.join("\n");
  acc.messages.push({
    role: "assistant",
    timestamp: iso,
    text: truncateText(assistantText) || null,
    model: msgModel,
    tokens: msg.usage
      ? {
          input: tokenCount(usage.input_tokens, "input_tokens"),
          output: tokenCount(usage.output_tokens, "output_tokens"),
          cacheRead: tokenCount(
            usage.cache_read_input_tokens,
            "cache_read_input_tokens"
          ),
          cacheWrite: tokenCount(
            usage.cache_creation_input_tokens,
            "cache_creation_input_tokens"
          ),
        }
      : undefined,
  });

  // CR-7: Scan assistant text for <command-name> tags too.
  appendSlashCommands(acc, assistantText, iso);
}

/**
 * Entry-type handler registry. `captureCommonMetadata` runs for every line
 * first; then the line is dispatched here by `entry.type`. Unknown types fall
 * through with only their common metadata captured.
 */
const ENTRY_HANDLERS = new Map<
  string,
  (acc: SessionAccumulator, entry: Record<string, unknown>) => void
>([
  ["user", handleUserEntry],
  ["assistant", handleAssistantEntry],
  ["system", handleSystemEntry],
]);

/**
 * Parse a Claude transcript (an async/sync iterable of JSONL lines) into a
 * `NormalizedSession`. Returns null when the transcript has no usable timestamp
 * (matching the vendor contract). Fail-silent on parse errors (malformed lines
 * are skipped); re-throws `InvalidTokenCountError`.
 *
 * This is the single-transcript core. The desktop shell wraps it to stream a
 * file, then merges sibling subagent files and stamps `fileModifiedAt` — behavior
 * that is DB-import-specific and not part of the cloud renderer's per-file parse.
 */
export async function parseClaudeTranscript(
  lines: AsyncIterable<string> | Iterable<string>,
  options: { sessionId: string }
): Promise<NormalizedSession | null> {
  const { sessionId } = options;

  // FEA-1459: assistantMessageCount and messageTimestamps are derived from the
  // dedup map after the scan, not from per-line counting (one API turn spans
  // many JSONL lines sharing the same message.id + requestId).
  const acc = createAccumulator();

  // FEA-2771/FEA-2905: track malformed-line drops so the session carries a
  // parse-quality signal. A malformed FINAL line is the benign shape of a
  // truncated in-progress transcript; a malformed line anywhere earlier
  // silently drops a turn's messages + token usage (apiErrors stays empty), so
  // it must be surfaced. Counting mirrors the desktop `readJsonlLinesWithQuality`
  // scan (blank lines skipped, non-blank lines counted, malformed lines skipped)
  // so the shared parse-quality contract holds on both surfaces; the desktop
  // shell then folds each subagent sidecar's counts into `parseQuality` (FEA-2905).
  let totalLines = 0;
  let malformedLines = 0;
  let lastLineMalformed = false;

  try {
    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      totalLines++;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        malformedLines++;
        lastLineMalformed = true;
        continue;
      }
      lastLineMalformed = false;

      captureCommonMetadata(acc, entry);
      if (typeof entry.type === "string") {
        ENTRY_HANDLERS.get(entry.type)?.(acc, entry);
      }
    }
  } catch (error) {
    if (error instanceof InvalidTokenCountError) {
      throw error;
    }
    return null;
  }

  if (!acc.firstTimestamp) {
    return null;
  }

  // FEA-1459: Extract deduped token usage from all assistant entries.
  const dedupMap = extractDedupedUsage(acc.assistantEntries);
  const { tokensByModel, tokenSeries } = foldDedupMap(dedupMap);

  // FEA-1459: Derive per-turn messageTimestamps and assistantMessages count
  // from the dedup map (one entry per API turn, not per content block).
  const messageTimestamps: string[] = [];
  for (const entry of dedupMap.values()) {
    if (entry.firstTs) {
      messageTimestamps.push(entry.firstTs);
    }
  }
  const assistantMessageCount = dedupMap.size;

  const projectName = acc.cwd
    ? baseName(acc.cwd)
    : acc.slug || `Session ${sessionId.slice(0, 8)}`;
  const sessionName = acc.slug
    ? `${projectName} (${acc.slug})`
    : `${projectName} - ${sessionId.slice(0, 8)}`;

  // CR-4: Build aggregate diffStats (null when no edits were made).
  const diffStats: NormalizedDiffStats | null =
    acc.diffFiles.size > 0
      ? {
          filesChanged: acc.diffFiles.size,
          linesAdded: acc.totalAdded,
          linesRemoved: acc.totalRemoved,
        }
      : null;

  // CR-13: Collect artifact references from tool uses.
  const artifacts = collectArtifacts(acc.toolUses, acc.cwd);

  return createNormalizedSession({
    sessionId,
    name: sessionName,
    cwd: acc.cwd,
    model: acc.model,
    version: acc.version,
    slug: acc.slug,
    gitBranch: acc.gitBranch,
    startedAt: acc.firstTimestamp,
    endedAt: acc.lastTimestamp,
    teams: [...acc.teams],
    userMessages: acc.userMessageCount,
    assistantMessages: assistantMessageCount,
    tokensByModel,
    messageTimestamps,
    toolUses: acc.toolUses,
    subagents: [...acc.subagents.values()],
    compactions: acc.compactions,
    apiErrors: acc.apiErrors,
    // The desktop shell stamps the source-file mtime; the cloud renderer has no
    // local file, so the core leaves it null.
    fileModifiedAt: null,
    turnDurations: acc.turnDurations,
    entrypoint: acc.entrypoint ?? "claude",
    permissionMode: acc.permissionMode,
    thinkingBlockCount: acc.thinkingBlockCount,
    toolResultErrors: acc.toolResultErrors,
    usageExtras: {
      service_tiers: [...acc.serviceTiers],
      speeds: [...acc.speeds],
      inference_geos: [...acc.inferenceGeos],
    },
    // CR-1: Ordered messages with text content.
    messages: acc.messages,
    // CR-2: Per-turn token time-series (deduped, FEA-1459).
    tokenSeries,
    // CR-4: Aggregate diff stats.
    diffStats,
    // CR-7: Extracted slash commands.
    slashCommands: acc.slashCommands,
    // CR-13: Structured artifact references.
    artifacts,
    // FEA-2771: parse-quality signal (malformed-line drops, truncated final
    // line). The desktop shell folds subagent-sidecar counts into this (FEA-2905).
    parseQuality: {
      totalLines,
      malformedLines,
      truncatedFinalLine: lastLineMalformed,
    },
  });
}
