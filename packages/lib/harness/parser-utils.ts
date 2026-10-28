/**
 * @file parser-utils.ts
 * @description Shared utilities for the harness parsers (ported from the vendor
 * `scripts/agent-monitor-shared/parser-utils.js`, logic preserved). Kept
 * browser-safe so every parser can normalize timestamps and extract error text
 * identically on desktop and in the cloud renderer.
 */
import { parsePullRequestNumber } from "@repo/api/src/types/session-artifact-link";
import type {
  NormalizedArtifacts,
  NormalizedPrRef,
  NormalizedToolKind,
  NormalizedToolUse,
  NormalizedTurnDuration,
} from "./types";

/**
 * FEA-2642 (TC-038): agent-runtime orchestration/meta tools. Everything else
 * that isn't an `mcp__*` tool is a `builtin` workspace/IO tool. Explicit
 * allow-list (not a heuristic) so a new builtin never silently mis-classifies;
 * adding a harness tool is a deliberate edit here. `Skill` is harness: it is a
 * tool_use block (its `skillName` is the skill signal) and it is orchestration.
 */
export const HARNESS_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Agent",
  "Task",
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "ToolSearch",
  "Monitor",
  "Workflow",
  "SendMessage",
  "Skill",
  "ExitPlanMode",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitWorktree",
  "ScheduleWakeup",
  "CronCreate",
  "CronDelete",
  "CronList",
  "PushNotification",
  "RemoteTrigger",
]);

/**
 * BUILTIN tool names whose input IS a shell command line, across harnesses
 * (Claude `Bash`, Codex `shell` / `exec_command`). The recognizer boundary is
 * {@link isShellCommandToolUse}, which adds structural recognition of
 * shell-through-MCP tools (ISS-8268) — recognizers consult the predicate, not
 * this set, so the ones that treat a tool input as a COMMAND and the ones that
 * must NOT treat it as prose (ISS-5764) cannot drift apart.
 */
export const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Bash",
  "shell",
  "exec_command",
]);

/**
 * FEA-2642 (TC-038): classify a tool_use name as `builtin` | `harness` | `mcp`.
 * MCP tools (`mcp__server__method`) win first; then the harness allow-list;
 * everything else is a builtin workspace/IO tool.
 */
export function classifyToolKind(name: string): NormalizedToolKind {
  if (name.startsWith("mcp__")) {
    return "mcp";
  }
  return HARNESS_TOOL_NAMES.has(name) ? "harness" : "builtin";
}

/**
 * Normalize a timestamp to an ISO 8601 string. Handles numeric epoch (seconds or
 * milliseconds), strings, and nulls.
 */
/** An ISO string carrying its own zone: trailing `Z`, or a `+hh:mm` offset. */
const HAS_EXPLICIT_ZONE = /(Z|[+-]\d{2}:?\d{2})$/;

export function toIso(ts: unknown): string | null {
  if (ts == null) {
    return null;
  }
  if (typeof ts === "number") {
    // A POSITIVE sub-1e12 value is SECONDS. 1e12 ms is 2001-09-09, so any real
    // epoch in milliseconds is above it, and reading a 10-digit value as
    // milliseconds yields 1970 — never the right answer for a transcript.
    //
    // ISS-6738: the positivity test matters. `ts < 1e12` alone is true for
    // every NEGATIVE number, so a pre-1970 millisecond epoch was silently
    // multiplied by 1000 — `-1` ms (1969-12-31T23:59:59.999Z) became `-1000`
    // ms (…59.000Z). Seconds-vs-milliseconds is a magnitude heuristic and only
    // magnitudes above zero carry that signal.
    const ms = ts > 0 && ts < 1e12 ? ts * 1000 : ts;
    const date = new Date(ms);
    // Tests the CONSTRUCTED date, not `Number.isFinite`: `Date` tops out at
    // ±8.64e15, and a larger-but-finite epoch round-trips out of SQLite intact
    // while still being unrepresentable (ISS-6417).
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof ts === "string") {
    // ISS-6738: a value that cannot be read as a datetime is NULL, never echoed
    // back. Both normalizers used to return unparseable text verbatim, so
    // `"not-a-date"` reached `startedAt`/`endedAt` and then sorted lexically
    // against real ISO stamps. `null` is the one answer for "no timestamp".
    //
    // A zone-less string is read as UTC, explicitly. `new Date("July 9, 2026")`
    // is LOCAL midnight, which made parser output depend on the machine that
    // ran it — the same transcript yielding different timestamps in different
    // timezones. Naming the zone keeps the value AND makes it deterministic.
    const zoned = HAS_EXPLICIT_ZONE.test(ts) ? ts : `${ts}Z`;
    const date = new Date(zoned);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
    // A bare date or an unusual-but-real format may not survive the appended
    // `Z`; retry as written before giving up, so only genuinely unreadable text
    // becomes null.
    //
    // NOTE the retry is TIMEZONE-DEPENDENT, unlike the branch above it: it hands
    // interpretation back to the engine, so a format V8 cannot read with a
    // trailing `Z` is resolved in the machine's local zone. `"July 9, 2026
    // 12:00 PM"` becomes 17:00Z on a Chicago box and 03:00Z on a Tokyo one. The
    // UTC guarantee the docstring above makes therefore covers the primary
    // branch, not this fallback. Narrow in practice — transcript stamps are ISO
    // or epochs, both of which take the branch above — but a reader must not
    // assume the whole string path is zone-stable.
    const asWritten = new Date(ts);
    return Number.isNaN(asWritten.getTime()) ? null : asWritten.toISOString();
  }
  return null;
}

