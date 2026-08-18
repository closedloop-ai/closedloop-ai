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
import type {
  TokenCostSummary,
  TokenSourceIdentity,
} from "@repo/api/src/types/token-cost-provenance";

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
/**
 * FEA-3419: cache-write TTL subdivision of `cacheWrite`
 * (cache_creation_input_tokens). Anthropic bills 5-minute ephemeral cache
 * writes at 1.25x the base input rate and 1-hour writes at 2.0x; the unclassified
 * residual (`cacheWrite − fiveM − oneH`, always ≥ 0) prices at the default (5m)
 * rate. Presence is the provenance marker: `undefined` means the provider never
 * reported a breakdown (legacy transcripts, non-Claude harnesses); `{0,0}` means
 * an explicitly reported zero split. Validated all-or-absent at record time
 * (`validateCacheWriteTtl`) — a malformed member or a sum exceeding `cacheWrite`
 * rejects the entire split, never a fabricated partial.
 */
export type CacheWriteTtl = {
  fiveM: number;
  oneH: number;
};

export type NormalizedTokenCounts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /**
   * FEA-3419: per-model cache-write TTL subdivision. Present iff at least one
   * deduped usage entry for this model reported a valid breakdown.
   */
  cacheWriteTtl?: CacheWriteTtl;
  /**
   * FEA-2085: True when the model id keying this attribution was a fallback
   * placeholder (e.g. Codex's CODEX_FALLBACK_MODEL) rather than a model id
   * extracted from the transcript. Decouples the "guessed attribution" signal
   * from the (now priceable) model string.
   */
  inferred?: boolean;
};

/**
 * The four canonical token counters without the attribution-only `inferred`
 * flag — the raw fresh-shape counts (`input` uncached, `cacheRead`/`cacheWrite`
 * separate). Used where a counts object carries no model-attribution signal
 * (e.g. FEA-3526's per-turn Codex snapshot), so the shape is defined once here
 * rather than re-inlined.
 */
export type NormalizedTokenCountsBare = Omit<NormalizedTokenCounts, "inferred">;

/**
 * FEA-2642 (TC-038): the class of a tool invocation. Every entry is still a
 * "tool" for tool-count purposes; `kind` preserves the difference between an
 * agent-runtime orchestration tool and a workspace/IO tool.
 *   - `builtin`  — first-party IO/workspace tools (Bash, Read, Edit, Write, …).
 *   - `harness`  — agent-runtime orchestration/meta tools (Agent, Task*,
 *                  ToolSearch, Monitor, Workflow, Skill, …).
 *   - `mcp`      — an MCP tool (name starts with `mcp__`); see `mcpServer`.
 */
export type NormalizedToolKind = "builtin" | "harness" | "mcp";

/** Causal import mode supplied by the Desktop collector shell. */
export const HarnessImportMode = {
  LiveWatcher: "liveWatcher",
  Historical: "historical",
} as const;
export type HarnessImportMode =
  (typeof HarnessImportMode)[keyof typeof HarnessImportMode];

/** Markdown-backed invocation kinds that can carry exact definition evidence. */
export const NormalizedDefinitionKind = {
  Command: "command",
  Skill: "skill",
  Subagent: "subagent",
} as const;
export type NormalizedDefinitionKind =
  (typeof NormalizedDefinitionKind)[keyof typeof NormalizedDefinitionKind];

/** Exact definition content embedded by the harness in the transcript. */
export type NormalizedDefinitionSnapshot = {
  kind: NormalizedDefinitionKind;
  rawName: string;
  normalizedName: string;
  content: string;
  capturedAt: string | null;
};

/**
 * Exact focused file evidence captured during the original live watcher pass.
 * The bracket is proven by the producer before this reaches persistence.
 */
export type NormalizedInvocationDefinitionEvidence = {
  invocationId: string;
  kind: NormalizedDefinitionKind;
  rawName: string;
  normalizedName: string;
  invokedAt: string;
  content: string;
  definitionHash: string;
  normalizerContractVersion: number;
  definitionFormat: "md";
  sourcePath: string;
  sourceModifiedAt: string;
  capturedAt: string;
};

