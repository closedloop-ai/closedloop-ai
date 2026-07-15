/**
 * @file parser-utils.ts
 * @description Shared utilities for the harness parsers (ported from the vendor
 * `scripts/agent-monitor-shared/parser-utils.js`, logic preserved). Kept
 * browser-safe so every parser can normalize timestamps and extract error text
 * identically on desktop and in the cloud renderer.
 */
import type {
  NormalizedArtifacts,
  NormalizedToolUse,
  NormalizedTurnDuration,
} from "./types";

/**
 * Normalize a timestamp to an ISO 8601 string. Handles numeric epoch (seconds or
 * milliseconds), strings, and nulls.
 */
export function toIso(ts: unknown): string | null {
  if (ts == null) {
    return null;
  }
  if (typeof ts === "number") {
    const ms = ts < 1e12 ? ts * 1000 : ts;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof ts === "string") {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? ts : d.toISOString();
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
  /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(?!new\b)(\d+)/g;

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
    if (!(owner && repo && number) || FIXTURE_OWNER_RE.test(owner)) {
      continue;
    }
    const url = `https://github.com/${owner}/${repo}/pull/${number}`;
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    refs.push({ number, repo: `${owner}/${repo}`, url });
  }
  return refs;
}

/** CR-13: Extract PR references from tool calls. */
export function extractPrReferences(
  toolName: string,
  input: unknown,
  output?: unknown
): Array<{ number: string; repo?: string; url?: string }> {
  const refs: Array<{ number: string; repo?: string; url?: string }> = [];
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

  if (toolName === "Bash") {
    const cmd = typeof obj.command === "string" ? obj.command : "";
    const match = cmd.match(/gh\s+pr\s+create/);
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
  toolUses: Array<{ name: string; input?: unknown; output?: unknown }>,
  cwd: string | null | undefined
): NormalizedArtifacts {
  const prs: Array<{ number: string; repo?: string; url?: string }> = [];
  const issues: Array<{ key: string }> = [];
  const seenPr = new Set<string>();
  const seenIssue = new Set<string>();

  for (const tu of toolUses) {
    for (const pr of extractPrReferences(tu.name, tu.input, tu.output)) {
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
 * than re-derived in every parser. Parsers whose timestamp normalization
 * intentionally differs from `toIso` (e.g. the Claude parser's string-passthrough
 * `isoTs`) keep their own bounds tracking — do not route them through here.
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
  if (!Number.isFinite(durationMs) || durationMs < 0) {
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