/** Parse a value as JSON if it's a string, return objects as-is. */
export function safeJson(v: unknown): unknown {
  if (v == null) {
    return null;
  }
  if (typeof v === "object") {
    return v;
  }
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

/** Return a non-empty string value, or null for all other inputs. */
export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Best-effort extraction of a human-readable error message from a nested value. */
export function extractErrorMessage(value: unknown, depth = 0): string | null {
  if (value == null || depth > 4) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const message = extractErrorMessage(entry, depth + 1);
      if (message) {
        return message;
      }
    }
    return null;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["message", "error", "details", "text", "content"]) {
      const message = extractErrorMessage(obj[key], depth + 1);
      if (message) {
        return message;
      }
    }
  }
  return null;
}

// Byte-accurate truncation shared across desktop (Node) and the browser: a
// module-level encoder/decoder pair replaces the desktop-only `Buffer`. Each
// `decode()` call is stateless (no `stream: true`), and the WHATWG UTF-8 decoder
// replaces a multi-byte sequence split at the byte cut with U+FFFD — matching the
// prior `Buffer.from(...).subarray(0, maxBytes).toString("utf8")` behavior.
// `ignoreBOM: true` keeps a leading U+FEFF instead of stripping it, so the
// truncation path stays consistent with the untruncated `return text` branch and
// with `Buffer.toString("utf8")` (which never strips a BOM).
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { ignoreBOM: true });

/** CR-1/CR-3: Cap content-bearing text to a byte limit (default 4096). */
export function truncateText(
  text: string | null | undefined,
  maxBytes = 4096
): string | null {
  if (text == null || text.length === 0) {
    return null;
  }
  const bytes = TEXT_ENCODER.encode(text);
  if (bytes.length <= maxBytes) {
    return text;
  }
  return TEXT_DECODER.decode(bytes.subarray(0, maxBytes));
}

/**
 * CR-4 / FEA-1899 (AC-5): Compute lines added/removed between two text blobs.
 *
 * Uses a multiset (per-line occurrence count) rather than a Set so duplicate
 * identical lines are no longer collapsed: adding N copies of the same line
 * counts as N additions, not 1. add = sum of per-line surplus on the new side,
 * del = sum of per-line surplus on the old side. Pure content change of one
 * line reads as add=1, del=1.
 */
export function computeLineDelta(
  oldText: string | null | undefined,
  newText: string | null | undefined
): { add: number; del: number } {
  const oldLines = oldText ? oldText.split("\n") : [];
  const newLines = newText ? newText.split("\n") : [];
  const counts = new Map<string, number>();
  for (const line of oldLines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  for (const line of newLines) {
    counts.set(line, (counts.get(line) ?? 0) - 1);
  }
  let add = 0;
  let del = 0;
  for (const surplus of counts.values()) {
    if (surplus > 0) {
      del += surplus;
    } else if (surplus < 0) {
      add += -surplus;
    }
  }
  return { add, del };
}

/** CR-4: Parse a unified diff for lines added/removed (Codex apply_patch). */
export function computeUnifiedDiffDelta(patch: string): {
  add: number;
  del: number;
} {
  let add = 0;
  let del = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      add++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      del++;
    }
  }
  return { add, del };
}