/** A tool invocation parsed from a transcript → becomes a PostToolUse event. */
export type NormalizedToolUse = {
  name: string;
  /** Harness-native spelling before component-key normalization. */
  rawName?: string;
  /** Stable component-key spelling used by attribution. */
  normalizedName?: string;
  /** FEA-2642: builtin | harness | mcp classification (see NormalizedToolKind). */
  kind?: NormalizedToolKind;
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
  /** Explicit alias for the harness-native invocation id. */
  providerToolUseId?: string;
  /** Exact markdown content embedded in the transcript, when present. */
  definitionSnapshot?: NormalizedDefinitionSnapshot;
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

/**
 * FEA-2642 (TC-039): a first-class Skill invocation. Skills are surfaced as
 * `Skill` tool_use blocks (their `input.skill` names the skill); this projects
 * them into their own list so consumers don't re-filter `toolUses` by
 * `skillName`. `subagentId` attributes the invocation to the orchestrator
 * (`null`) or a specific spawned subagent — the same per-agent axis as tools.
 */
export type NormalizedSkillUse = {
  name: string;
  rawName?: string;
  normalizedName?: string;
  timestamp: string | null;
  subagentId?: string | null;
  providerToolUseId?: string;
  definitionSnapshot?: NormalizedDefinitionSnapshot;
};

export type NormalizedSlashCommand = {
  name: string;
  timestamp: string;
  /** Stable human-turn identity (`promptId`, falling back to entry `uuid`). */
  userTurnId?: string;
  rawName?: string;
  normalizedName?: string;
  definitionSnapshot?: NormalizedDefinitionSnapshot;
};

/**
 * FEA-4093: a first-class Hook firing captured from the transcript. Claude
 * emits a `type:"attachment"` record with `attachment.type` of `hook_success`
 * / `hook_error` for every configured hook that runs, carrying `hookName`
 * (e.g. `"PreToolUse:Bash"`, `"SessionStart:startup"`), `hookEvent` (the
 * lifecycle event that triggered it), and the shell `command` that ran. This
 * projects those firings into their own list so the invocation materializer
 * can attribute them to a `Hook` agent-component row — before this, hook usage
 * was invisible (the parser dropped `attachment` records entirely), so every
 * Hook component aggregated to zero even though hooks fire regularly.
 *
 * `name` is the `hookName` (the stable per-hook identity). `event` is the
 * triggering lifecycle event. `succeeded` reflects the `hook_success` vs
 * `hook_error` attachment type so the usage rollup can count errors.
 */
export type NormalizedHookUse = {
  name: string;
  event: string | null;
  command: string | null;
  succeeded: boolean;
  timestamp: string | null;
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
  /** FEA-3419: per-event cache-write TTL subdivision; absent when unreported. */
  cacheWriteTtl?: CacheWriteTtl;
  /** FEA-2085: True when `model` is a fallback placeholder, not an extracted id. */
  inferred?: boolean;
  /**
   * FEA-3597: round-trip provenance. Present means this record came from that
   * SUBAGENT; ABSENT means it is the parent session's own round-trip.
   *
   * Parsers fold subagent token records into the ROOT session's `tokenSeries`
   * (Claude sidecars via `mergeFoldedUsage`, Codex child rollouts via a direct
   * push), so without this marker the root series is *parent + all folded
   * subagent round-trips* and cannot be split back apart — `$.subagents` is
   * consumed and dropped at import, and the provenance exists only at parse
   * time. ISS-5395: `session_turn_bucket` no longer uses this marker as an
   * exclusion — it counts EVERY round-trip in the series, because a folded
   * subagent has no session row of its own and excluding its round-trips lost
   * them rather than re-homing them. The marker stays load-bearing for the
   * per-agent consumers that genuinely split parent from child (`events`,
   * activity segments, artifact-ref ownership).
   *
   * Absence is meaningful, so this is `?: string` and is OMITTED rather than
   * written as `null` — a `null` would read as "parent" at every consumer.
   * Declared after the original count fields so serialized records gain only
   * trailing optional keys instead of a reshuffle (the golden L1 oracles are
   * byte-compared).
   *
   * May be `UNATTRIBUTED_SUBAGENT_ID` when a record is provably not the
   * parent's but no subagent identity can be recovered; that value need not
   * match any `NormalizedSubagent.id`.
   */
  subagentId?: string;
  /** Stable internal idempotency identity, independent of provider evidence. */
  transportId?: string;
  /** Ordered provider/source-record evidence when the producer can prove it. */
  sourceIdentity?: TokenSourceIdentity;
  /** Cost completeness, reason, subtotal, and additive basis lanes when known. */
  costSummary?: TokenCostSummary;
};

/**
 * FEA-3526: Codex `token_count` events carry an authoritative per-turn
 * `last_token_usage` snapshot alongside the `total_token_usage` cumulative
 * object the parser derives deltas from. This captures that snapshot verbatim
 * (canonical fresh shape: `input` uncached, `cacheRead`/`cacheWrite` separate)
 * plus the delta the parser computed for the same event and a `drifted` flag
 * when the two disagree beyond a small tolerance.
 *
 * This is METADATA ONLY — it never feeds `tokenSeries` or `tokensByModel` and
 * must not alter the canonical cumulative-derived token totals. It mirrors the
 * "authoritative vs derived" reconciliation posture PRD-538 established for
 * Claude (`apps/desktop/src/main/cost/token-usage.ts` `reconcileSessionCost`):
 * agreement validates the delta pipeline, drift is a live correctness signal.
 * Absent for sources/sessions that emit no `token_count` events (empty array).
 */
export type NormalizedCodexTokenSnapshot = {
  /** Event timestamp (ISO), or null when the event carried none. */
  timestamp: string | null;
  /** Model attributed to the event (may be the inferred fallback). */
  model: string;
  /** Authoritative per-turn `last_token_usage`, canonical fresh shape. */
  lastTokenUsage: NormalizedTokenCountsBare;
  /** Delta the parser derived from successive cumulative totals (same event). */
  derivedDelta: NormalizedTokenCountsBare;
  /**
   * True when authoritative `lastTokenUsage` and `derivedDelta` disagree beyond
   * tolerance — a delta-reconstruction correctness signal, not a token-math
   * override.
   */
  drifted: boolean;
};

/** CR-4: Aggregate diff stats for the session. */
export type NormalizedDiffStats = {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
};

/** A PR reference shared by heuristic-derived artifacts.prs and harness-authored prLinks. */
export type NormalizedPrRef = { number: string; repo?: string; url?: string };

/** CR-13: Structured artifact references extracted from tool calls. */
export type NormalizedArtifacts = {
  prs: NormalizedPrRef[];
  issues: Array<{ key: string }>;
  repo: string | null;
};

/**
 * A plan block extracted from a session's transcript. Stored on the session
 * metadata (`metadata.plans[]`) and surfaced in the dashboard Plans table.
 * Populated by both parsers: Codex from `item.type === "Plan"` /
 * `<proposed_plan>` blocks, and Claude (FEA-3553) from `ExitPlanMode` tool input
 * plus conservatively-detected inline assistant-prose plans.
 */
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
  /** Harness child-session identity when one is explicitly present. */
  childSessionId?: string | null;
  name: string;
  rawName?: string;
  normalizedName?: string;
  type?: string | null;
  task?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  status?: string | null;
  nativeSubagentId?: string | null;
  toolUses?: NormalizedToolUse[];
  tokensByModel?: Record<string, NormalizedTokenCounts>;
  tokenSeries?: NormalizedTokenRecord[];
  definitionSnapshot?: NormalizedDefinitionSnapshot;
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
  /**
   * FEA-3702 (Codex): count of `token_count` events whose in-band `rate_limits`
   * block WAS present but produced no structurally + semantically valid window
   * (e.g. a non-object block, or every window all-null). Each such record is
   * skipped with the last-good rate-limit snapshot PRESERVED (never zeroed), so a
   * positive value flags rate-limit data-quality loss without any turn/session
   * being dropped. Optional/additive: parsers that never observe an in-band
   * rate-limit block (Claude) omit it, and it defaults to 0 for Codex sessions
   * with no malformed blocks, so pre-existing payloads round-trip unchanged.
   */
  malformedRateLimits?: number;
  /**
   * FEA-3713: count of syntactically VALID JSON records the parser could not
   * route to any handler — the classifier's "unidentifiable envelope" bucket
   * (Codex `classify` → `kind:"other"`). Distinct from `malformedLines`: those
   * failed `JSON.parse`; these parsed cleanly but carry no recognizable
   * envelope/item/event type, so their content was silently dropped without
   * lowering any other parse-quality signal. Surfacing the count means a valid
   * record the parser doesn't understand can no longer be ignored invisibly, and
   * — since the count only ever grows as more unrecognized records appear —
   * appending unknown evidence can never make a session look cleaner than it is.
   *
   * Optional and emitted only when non-zero: a parser that doesn't classify
   * unknown records (the Claude core, whose unhandled entry types are by-design
   * metadata-only, not data loss) omits it, and a clean session carrying no
   * unknown records omits it too — so existing/clean payloads round-trip
   * byte-identically (no golden-snapshot churn). A future slice can extend this
   * to finer-grained unknown item/event SUBTYPES behind a known-type allowlist.
   */
  unknownRecords?: number;
  /**
   * FEA-3701: tool-output/-completion records that could not be correlated to an
   * originating call. For the Codex parser this counts MCP / function-call
   * outputs and `mcp_tool_call_end` events whose `call_id` matched no open call
   * (orphaned) — a record that, before the call-id fix, would have been
   * cross-assigned to an unrelated tool by the positional last-wins fallback.
   * Optional and omitted when zero, so a clean session round-trips unchanged and
   * only genuinely orphaned records surface the signal.
   */
  orphanedToolOutputs?: number;
  /**
   * FEA-3701: tool-output/-completion records that had NO usable identifier at
   * all and were therefore correlated by the legacy positional
   * most-recent-open-call fallback (documented compatibility path for legacy
   * identifier-free Codex data). A non-zero value means the session leaned on
   * the ambiguity-prone fallback rather than explicit call-id correlation.
   * Optional and omitted when zero.
   */
  ambiguousToolOutputs?: number;
};

