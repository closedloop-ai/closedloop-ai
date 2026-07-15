import type { Harness, NormalizedSession } from "./collectors/types.js";

/** Snake_case hook payload `data` block as delivered by the hook handlers. */
export type HookData = {
  session_id?: string;
  cwd?: string;
  model?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown> | null;
  source?: string;
  stop_reason?: string;
  message?: string;
  agent_type?: string;
  subagent_type?: string;
  prompt?: string;
  description?: string;
  session_name?: string;
  [key: string]: unknown;
};

/**
 * The harness that POSTs live hook events. Attribution is route-owned (the
 * listener sets it from the request path), never payload-chosen. Codex hooks
 * were removed (PRD-431), so Claude is the only harness that emits hooks today —
 * a single-member union that keeps the hook write path (`processEvent` /
 * `handleHook`) statically narrow. This is intentionally NOT the broader
 * `Harness`: the importer/collector path handles all five harnesses, but the
 * hook path only ever sees "claude".
 */
export type HookHarness = "claude";

/** Cumulative per-model token counts from the current transcript segment. */
export type TokenUsageCounts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** FEA-2085: true when `model` is a fallback placeholder, not an extracted id. */
  inferred?: boolean;
};

/** Effective reconciled per-(session, model) token counts. Internal: never crosses IPC. */
export type TokenUsageRow = {
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd?: number;
};

export type ImportResult = {
  /** True when the session already existed and nothing new was written. */
  skipped: boolean;
  /** True when a terminal session was revived because its file is recently active. */
  reactivated: boolean;
  /** True when the importer failed before the session was durably handled. */
  failed?: boolean;
  /**
   * True when the session was durably handled but at least one (tolerated)
   * record group failed to commit, so the import is partial. The collector must
   * NOT mark the source seen — it should re-import next pass to retry the failed
   * group (each group is idempotent, so committed groups converge). Unlike
   * `failed`, this does not halt the rest of the source.
   */
  incomplete?: boolean;
};

export type Importer = {
  importSession(
    session: NormalizedSession,
    harness: Harness
  ): ImportResult | Promise<ImportResult>;
};