/** CR-4: Count file headers in a unified or Codex-style diff. */
export function countDiffFiles(patch: string): number {
  let count = 0;
  for (const line of patch.split("\n")) {
    if (
      line.startsWith("--- ") ||
      line.startsWith("*** Add File:") ||
      line.startsWith("*** Update File:") ||
      line.startsWith("*** Delete File:")
    ) {
      count++;
    }
  }
  return count;
}

/**
 * FEA-3668: whether a `cwd` value carries real repository/workspace meaning and
 * may be recorded as a session's working directory. The dominant reject is the
 * filesystem root `/`: automated harness launches whose process cwd is `/`
 * (spawned from a launchd/daemon/detached context that never chdir'd) record `/`
 * on the first turn before the agent cd's into the real worktree. Recording that
 * transient `/` as the session cwd mis-derives the repository — git resolves
 * nothing at `/`, so it falls back to the bogus repo "/". Parsers skip
 * non-meaningful values so the first MEANINGFUL cwd wins; when none exists, cwd
 * stays null (→ repo "Unknown", the correct grouping).
 */
export function isMeaningfulCwd(cwd: string | null | undefined): boolean {
  if (!cwd) {
    return false;
  }
  const trimmed = cwd.trim();
  if (trimmed.length === 0) {
    return false;
  }
  // POSIX root ("/", "//", …) or a bare Windows drive root ("C:", "C:\", "C:/").
  if (/^\/+$/.test(trimmed) || /^[A-Za-z]:[\\/]*$/.test(trimmed)) {
    return false;
  }
  return true;
}

/** CR-13: Extract repo name from cwd path (last path component). */
export function extractRepoFromCwd(
  cwd: string | null | undefined
): string | null {
  if (!cwd) {
    return null;
  }
  const parts = cwd.replace(/\/+$/, "").split("/");
  const last = parts.at(-1);
  return last && last.length > 0 ? last : null;
}

/**
 * Browser-safe `path.basename` for the parsers' project-name derivation. Returns
 * the last path segment, trimming trailing separators and accepting both POSIX
 * (`/`) and Windows (`\`) separators so a cwd captured on either desktop OS
 * yields the same display name whether the transcript is parsed on the desktop
 * (Node) or in the cloud renderer (browser). Callers only pass a non-empty cwd.
 */
export function baseName(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  const lastSep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return lastSep === -1 ? trimmed : trimmed.slice(lastSep + 1);
}

export const PR_TOOL_PATTERNS = new Set([
  "create_pull_request",
  "github.create_pr",
  "github__create_pull_request",
  "mcp__github__create_pull_request",
]);

export const GITHUB_PR_URL_RE =
  /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(?!new\b)(\d+)(?=$|[/?#\s)\]}"'<>]|[.,;:!?](?:\s|$)|\.(?:diff|patch)(?=$|[?#\s)\]}"'<>]))/g;

export const FIXTURE_OWNER_RE =
  /^(?:owner|acme|org|example|test-org|sample|fixtures?|placeholder|repo)$/i;

export function flattenTextValues(value: unknown, depth = 0): string[] {
  if (value == null || depth > 4) {
    return [];
  }
  if (typeof value === "string") {
    return value.length > 0 ? [value] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => flattenTextValues(entry, depth + 1));
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((entry) =>
      flattenTextValues(entry, depth + 1)
    );
  }
  return [];
}

function extractPrUrlsFromText(
  text: string
): Array<{ number: string; repo: string; url: string }> {
  const refs: Array<{ number: string; repo: string; url: string }> = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(GITHUB_PR_URL_RE)) {
    const owner = match[1];
    const repo = match[2];
    const number = match[3];
    const prNumber = number ? parsePullRequestNumber(number) : null;
    if (!(owner && repo && prNumber) || FIXTURE_OWNER_RE.test(owner)) {
      continue;
    }
    const canonicalNumber = String(prNumber);
    const url = `https://github.com/${owner}/${repo}/pull/${canonicalNumber}`;
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    refs.push({ number: canonicalNumber, repo: `${owner}/${repo}`, url });
  }
  return refs;
}

