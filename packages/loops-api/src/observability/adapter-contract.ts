import type { LoopHarness } from "../desktop-request";
import type { ModelTokenUsage } from "../tokens";
import type { RawPerfEvent } from "./perf-events";

/**
 * Harness-portable observability contract (Q-001/D-005).
 *
 * A `HarnessObservabilityAdapter` translates the raw stream a coding harness
 * already writes (Claude stream-json, Codex `exec --json`, …) into the canonical
 * `loop.perf.*` raw event model (`RawPerfEvent`). It introduces NO new event
 * taxonomy (AC-010); it only re-expresses an existing harness stream as existing
 * events. The adapter is fed one already-`JSON.parse`d record at a time from the
 * desktop output tailer and is stateful (it pairs starts with completions by id).
 *
 * The layer depends only on `LoopHarness` + the raw event shape + the shared
 * `ModelTokenUsage` token model, so it is reusable by ECS
 * (`containers/claude-runner/harness-agent.mjs`) without importing anything from
 * `apps/desktop`.
 */

/** Per-signal capability declaration for a harness adapter. */
export const ObservabilityCapability = {
  /** The adapter can derive this signal from the harness stream. */
  Supported: "supported",
  /** The harness stream does not expose this signal (not a parse failure). */
  Unsupported: "unsupported",
} as const;
export type ObservabilityCapability =
  (typeof ObservabilityCapability)[keyof typeof ObservabilityCapability];

/**
 * Which canonical signals an adapter can produce. Signals an adapter declares
 * `Unsupported` are simply never emitted — their absence must never surface as a
 * parse failure or missing-data alert (AC-002, AC-006).
 */
export type ObservabilityCapabilityMatrix = {
  /** `loop.perf.run` — synthesized by the run envelope, not the adapter. */
  run: ObservabilityCapability;
  /** `loop.perf.iteration` — synthesized by the run envelope, not the adapter. */
  iteration: ObservabilityCapability;
  /** `loop.perf.tool` derived from the harness stream. */
  tool: ObservabilityCapability;
  /** `loop.perf.spawn` derived from the harness stream. */
  spawn: ObservabilityCapability;
  /** `loop.perf.agent` derived from the harness stream. */
  agent: ObservabilityCapability;
  /** Token usage derived from the harness stream. */
  tokenUsage: ObservabilityCapability;
};

/**
 * Per-loop identity + clock injected when an adapter is constructed. Stamps
 * every adapter-produced raw event with consistent, non-`unknown` run identity
 * (AC-004) and supplies the wall-clock used to timestamp streams that carry no
 * timestamps of their own (Codex — AC-011, FR12).
 */
export type ObservabilityAdapterContext = {
  /** Canonical run identity (the loopId). Never `unknown` (AC-004). */
  runId: string;
  /** Single-iteration index for a bare-prompt invocation (GAP-002). */
  iteration: number;
  /** Canonical command name (PLAN/EXECUTE/…) when known. */
  command?: string;
  /** The harness this adapter was selected for. */
  harness: LoopHarness;
  /**
   * Wall-clock source returning an ISO-8601 timestamp. Injected so tests are
   * deterministic and so timestamp-less harness streams can be stamped on
   * stream-receipt (AC-011). Defaults to `() => new Date().toISOString()` at the
   * desktop call site.
   */
  now: () => string;
};

/**
 * Desktop-only active-agent lifecycle delta derived from a harness stream.
 *
 * Emitted by adapters that can observe subagent lifecycles (Claude). The
 * desktop `active-agents-registry` consumes these to drive the active-agents UI;
 * ECS ignores them (it has no active-agents feed). Adapters that cannot observe
 * subagents (Codex) never produce these, so the desktop feed is empty — not
 * errored (AC-005).
 */
export type ActiveAgentDelta =
  | {
      kind: "start";
      agentId: string;
      agentType: string;
      agentName: string;
      startedAt: string;
    }
  | { kind: "stop"; agentId: string };

/** Result of ingesting a single harness stream record. */
export type AdapterIngestResult = {
  /** Canonical raw events to route through the desktop emit pipeline. */
  events: RawPerfEvent[];
  /** Active-agent lifecycle deltas for the desktop registry (Claude only). */
  agentLifecycle: ActiveAgentDelta[];
  /**
   * Incremental token usage observed in this record (Codex
   * `turn.completed.usage`), already de-cumulated into a per-record delta. The
   * desktop folds this into the existing token-usage surface. Absent when the
   * record carried no token usage.
   */
  tokenUsage?: ModelTokenUsage;
};

/** An adapter that converts a harness stream into canonical observability. */
export type HarnessObservabilityAdapter = {
  harness: LoopHarness;
  capabilities: ObservabilityCapabilityMatrix;
  /**
   * Ingest one already-`JSON.parse`d harness stream record. Unknown / unrelated
   * records yield an empty result (never throw — stream drift is non-fatal).
   */
  ingest(record: unknown): AdapterIngestResult;
  /**
   * Flush any still-open items at stream end (best-effort). Returns canonical
   * events for items that started but never completed; default no-op.
   */
  flush(): AdapterIngestResult;
};

/** Factory that builds an adapter bound to a specific loop context. */
export type ObservabilityAdapterFactory = (
  context: ObservabilityAdapterContext
) => HarnessObservabilityAdapter;

/** Empty ingest result helper — keeps adapters terse. */
export function emptyIngestResult(): AdapterIngestResult {
  return { events: [], agentLifecycle: [] };
}
