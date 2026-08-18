/**
 * @file codex-rollout-fixture.ts
 * @description Shared synthetic Codex rollout builders for the collector suites.
 * Extracted from `collectors-parsers.test.ts` (which is grandfathered
 * shrink-only) so a second suite can drive `createCodexCollector` /
 * `foldCodexDescendants` without re-declaring the record shapes.
 *
 * The date-nested layout matters: `foldCodexDescendants` resolves a rollout's
 * descendants through the on-disk graph, so a fixture must live under
 * `<root>/YYYY/MM/DD/rollout-<prefix>-<id>.jsonl` the way Codex writes it. The
 * flat `writeRollout` helpers elsewhere (e.g. `attribution-test-helpers.ts`) do
 * NOT satisfy that and cannot be substituted here.
 *
 * Everything below is synthetic — no `packages/golden-sessions` bytes are read
 * or reproduced.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { writeJsonl } from "./normalized-session-test-utils.js";

/** Standalone rollout id used by the single-file Codex parser fixtures. */
export const CODEX_UUID = "11111111-1111-4111-8111-111111111111";
/** Root rollout of the fold fixtures. */
export const CODEX_PARENT_UUID = "22222222-2222-4222-8222-222222222222";
/** Depth-1 subagent of {@link CODEX_PARENT_UUID}. */
export const CODEX_CHILD_UUID = "33333333-3333-4333-8333-333333333333";
/** Depth-2 subagent of {@link CODEX_CHILD_UUID}. */
export const CODEX_GRANDCHILD_UUID = "44444444-4444-4444-8444-444444444444";
/** Subagent whose declared parent is absent from the source list. */
export const CODEX_MISSING_PARENT_UUID = "55555555-5555-4555-8555-555555555555";
/** Rollout id deliberately written to two different source files. */
export const CODEX_DUPLICATE_UUID = "66666666-6666-4666-8666-666666666666";
/** Fork/resume rollout of {@link CODEX_PARENT_UUID}. */
export const CODEX_FORK_UUID = "77777777-7777-4777-8777-777777777777";

/** The single model key the Codex lane collapses every token entry into. */
export const CODEX_FALLBACK_MODEL = "gpt-5-codex";

/** Default `YYYY-MM-DDTHH-mm-ss` filename prefix; matches the day dir below. */
const DEFAULT_ROLLOUT_PREFIX = "2026-06-24T10-00-00";
const ROLLOUT_YEAR = "2026";
const ROLLOUT_MONTH = "06";
const ROLLOUT_DAY = "24";

/**
 * Write a rollout into the date-nested layout Codex uses
 * (`<root>/2026/06/24/rollout-<prefix>-<id>.jsonl`) and return its path. Pass a
 * distinct `prefix` per file when several rollouts share a day dir — the
 * filename is the only thing keeping them apart.
 */
export function writeCodexCollectorRollout(
  root: string,
  id: string,
  lines: unknown[],
  prefix = DEFAULT_ROLLOUT_PREFIX
): string {
  const dir = path.join(root, ROLLOUT_YEAR, ROLLOUT_MONTH, ROLLOUT_DAY);
  mkdirSync(dir, { recursive: true });
  return writeJsonl(dir, `rollout-${prefix}-${id}.jsonl`, lines);
}

/** Absolute path a {@link writeCodexCollectorRollout} call would write to. */
export function codexRolloutPath(
  root: string,
  id: string,
  prefix = DEFAULT_ROLLOUT_PREFIX
): string {
  return path.join(
    root,
    ROLLOUT_YEAR,
    ROLLOUT_MONTH,
    ROLLOUT_DAY,
    `rollout-${prefix}-${id}.jsonl`
  );
}

/** A `session_meta` record; `payload` is merged over the shared defaults. */
export function codexSessionMeta(
  timestamp: string,
  payload: Record<string, unknown>
): unknown {
  return {
    timestamp,
    type: "session_meta",
    payload: {
      cwd: "/Users/dev/codex-parent",
      cli_version: "0.40.0",
      ...payload,
    },
  };
}

/** A `session_meta` for a subagent rollout spawned from `parentThreadId`. */
export function codexSubagentMeta(
  timestamp: string,
  id: string,
  parentThreadId: string,
  depth = 1
): unknown {
  return codexSessionMeta(timestamp, {
    id,
    source: {
      subagent: {
        agent_nickname: `child-${id.slice(0, 4)}`,
        agent_role: "worker",
        thread_spawn: {
          parent_thread_id: parentThreadId,
          depth,
        },
      },
    },
  });
}

export function codexTurn(
  timestamp: string,
  model = CODEX_FALLBACK_MODEL
): unknown {
  return {
    timestamp,
    type: "turn_context",
    payload: { model, cwd: "/Users/dev/codex-parent" },
  };
}

export function codexUser(timestamp: string): unknown {
  return {
    timestamp,
    type: "event_msg",
    payload: { type: "user_message", message: "work" },
  };
}

export function codexAssistant(timestamp: string): unknown {
  return {
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "done" }],
    },
  };
}

/**
 * Optional enrichments on a `token_count` event, all of which the parser reads
 * off the same `info` block as the cumulative totals.
 *
 * - `model: null` omits `turn_context` entirely, which is what drives the
 *   parser's model-less `inferred` attribution fallback.
 * - `rateLimits` is written verbatim so a malformed block can be exercised.
 * - `lastTokenUsage` is the authoritative per-turn snapshot (FEA-3526).
 */
export type CodexTokenCountOptions = {
  model?: string | null;
  rateLimits?: unknown;
  lastTokenUsage?: {
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
  };
};

export function codexTokenCount(
  timestamp: string,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  options: CodexTokenCountOptions = {}
): unknown {
  const model =
    options.model === undefined ? CODEX_FALLBACK_MODEL : options.model;
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: cachedInputTokens,
          output_tokens: outputTokens,
        },
        ...(options.lastTokenUsage
          ? { last_token_usage: options.lastTokenUsage }
          : {}),
        ...(options.rateLimits === undefined
          ? {}
          : { rate_limits: options.rateLimits }),
      },
      ...(model === null ? {} : { turn_context: { model } }),
    },
  };
}

export function codexMcpToolCallBegin(
  timestamp: string,
  argumentsValue: unknown
): unknown {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "mcp_tool_call_begin",
      server: "github",
      method: "create_pull_request",
      arguments: argumentsValue,
    },
  };
}

/**
 * An `mcp_tool_call_end`. Omitting `callId` is the legacy identifier-free shape
 * the parser correlates positionally; passing one that no `begin` opened is the
 * orphaned-output shape.
 */
export function codexMcpToolCallEnd(
  timestamp: string,
  output: unknown,
  callId?: string
): unknown {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "mcp_tool_call_end",
      ...(callId === undefined ? {} : { call_id: callId }),
      output,
    },
  };
}

/**
 * The smallest rollout the collector will accept: meta, turn context, one user
 * turn, one assistant turn, and one cumulative `token_count`.
 */
export function minimalCodexRollout(
  id: string,
  timestamp: string,
  totals: { input: number; cached: number; output: number },
  meta?: unknown
): unknown[] {
  return [
    meta ?? codexSessionMeta(timestamp, { id, source: "exec" }),
    codexTurn(timestamp),
    codexUser(timestamp),
    codexAssistant(timestamp),
    codexTokenCount(timestamp, totals.input, totals.cached, totals.output),
  ];
}