/**
 * CR-13: Extract PR references from tool calls. `mcp` carries the Codex MCP
 * metadata (PR #6160 review): without it a Codex-form MCP shell — no `mcp__`
 * name prefix, `mcpServer`/`mcpMethod` fields instead — cannot be recognized
 * by the shell predicate below.
 */
export function extractPrReferences(
  toolName: string,
  input: unknown,
  output?: unknown,
  mcp?: Pick<NormalizedToolUse, "mcpServer" | "mcpMethod">
): NormalizedPrRef[] {
  const refs: NormalizedPrRef[] = [];
  const seen = new Set<string>();

  for (const text of [
    ...flattenTextValues(input),
    ...flattenTextValues(output),
  ]) {
    for (const ref of extractPrUrlsFromText(text)) {
      if (seen.has(ref.url)) {
        continue;
      }
      seen.add(ref.url);
      refs.push(ref);
    }
  }

  if (!input || typeof input !== "object") {
    return refs;
  }
  const obj = input as Record<string, unknown>;

  if (PR_TOOL_PATTERNS.has(toolName)) {
    if (refs.length > 0) {
      return refs;
    }
    const repo = typeof obj.repo === "string" ? obj.repo : undefined;
    const key = `${repo ?? ""}:pending`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({ number: "pending", repo });
    }
    return refs;
  }

  // ISS-8268: gate on the shared shell predicate, not the literal "Bash", so
  // a shell-through-MCP or argv-shaped `gh pr create` mints the same pending
  // hint.
  const toolUse: NormalizedToolUse = {
    name: toolName,
    timestamp: null,
    input,
    mcpServer: mcp?.mcpServer,
    mcpMethod: mcp?.mcpMethod,
  };
  if (isShellCommandToolUse(toolUse)) {
    const cmd = shellCommand(toolUse);
    const match = cmd.match(GH_PR_CREATE_HINT_RE);
    if (match && refs.length === 0) {
      const key = ":pending";
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ number: "pending" });
      }
    }
  }
  return refs;
}

const ISSUE_KEY_RE = /\b([A-Z]+-\d+)\b/g;
const ISSUE_HASH_RE = /#(\d+)\b/g;
const ISSUE_TOOL_PATTERNS = new Set([
  "linear.get_issue",
  "github.get_issue",
  "mcp__linear-server__get_issue",
  "mcp__github__get_issue",
]);

/** CR-13: Extract issue references from tool calls and input text. */
export function extractIssueReferences(
  toolName: string,
  input: unknown
): Array<{ key: string }> {
  const refs: Array<{ key: string }> = [];
  const seen = new Set<string>();
  if (!input || typeof input !== "object") {
    return refs;
  }
  const obj = input as Record<string, unknown>;

  if (ISSUE_TOOL_PATTERNS.has(toolName)) {
    const key =
      typeof obj.issue_id === "string"
        ? obj.issue_id
        : typeof obj.issueId === "string"
          ? obj.issueId
          : null;
    if (key && !seen.has(key)) {
      seen.add(key);
      refs.push({ key });
    }
  }

  const textFields = [
    obj.command,
    obj.query,
    obj.body,
    obj.prompt,
    obj.description,
  ];
  for (const field of textFields) {
    if (typeof field !== "string") {
      continue;
    }
    for (const m of field.matchAll(ISSUE_KEY_RE)) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        refs.push({ key: m[1] });
      }
    }
    for (const m of field.matchAll(ISSUE_HASH_RE)) {
      const k = `#${m[1]}`;
      if (!seen.has(k)) {
        seen.add(k);
        refs.push({ key: k });
      }
    }
  }
  return refs;
}

/**
 * CR-5: Returns true for synthetic/fallback model IDs.
 *
 * FEA-2085: the Codex `"gpt-codex"` placeholder is no longer emitted — its
 * fallback now uses the real, priceable `gpt-5-codex` and carries the
 * "guessed attribution" signal via the `inferred` flag on token rows instead
 * of an unpriceable marker string. Only the `*-default` convention remains.
 */
export function isSyntheticModelKey(model: string): boolean {
  return model.endsWith("-default");
}