/**
 * FEA-3524: one rate-limit window from a Codex `token_count` event's in-band
 * `rate_limits` block. Codex emits `used_percent` (already 0–100), the window
 * length in minutes, and an epoch-seconds `resets_at`; each is preserved
 * verbatim (or null when absent/malformed) so a downstream producer can map the
 * `primary`/`secondary` pair straight into the session-limits snapshot store
 * (see `apps/desktop/src/main/session-limits/mappers.ts` `mapStatuslineRateLimits`,
 * which already accepts this exact shape).
 */
export type CodexRateLimitWindow = {
  used_percent: number | null;
  window_minutes: number | null;
  resets_at: number | null;
};

/**
 * FEA-3524: the LATEST well-formed `rate_limits` snapshot captured from a Codex
 * rollout's `token_count` events. Most sessions carry `"rate_limits":null`;
 * this is populated only when a version-gated event surfaces the block. The two
 * observed windows are positional: `primary` (shortest window) and `secondary`
 * (longer window). Fields the harness stamps but this capture does not model
 * (`limit_id`, `plan_type`, …) are deliberately dropped — only the window
 * telemetry the snapshot store consumes is retained. Additive/optional: a
 * session without a well-formed block omits the field entirely.
 */
export type CodexRateLimits = {
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
};

