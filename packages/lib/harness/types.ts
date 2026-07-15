/**
 * @file types.ts
 * @description The harness-parser output contract (FEA-1503, extracted to
 * `@repo/lib/harness` for FEA-2717). Every harness parser (Claude, Codex,
 * Cursor, Copilot, OpenCode) emits this single `NormalizedSession` shape, and
 * both the desktop first-party `importSession` write-sink and the browser
 * cloud-transcript renderer consume it. Ported verbatim from the desktop
 * collectors' `types.ts`; the desktop-only `HarnessCollector` descriptors and
 * `SourceImportSnapshot` stay in `apps/desktop`.
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
 * subtract cached at parse time (see `codex/parse-codex.ts` `nonCachedInput`).
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
  /**
   * Parser-supplied normalized subagent id that should own this tool event.
   * Undefined keeps legacy main-agent attribution.
   */
  subagentId?: string | null;
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
 * Parser-supplied subagent hierarchy for a normalized session. The `id` is a
 * parser-stable local id within the session, not a database primary key. Token
 * fields describe attribution context only; importer token tables remain
 * session-scoped and must be rolled up exactly once through the parent session.
 * `nativeSubagentId` is a Claude/Codex lookup hint for transcript linkage and
 * must not be treated as a trusted path or persistent row id.
 */
export type NormalizedSubagent = {
  id: string;
  parentId?: string | null;
  name: string;
  type?: string | null;
  task?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  status?: string | null;
  nativeSubagentId?: string | null;
  toolUses?: NormalizedToolUse[];
  tokensByModel?: Record<string, NormalizedTokenCounts>;
  tokenSeries?: NormalizedTokenRecord[];
  metadata?: Record<string, unknown>;
};

/**
 * FEA-2771: Parse-quality signal for a streamed JSONL transcript. Parsers skip
 * any line that fails `JSON.parse`, which silently drops that line's messages +
 * token usage. This exposes how many lines were dropped and, critically, whether
 * the only dropped line was the FINAL one — the benign shape of a transcript
 * truncated mid-write (an in-progress session). A malformed line anywhere before
 * the end is real corruption that lost a turn with no other signal (`apiErrors`
 * stays empty). Consumers derive the mid-file corruption count as
 * `malformedLines - (truncatedFinalLine ? 1 : 0)`; any positive value is a
 * data-integrity warning.
 *
 * FEA-2905: `totalLines`/`malformedLines` aggregate the session's MAIN
 * transcript plus its subagent sidecar files (`subagents/agent-*.jsonl`), whose
 * folded token usage is merged into the parent — so a corrupt subagent line is
 * surfaced rather than dropping tokens under a clean parse. Each subagent file's
 * own benign trailing truncation is discounted the same way the main file's is
 * (see `truncatedFinalLine`), so only genuine mid-file corruption in a subagent
 * raises the parent's `malformedLines`. `truncatedFinalLine` remains a property
 * of the main transcript's final line only.
 */
export type NormalizedParseQuality = {
  /**
   * Non-empty JSONL lines the parser attempted to decode across the main
   * transcript and its subagent sidecar files.
   */
  totalLines: number;
  /**
   * Lines skipped because `JSON.parse` threw. Counts the main transcript's
   * skipped lines plus each subagent sidecar's mid-file skips (a subagent's
   * benign trailing truncation is excluded, mirroring `truncatedFinalLine`), so
   * `malformedLines - (truncatedFinalLine ? 1 : 0)` stays the count of genuinely
   * corrupt lines across the session's transcript files.
   */
  malformedLines: number;
  /**
   * True when the final non-empty line failed to parse. Expected and benign for
   * a live/truncated file; combined with `malformedLines` it separates that one
   * tolerable drop from mid-file corruption.
   */
  truncatedFinalLine: boolean;
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
  /** Parser-supplied subagent hierarchy; omitted by legacy parsers. */
  subagents?: NormalizedSubagent[];
  plans?: NormalizedPlan[];
  /** FEA-2771: parse-quality signal; omitted by parsers that don't track it. */
  parseQuality?: NormalizedParseQuality;
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

/** Empty `usageExtras` literal — parsers spread/override as needed. */
export function emptyUsageExtras(): NormalizedSession["usageExtras"] {
  return { service_tiers: [], speeds: [], inference_geos: [] };
}

/** Empty `artifacts` literal — parsers fill as they extract references. */
export function emptyArtifacts(): NormalizedArtifacts {
  return { prs: [], issues: [], repo: null };
}

/**
 * Build a fully-defaulted `NormalizedSession`, overriding only the fields a
 * parser actually populates. This is the single source of truth for the FEA-1503
 * contract ("all array fields default to `[]`, all token maps to `{}`"): instead
 * of every harness parser re-enumerating all ~30 fields at its construction site,
 * each spreads its populated fields over these defaults. A field added to
 * `NormalizedSession` then defaults here once, rather than breaking every parser
 * construction site at compile time.
 */
export function createNormalizedSession(
  overrides: Partial<NormalizedSession> & Pick<NormalizedSession, "sessionId">
): NormalizedSession {
  return {
    name: "",
    cwd: null,
    model: null,
    version: null,
    slug: null,
    gitBranch: null,
    startedAt: null,
    endedAt: null,
    teams: [],
    userMessages: 0,
    assistantMessages: 0,
    tokensByModel: {},
    messageTimestamps: [],
    toolUses: [],
    compactions: [],
    apiErrors: [],
    fileModifiedAt: null,
    turnDurations: [],
    entrypoint: "",
    permissionMode: null,
    thinkingBlockCount: 0,
    toolResultErrors: [],
    usageExtras: emptyUsageExtras(),
    messages: [],
    tokenSeries: [],
    diffStats: null,
    slashCommands: [],
    artifacts: emptyArtifacts(),
    ...overrides,
  };
}