/** CR-13: Accumulate artifact references from tool uses into an artifacts object. */
export function collectArtifacts(
  toolUses: Pick<
    NormalizedToolUse,
    "name" | "input" | "output" | "mcpServer" | "mcpMethod"
  >[],
  cwd: string | null | undefined
): NormalizedArtifacts {
  const prs: NormalizedPrRef[] = [];
  const issues: Array<{ key: string }> = [];
  const seenPr = new Set<string>();
  const seenIssue = new Set<string>();

  for (const tu of toolUses) {
    for (const pr of extractPrReferences(tu.name, tu.input, tu.output, tu)) {
      const k = pr.url ?? `${pr.repo ?? ""}:${pr.number}`;
      if (!seenPr.has(k)) {
        seenPr.add(k);
        prs.push(pr);
      }
    }
    for (const issue of extractIssueReferences(tu.name, tu.input)) {
      if (!seenIssue.has(issue.key)) {
        seenIssue.add(issue.key);
        issues.push(issue);
      }
    }
  }

  return { prs, issues, repo: extractRepoFromCwd(cwd) };
}

/**
 * The mutable first/last ISO-timestamp window every harness parser threads
 * through its scan to derive the session's `startedAt`/`endedAt`. Any object
 * with these two fields (e.g. a parser's accumulator) satisfies it structurally.
 */
type TimestampBounds = {
  firstTimestamp: string | null;
  lastTimestamp: string | null;
};

/**
 * Fold one raw timestamp into a parser's first/last window: normalize via
 * `toIso`, then advance `firstTimestamp` toward the minimum and `lastTimestamp`
 * toward the maximum, and return the normalized ISO string (or null when `raw`
 * is unparseable, leaving the window untouched).
 *
 * The min/max are plain string comparisons because ISO 8601 timestamps order
 * lexically; centralizing them here keeps that invariant in one place rather
 * than re-derived in every parser. ISS-6738 left exactly one `toIso`, so the
 * old carve-out for the Claude parser's separate string-passthrough normalizer
 * is gone; a parser that still keeps its own bounds tracking does so for its own
 * reasons — do not route it through here without checking why.
 */
export function noteTimestamp(
  bounds: TimestampBounds,
  raw: unknown
): string | null {
  const iso = toIso(raw);
  if (!iso) {
    return null;
  }
  if (!bounds.firstTimestamp || iso < bounds.firstTimestamp) {
    bounds.firstTimestamp = iso;
  }
  if (!bounds.lastTimestamp || iso > bounds.lastTimestamp) {
    bounds.lastTimestamp = iso;
  }
  return iso;
}

/** Push a turn-duration entry when both timestamps are valid and duration ≥ 0. */
export function pushTurnDuration(
  turnDurations: NormalizedTurnDuration[],
  startedAtIso: string | null,
  endedAtIso: string | null
): void {
  if (!(startedAtIso && endedAtIso)) {
    return;
  }
  const durationMs =
    new Date(endedAtIso).getTime() - new Date(startedAtIso).getTime();
  if (!isValidTurnDurationMs(durationMs)) {
    return;
  }
  turnDurations.push({ durationMs, timestamp: endedAtIso });
}

/**
 * Normalize a shell-family tool use's input into its command string. Handles the
 * shapes the harnesses use: a bare string, an argv array (Codex normalizes shell
 * calls as `["git", "push", …]`), or a `{ command }` / `{ cmd }` object whose
 * value is itself a string or argv array. Returns `""` when no command is
 * present. Shared by the artifact-ref extractor and the FEA-2268 evidence model
 * so command-text inspection has one implementation.
 */
export function shellCommand(tool: NormalizedToolUse): string {
  const input = tool.input as Record<string, unknown> | string | undefined;
  if (!input) {
    return "";
  }
  if (typeof input === "string") {
    return input;
  }
  if (Array.isArray(input)) {
    return input.join(" ");
  }
  if (typeof input.command === "string") {
    return input.command;
  }
  if (Array.isArray(input.command)) {
    return input.command.join(" ");
  }
  if (typeof input.cmd === "string") {
    return input.cmd;
  }
  if (Array.isArray(input.cmd)) {
    return input.cmd.join(" ");
  }
  return "";
}

/**
 * The argv array that {@link shellCommand} would flatten with `join(" ")`, or
 * `null` when the tool's command is not argv-shaped (a bare/`command`/`cmd`
 * string, or no command). Callers that must respect the argument boundaries the
 * join erases — the phantom-branch defense treats each spaced non-first argv
 * element as a quoted argument (FEA-2791) — use this instead of re-deriving the
 * shape, so there is one source of truth for which harness inputs are argv.
 */
