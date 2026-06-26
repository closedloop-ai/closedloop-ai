/**
 * @file types.ts
 * @description The collection-layer contract (FEA-1503). Every harness parser
 * (Claude, Codex, Cursor, Copilot, OpenCode) emits this single `NormalizedSession`
 * shape, and the first-party `importSession` write-sink consumes it. Ported from
 * the vendor agent-monitor's normalized session shape so the unchanged dashboard
 * renders all harnesses identically.
 */

/** The five agent CLIs we collect from. */
export const Harness = {
  Claude: "claude",
  Codex: "codex",
  Cursor: "cursor",
  Copilot: "copilot",
  OpenCode: "opencode",
} as const;

export type Harness = (typeof Harness)[keyof typeof Harness];

/** Canonical runtime list for schemas that validate harness values. */
export const HarnessValues = [
  Harness.Claude,
  Harness.Codex,
  Harness.Cursor,
  Harness.Copilot,
  Harness.OpenCode,
] as const satisfies readonly Harness[];

/**
 * Cumulative per-model token counts (output already folds in reasoning tokens).
 *
 * CANONICAL TOKEN-COUNT SHAPE (mandatory for EVERY parser):
 * - `input` is the FRESH / UNCACHED prompt token count.
 * - `cacheRead` and `cacheWrite` are SEPARATE, ADDITIVE components — NOT a
 *   subset of `input`.
 * - The grand total prompt size is therefore `input + cacheRead + cacheWrite`.
 *
 * Every harness parser MUST emit this "fresh" shape regardless of how its source
 * reports usage. Anthropic/Claude report fresh natively; sources that report an
 * inclusive total (Codex/OpenAI, and any future OpenAI-compatible harness) MUST
 * subtract cached at parse time (see `codex-parser.ts` `nonCachedInput`).
 *
 * Two subsystems depend on this invariant and would silently misreport if a
 * parser deviated:
 * 1. Cost — the shared genai-prices engine ALWAYS sums these to reconstruct the
 *    library's grand-total `input_tokens` (`packages/loops-api/src/genai-cost.ts`,
 *    `buildUsage`). A non-fresh `input` makes the library throw on negative
 *    uncached → the FEA-2082 `compute_error` pricing miss.
 * 2. Dashboards/analytics treat `input` as cache-exclusive and compute totals as
 *    `input + cacheRead + cacheWrite` and cache-rate as `cache / (total + cache)`.
 *    An inclusive `input` would double-count cached tokens.
 *
 * The `genai-cost.test.ts` / `token-cost.test.ts` cost tests and the
 * `collectors-parsers.test.ts` per-parser fresh-shape invariant tests enforce
 * this contract.
 */
export type NormalizedTokenCounts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /**
   * FEA-2085: True when the model id keying this attribution was a fallback
   * placeholder (e.g. Codex's CODEX_FALLBACK_MODEL) rather than a model id
   * extracted from the transcript. Decouples the "guessed attribution" signal
   * from the (now priceable) model string.
   */
  inferred?: boolean;
};

/** A tool invocation parsed from a transcript → becomes a PostToolUse event. */
export type NormalizedToolUse = {
  name: string;
  timestamp: string | null;
  input?: unknown;
  /** CR-3: Tool result content (size-capped). */
  output?: unknown;
  /** CR-3: Whether the tool result was an error. */
  isError?: boolean;
  /** CR-6: MCP server name (Codex preserves from mcp_tool_call_begin). */
  mcpServer?: string;
  /** CR-6: MCP method name. */
  mcpMethod?: string;
  /** CR-8: Skill name extracted from Skill tool input.skill (Claude). */
  skillName?: string;
  /** CR-4: Per-edit line delta. */
  diffDelta?: { add: number; del: number };
  /** FEA-1459 Fix 8: API-level tool_use id (toolu_*) for stable subagent identity. */
  id?: string;
  /** FEA-1459 Fix 8: Timestamp of the tool_result referencing this tool_use. */
  resultTimestamp?: string | null;
  /**
   * The working git branch recorded on this tool's transcript line — i.e. the
   * branch the user was actually on WHEN this tool ran, not the session's stale
   * start branch (`NormalizedSession.gitBranch`). Authoritative for `gh pr create`
   * head-ref attribution. Undefined when the harness doesn't record per-line
   * branch (only Claude does today).
   */
  gitBranch?: string | null;
};