/**
 * FEA-3715: the reviewed Codex protocol pin recorded in Codex parser output. The
 * canonical value lives in `codex/codex-protocol-inventory.ts`
 * (`CODEX_PROTOCOL_SUPPORT`); this is the shared shape so `NormalizedSession`
 * stays self-contained (no import from the Codex-specific inventory module).
 */
export type CodexProtocolSupport = {
  referenceRepo: string;
  pinnedCommit: string;
  reviewedOn: string;
  supportedRange: string;
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
  /**
   * FEA-4376: true when `model` was resolved from a `/model`-switch display
   * label (a human-readable NAME, not a priceable wire id) rather than an
   * authoritative assistant `msg.model`. The importer uses this to keep the
   * model column UPGRADEABLE: a fresh real assistant id (`modelIsFallback`
   * false) overwrites a previously-stored fallback label, whereas a fresh
   * fallback label stays COALESCE-sticky so it never clobbers a stored real id.
   * Omitted by parsers that never set a fallback label (treated as false).
   */
  modelIsFallback?: boolean;
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
  /** Transient Desktop causal context; absent on browser/historical parsers. */
  importMode?: HarnessImportMode;
  /** Frozen focused evidence created only during the original live watcher pass. */
  invocationDefinitionEvidence?: NormalizedInvocationDefinitionEvidence[];
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
    /**
     * FEA-3527: session-level Codex `reasoning_output_tokens` — reasoning tokens
     * that are a SUBDIVISION of the canonical `output_tokens` total (never
     * additive to it or to any grand total). Taken from the last cumulative
     * `total_token_usage` snapshot. Zeroed for sources/older sessions that don't
     * report it.
     */
    reasoning_output_tokens: number;
    /**
     * PRD-538: session-level web-search request count reported by Claude via
     * `usage.server_tool_use.web_search_requests`. Web search is billed
     * per-request (a server-side tool), NOT per-token, so this is a SESSION-level
     * line item that the cost rollup prices exactly once — it is never folded
     * into any token total or per-model `token_usage` row. The cumulative
     * per-turn counter's MAX is taken (snapshots are cumulative, so summing would
     * double-count). Zeroed for sources/older sessions that don't report it.
     */
    web_search_requests: number;
  };
  /** CR-1: Ordered per-message list with text content. */
  messages: NormalizedMessage[];
  /** CR-2: Per-turn token records for time-series reconstruction. */
  tokenSeries: NormalizedTokenRecord[];
  /**
   * FEA-3526: Codex-only authoritative per-turn `last_token_usage` snapshots
   * (metadata; never alters token totals). Omitted by non-Codex parsers.
   */
  codexLastTokenUsage?: NormalizedCodexTokenSnapshot[];
  /** CR-4: Aggregate diff stats (files changed, lines +/-). Null when absent. */
  diffStats: NormalizedDiffStats | null;
  /** CR-7: Claude slash commands extracted from transcripts. */
  slashCommands: NormalizedSlashCommand[];
  /** FEA-2642 (TC-039): first-class Skill invocations (per-agent via subagentId). */
  skills: NormalizedSkillUse[];
  /**
   * FEA-4093: first-class Hook firings extracted from `attachment` records
   * (`hook_success` / `hook_error`). Empty for parsers/sessions with no hook
   * firings; only the Claude parser populates it (hooks are a Claude concept).
   */
  hooks: NormalizedHookUse[];
  /** CR-13: Structured artifact references (PRs, issues, repo). */
  artifacts: NormalizedArtifacts;
  /** FEA-3128: harness-authored pr-link records — authoritative session→PR signal. */
  prLinks: NormalizedPrRef[];
  /**
   * FEA-3525: model context-window size (tokens) reported by Codex `token_count`
   * events (`info.model_context_window`, e.g. 258400). The latest non-negative
   * integer seen wins. Additive/optional: omitted by sources/older sessions that
   * don't report it, so pre-FEA-3525 payloads round-trip unchanged. Enables
   * context-window utilization (cumulative total_tokens vs this) at read time.
   */
  modelContextWindow?: number | null;
  /**
   * FEA-3524: latest well-formed Codex `token_count` `rate_limits` snapshot.
   * Optional and Codex-only — omitted by every other parser and by Codex
   * sessions whose events all carry `"rate_limits":null`, so pre-existing
   * payloads round-trip unchanged. Pure capture; not yet consumed by a producer.
   */
  codexRateLimits?: CodexRateLimits | null;
  /**
   * FEA-3708 (Parser roadmap 2 — preserve lineage/provenance, first slice): the
   * rollout this session was forked/resumed from, taken from Codex
   * `session_meta.forked_from_id`. It preserves the parent-rollout lineage
   * pointer on the normalized evidence itself, so a forked/resumed root session
   * still records where its replayed history came from even when the parent
   * rollout is archived or absent locally (the collector's rollout-graph reads
   * the same field only for local fold/traversal — see
   * `codex-subagent-rollouts.ts` — and drops it once the graph is built).
   * Optional and Codex-only — omitted by every other parser and by Codex
   * rollouts without the field, so pre-existing payloads round-trip unchanged.
   * Pure capture; not yet consumed by a producer.
   */
  codexForkedFromId?: string | null;
  /**
   * FEA-3715: the reviewed Codex protocol pin (`referenceRepo` + `pinnedCommit`
   * + `reviewedOn` + `supportedRange`) the parser decoded this rollout under.
   * Optional and Codex-only — omitted by every other parser and by pre-FEA-3715
   * payloads, so existing sessions round-trip unchanged. Static parser metadata:
   * it never feeds token totals and is intentionally not persisted to the DB.
   */
  codexProtocolSupport?: CodexProtocolSupport;
  /**
   * FEA-4187: true when the run ended on an UNRECOVERED API error — its last
   * parsed `APIError` occurred at or after its last assistant message, so the
   * harness never recovered and produced a real final turn. This is the
   * import-path counterpart of the live SessionEnd path's
   * `hasTrailingApiError` (see apps/desktop `write-core.ts` /
   * `trailing-api-error.ts`): both classify such a run's terminal status as
   * ERROR rather than COMPLETED, so a failed harness run is never displayed as
   * "Completed". It is stamped from the FULL parsed session before the
   * worker-response array clamp, so a truncated trailing `apiErrors`/`messages`
   * tail can't erase the signal. Optional/additive: omitted by parsers and
   * pre-FEA-4187 payloads (round-trip unchanged); the import path falls back to
   * {@link deriveEndedOnUnrecoveredError} over the on-hand arrays when it is
   * absent, and an absent/false value degrades to the prior COMPLETED default.
   */
  endedOnUnrecoveredError?: boolean;
};