// Renders one argv element exactly as `Array.prototype.join(" ")` (used by
// shellCommand) would: null/undefined become "", everything else String()-coerces.
// Matching join precisely keeps shellQuotedSpans' offset math aligned with the
// joined command string even when a harness passes a null/undefined argv element.
function coerceArgvElement(element: unknown): string {
  return element === null || element === undefined ? "" : String(element);
}

export function shellCommandArgv(
  tool: NormalizedToolUse
): readonly string[] | null {
  const input = tool.input as Record<string, unknown> | string | undefined;
  if (!input || typeof input === "string") {
    return null;
  }
  if (Array.isArray(input)) {
    return input.map((element) => coerceArgvElement(element));
  }
  if (typeof input.command === "string") {
    return null;
  }
  if (Array.isArray(input.command)) {
    return input.command.map((element) => coerceArgvElement(element));
  }
  if (typeof input.cmd === "string") {
    return null;
  }
  if (Array.isArray(input.cmd)) {
    return input.cmd.map((element) => coerceArgvElement(element));
  }
  return null;
}

/**
 * The visible text of a `tool_result` block, whose `content` is either a plain
 * string or an array of `{type,text}` parts. Extracted from `parse-claude.ts`
 * (ISS-4592) so that file shrinks rather than grows.
 */
export function toolResultText(
  block: Record<string, unknown>,
  maxChars = Number.POSITIVE_INFINITY
): string {
  if (typeof block.content === "string") {
    return block.content.slice(0, maxChars);
  }
  let text = "";
  let remaining = Math.max(0, maxChars);
  for (const entry of Array.isArray(block.content) ? block.content : []) {
    if (remaining === 0) {
      break;
    }
    const part = entry as Record<string, unknown> | null;
    if (part && typeof part.text === "string") {
      if (text.length > 0) {
        text += "\n";
        remaining -= 1;
      }
      if (remaining > 0) {
        const kept = part.text.slice(0, remaining);
        text += kept;
        remaining -= kept.length;
      }
    }
  }
  return text;
}

/**
 * The Claude parser's tolerant record coercion: non-objects become `{}` (never
 * null), so downstream field reads no-op instead of throwing. Deliberately
 * different from the shared `asRecord` in `./type-guards.js`, which returns
 * null.
 *
 * Defined in this leaf module rather than in `claude/parse-claude.ts` (where it
 * used to live) so that `claude/diff-stats-tool-handlers.ts` can reach it
 * without importing the parser. That import closed a cycle (`parse-claude` spreads
 * `DIFF_STATS_TOOL_HANDLERS` into its tool-handler map while the handlers module
 * imported `asRecord` back from `parse-claude`), which left the handlers module
 * — and anything importing it first, such as the desktop sidecar lane — throwing
 * a TDZ `ReferenceError` unless some earlier import happened to evaluate
 * `parse-claude` first.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * An epoch-MILLISECONDS value as ISO, or null when no `Date` can represent it.
 *
 * Distinct from {@link toIso}, which reads a bare number below 1e12 as SECONDS — a lenient
 * reading that suits vendor transcript records, where a seconds stamp is a real shape. A caller
 * that ALREADY KNOWS its value is milliseconds must not go through that heuristic: every stamp
 * before 2001-09-09 is under 1e12 (negatives included), so it would be multiplied by 1000 and
 * land ~31,000 years out, losing the lexical ordering callers rely on (whitlockk, ISS-6738 review).
 *
 * Guards on the CONSTRUCTED `Date` rather than `Number.isFinite`, because an epoch past ±8.64e15
 * passes a finite check and still makes `toISOString` throw — the ISS-6417 case.
 */