/** An API-level error parsed from a transcript → becomes an APIError event. */
export type NormalizedApiError = {
  type?: string | null;
  message?: string | null;
  timestamp: string | null;
};

/** A tool-result error parsed from a transcript → becomes a ToolError event. */
export type NormalizedToolResultError = {
  content?: string | null;
  timestamp: string | null;
};

/** A measured turn duration → becomes a TurnDuration event. */
export type NormalizedTurnDuration = {
  durationMs: number;
  timestamp: string | null;
};

/** CR-1: An ordered message from a session transcript. */
export type NormalizedMessage = {
  role: "human" | "assistant" | "system";
  timestamp: string | null;
  text: string | null;
  model?: string | null;
  tokens?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  isThinking?: boolean;
  /** CR-5: True when the model key is a synthetic fallback (e.g. *-default). */
  isSynthetic?: boolean;
};

/**
 * CR-2: A per-turn token record for time-series reconstruction.
 *
 * Uses the canonical fresh shape documented on `NormalizedTokenCounts`: `input`
 * is uncached; `cacheRead`/`cacheWrite` are separate additive components.
 */
export type NormalizedTokenRecord = {
  timestamp: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** FEA-2085: True when `model` is a fallback placeholder, not an extracted id. */
  inferred?: boolean;
};

/** CR-4: Aggregate diff stats for the session. */
export type NormalizedDiffStats = {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
};

/** CR-13: Structured artifact references extracted from tool calls. */
export type NormalizedArtifacts = {
  prs: Array<{ number: string; repo?: string; url?: string }>;
  issues: Array<{ key: string }>;
  repo: string | null;
};

/** A plan block (Codex only today). Stored on the session metadata. */
export type NormalizedPlan = {
  source?: string | null;
  content?: string | null;
  timestamp: string | null;
};

/**
 * The normalized session every parser produces. `startedAt` falsy ⇒ the parser
 * returns null (caller skips). All array fields default to `[]`, all token maps
 * to `{}`.
 */
export type NormalizedSession = {
  sessionId: string;
  name: string;
  cwd: string | null;
  model: string | null;
  version: string | null;
  slug: string | null;
  gitBranch: string | null;
  startedAt: string | null;
  endedAt: string | null;
  teams: unknown[];
  userMessages: number;
  assistantMessages: number;
  tokensByModel: Record<string, NormalizedTokenCounts>;
  messageTimestamps: string[];
  toolUses: NormalizedToolUse[];
  plans?: NormalizedPlan[];
  compactions: unknown[];
  apiErrors: NormalizedApiError[];
  /** mtimeMs of the source file; drives the "recently active (<10min)" decision. */
  fileModifiedAt: number | null;
  turnDurations: NormalizedTurnDuration[];
  entrypoint: string;
  permissionMode: string | null;
  thinkingBlockCount: number;
  toolResultErrors: NormalizedToolResultError[];
  usageExtras: {
    service_tiers: unknown[];
    speeds: unknown[];
    inference_geos: unknown[];
  };
  /** CR-1: Ordered per-message list with text content. */
  messages: NormalizedMessage[];
  /** CR-2: Per-turn token records for time-series reconstruction. */
  tokenSeries: NormalizedTokenRecord[];
  /** CR-4: Aggregate diff stats (files changed, lines +/-). Null when absent. */
  diffStats: NormalizedDiffStats | null;
  /** CR-7: Claude slash commands extracted from transcripts. */
  slashCommands: Array<{ name: string; timestamp: string }>;
  /** CR-13: Structured artifact references (PRs, issues, repo). */
  artifacts: NormalizedArtifacts;
};

/** Optional source snapshot captured immediately before parsing a source. */
export type SourceImportSnapshot = {
  fingerprint: string | null;
};

/** Empty `usageExtras` literal — parsers spread/override as needed. */
export function emptyUsageExtras(): NormalizedSession["usageExtras"] {
  return { service_tiers: [], speeds: [], inference_geos: [] };
}

/** Empty `artifacts` literal — parsers fill as they extract references. */
export function emptyArtifacts(): NormalizedArtifacts {
  return { prs: [], issues: [], repo: null };
}