/** Empty `usageExtras` literal — parsers spread/override as needed. */
export function emptyUsageExtras(): NormalizedSession["usageExtras"] {
  return {
    service_tiers: [],
    speeds: [],
    inference_geos: [],
    reasoning_output_tokens: 0,
    web_search_requests: 0,
  };
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
    skills: [],
    hooks: [],
    artifacts: emptyArtifacts(),
    prLinks: [],
    ...overrides,
  };
}

/**
 * The latest non-null timestamp across a list of records, or `null` when none
 * carry one. Records are ordered but slicing may drop the tail, so scan the max
 * rather than trusting the last element.
 */
function latestTimestamp(
  records: readonly { timestamp: string | null }[]
): string | null {
  let latest: string | null = null;
  for (const record of records) {
    if (record.timestamp && (latest === null || record.timestamp > latest)) {
      latest = record.timestamp;
    }
  }
  return latest;
}

/**
 * FEA-4187: whether a parsed session ended on an UNRECOVERED API error — its
 * last `apiErrors` entry occurred at or after its last assistant message, so
 * the harness never produced a real final turn after the error. This is the
 * import-path twin of the live `SessionEnd` classifier
 * (`hasTrailingUnrecoveredApiError` over the transcript's last-error vs
 * last-assistant timestamps in apps/desktop `write-core.ts` /
 * `trailing-api-error.ts`), derived here from the normalized evidence so a
 * historically-imported failed run classifies to ERROR instead of COMPLETED.
 *
 * Rules (identical to the live path):
 * - No API error at all → not a failure (`false`).
 * - An API error but no assistant message at all → the run never recovered
 *   into a real turn → failure (`true`).
 * - Otherwise → failure only when the last error is at/after the last
 *   assistant message (a later assistant turn means the harness recovered).
 *
 * Timestamps are compared lexicographically, matching the live helper; the
 * normalized ISO timestamps sort chronologically. A missing error timestamp is
 * ignored (contributes no signal), so a session whose only error carries a null
 * timestamp degrades to "not a failure" rather than a false positive.
 */
export function deriveEndedOnUnrecoveredError(
  session: Pick<NormalizedSession, "apiErrors" | "messages">
): boolean {
  const lastApiErrorTs = latestTimestamp(session.apiErrors ?? []);
  if (!lastApiErrorTs) {
    return false;
  }
  const lastAssistantTs = latestTimestamp(
    (session.messages ?? []).filter((message) => message.role === "assistant")
  );
  if (!lastAssistantTs) {
    return true;
  }
  return lastApiErrorTs >= lastAssistantTs;
}