export function msToIso(ms: number): string | null {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// ISS-8268 (cr-27784): the `gh pr create` pending-PR hint in
// extractPrReferences, hoisted per useTopLevelRegex. Deliberately loose — it
// mints only a `pending` marker that a real PR URL in the output supersedes.
const GH_PR_CREATE_HINT_RE = /gh\s+pr\s+create/;

/**
 * ISS-8268: does this tool use's input carry a shell COMMAND LINE? True for
 * the builtin shell-tool set ({@link SHELL_TOOL_NAMES}) and, structurally, for
 * an MCP tool — the `mcp__` name prefix, or Codex's separate `mcpServer` /
 * `mcpMethod` fields (either may be absent; same both-fields rule as
 * `isMcpSynthesizedTool`) — whose input object carries an explicit
 * `command`/`cmd` string-or-argv field, read through {@link shellCommand} so
 * exactly one place knows that shape. Shell-through-MCP servers are recognized
 * by shape, never by server or method name (collector-generality doctrine: no
 * org literals, no name vocabulary to drift). Bare-string and bare-argv MCP
 * inputs deliberately do NOT qualify: an MCP search tool's raw string input is
 * not a command line. This predicate is the single recognizer boundary shared
 * by command extraction and ISS-5764 prose suppression, so a tool input is
 * scanned as a command or as prose, never both. Scope: it governs the
 * artifact-ref lane (and the normalized-artifacts PR hint above); the
 * structural-evidence taxonomy (the desktop evidence adapters'
 * RunCommand categorization) deliberately stays name-keyed — a different axis.
 */
export function isShellCommandToolUse(tu: NormalizedToolUse): boolean {
  if (SHELL_TOOL_NAMES.has(tu.name)) {
    return true;
  }
  if (
    classifyToolKind(tu.name) !== "mcp" &&
    tu.mcpServer == null &&
    tu.mcpMethod == null
  ) {
    return false;
  }
  // Bare-string and bare-argv inputs never qualify for MCP tools (see
  // docstring) — shellCommand() would read either one AS the command line.
  if (typeof tu.input === "string" || Array.isArray(tu.input)) {
    return false;
  }
  return shellCommand(tu) !== "";
}

/**
 * A count the harness reported, or `null` when the value cannot be one.
 *
 * Rejects the WHOLE impossible set for a count, not the two that get
 * remembered. Negative and non-finite are the ones everyone guards; what
 * actually reaches a column is the rest — a fractional count (`1.5` tokens), a
 * magnitude past `Number.MAX_SAFE_INTEGER`, a blank string that `Number("")`
 * turns into a measured `0`, and a boolean that `+value` turns into `1`. Each of
 * those renders as a confident real measurement, which is strictly worse than an
 * absent one, so callers omit the field on `null` rather than storing a number
 * that cannot be true.
 *
 * Deliberately does NOT parse strings. Its callers read numeric JSON fields the
 * harness emits as numbers; accepting `"12"` here would also accept `""` and
 * `" "` through any lenient coercion, which is the failure mode above.
 */
/**
 * The widest short string a harness value may carry into a normalized session.
 *
 * ISS-7258 (PR #6418 review, davetho). The worker boundary is `.strict()` and
 * caps these strings, and a `.strict()` schema rejects the WHOLE response when
 * one string is over its cap — so an over-long value does not cost a field, it
 * costs the entire source, and costs it again on every retry. Admitting a value
 * here that the boundary will refuse is therefore the worst of the two
 * arrangements available. Bounding at the source instead is the same call
 * `collectSessionAttributes` already makes for `attributionSkill`.
 *
 * MUST stay <= `HistoricalParseWorkerLimits.maxShortTextLength`. Nothing in this
 * package can import that constant (it lives in `apps/desktop`, which depends on
 * this one, not the reverse), so the relationship is asserted from the desktop
 * side by `historical-parse-worker-short-text-parity.test.ts` — raise this above
 * the boundary cap and that test fails rather than production.
 */
export const MAX_HARNESS_SHORT_TEXT_CHARS = 8192;

/**
 * `stringValue`, but OMITTING a value too long to cross the worker boundary.
 *
 * Returns null for an over-cap string so the caller's existing absent-value path
 * runs, rather than admitting a value that would later reject its whole source.
 */
export function boundedStringValue(value: unknown): string | null {
  const text = stringValue(value);
  if (text === null || text.length > MAX_HARNESS_SHORT_TEXT_CHARS) {
    return null;
  }
  return text;
}

export function countValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * The admission rule for a turn duration, shared by `pushTurnDuration` (a
 * timestamp-pair derivation) and the Claude parser (a stated number read off
 * the transcript). Finite and non-negative; a fractional millisecond is legal,
 * so this deliberately stops short of `Number.isSafeInteger` (ISS-8886). The
 * OpenCode stated-duration path still reads through an unguarded `z.number()`
 * and is the named sibling, not a caller.
 */
export function isValidTurnDurationMs(durationMs: number): boolean {
  return Number.isFinite(durationMs) && durationMs >= 0;
}