/**
 * A per-harness collector descriptor (FEA-1503). The generic boot importer and
 * the generic watcher (`watcher.ts`, `collector-manager.ts`) drive every harness
 * through this uniform shape, so the only per-harness code is `home` (path/env
 * resolution) + `parser` (format → NormalizedSession) + a small descriptor.
 *
 *  - File harnesses (Claude/Codex/Cursor/Copilot): `listSources()` returns the
 *    current source file paths; `parse(file)` returns `[session]` (or `[]`). The
 *    per-file catchup cache skips unchanged files.
 *  - Batch harnesses (OpenCode): set `batch: true`, self-fingerprint inside
 *    `listSources()` (return `[]` when the store is unchanged, else a single
 *    sentinel), and `parse(sentinel)` loads every session from the store.
 */
export type HarnessCollector = {
  key: Harness;
  /** Stable name for this collector's persisted catchup cache (file harnesses). */
  cacheName: string;
  /** When true the per-file catchup cache is bypassed (the harness self-fingerprints). */
  batch?: boolean;
  /** Directories to recursively fs.watch. Missing dirs self-heal when they appear. */
  watchRoots(): string[];
  /**
   * Directories that may contain historical/import sources. Defaults to
   * `watchRoots()`, but collectors can widen this when archived sources are not
   * live-watched.
   */
  sourceRoots?(): string[];
  /**
   * Test-only escape hatch for injected collectors that intentionally use
   * synthetic paths without host roots. Production collectors must provide
   * roots so source admission can constrain historical parsing.
   */
  allowUnscopedSourceAdmission?: boolean;
  /** Which changed filenames (basename or relative path) trigger a re-import. */
  watchMatch(filename: string): boolean;
  /**
   * Map an fs.watch event to the source path(s) the collector should parse.
   * File-based collectors usually parse the changed file itself; collectors
   * whose watched files are sidecars can map back to the canonical source.
   */
  sourcePathsForWatchEvent?(root: string, filename: string): string[];
  /** Enumerate the current source paths to import. */
  listSources(): string[];
  /** Parse one source into zero or more normalized sessions. */
  parse(source: string): Promise<NormalizedSession[]>;
  /**
   * Called after a source has been successfully imported. Batch collectors use
   * this to persist durable fingerprints when parsing happened off-main-process.
   */
  markSourceImported?(source: string, snapshot?: SourceImportSnapshot): void;
  /**
   * Clears collector-owned durable ingest state that lives outside SQLite.
   * Used when the local derived session cache is reset so old source
   * fingerprints cannot suppress the rebuild.
   */
  resetIngestState?(): void;
  /**
   * Capture an idempotency token immediately before parsing. Batch collectors
   * use it to avoid marking a newer store version imported when the source
   * changes while the parsed snapshot is still being written.
   */
  sourceFingerprint?(source: string): string | null;
  /**
   * FEA-1459 Fix 11: Optional extra mtime to incorporate into the catchup cache
   * fingerprint. For claude, this is the max mtime across subagent files so that
   * a subagent-only change triggers re-import of the parent session.
   */
  extraMtime?(source: string): number | null;
  /**
   * FEA-1785: Derive the session id that a parse of this source path would
   * produce, from the path alone (no I/O). Returns null when the id is not
   * derivable without parsing (e.g. copilot chat files where the stored id is
   * content-derived and the path basename is not guaranteed to match).
   */
  sessionIdForSource?(source: string): string | null;
  /**
   * FEA-1785: Enumerate ALL current sources unconditionally, bypassing any
   * self-fingerprinting that makes listSources() return [] when the store is
   * unchanged. The data-revision rebuild needs unconditional enumeration to
   * re-derive stale sessions even when the underlying store hasn't changed.
   * File-based collectors don't need this — their listSources() is already
   * unconditional.
   */
  listSourcesForRebuild?(): string[];
  /**
   * FEA-1785: Returns true when a source is positively classified as a burst
   * artifact (e.g. codex re-serialization). When a mapped source yields zero
   * sessions under the current parser, only burst-artifact sources are deleted;
   * other zero-result parses (unreadable, incomplete, no-timestamp) are left
   * stale for retry.
   */
  isBurstArtifactSource?(source: string): boolean;
};
