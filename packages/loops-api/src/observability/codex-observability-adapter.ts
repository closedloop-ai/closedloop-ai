import { LoopHarness } from "../desktop-request";
import type { ModelTokenUsage } from "../tokens";
import {
  type AdapterIngestResult,
  emptyIngestResult,
  type HarnessObservabilityAdapter,
  type ObservabilityAdapterContext,
  ObservabilityCapability,
  type ObservabilityCapabilityMatrix,
} from "./adapter-contract";
import { asNumber, asRecord, asString, durationSeconds } from "./adapter-utils";
import type { RawPerfEvent } from "./perf-events";

/**
 * Codex `exec --json` observability adapter (AC-002, AC-009, AC-011).
 *
 * Codex emits an item-oriented event stream:
 * `{type:"item.started", item:{id, type, …}}` / `{type:"item.completed", …}` for
 * tool-shaped work (`command_execution`, `file_change`, `mcp_tool_call`,
 * `web_search`) and `{type:"turn.completed", usage:{…}}` for token usage. The
 * stream carries no per-item timestamps, so this adapter stamps `started_at` on
 * `item.started` receipt and `ended_at` on `item.completed` receipt, pairing by
 * `item.id` (AC-011, FR12).
 *
 * Codex has no subagent model, so `spawn`/`agent` are declared `Unsupported` and
 * never emitted — their absence is not a parse failure (AC-002, AC-006), and the
 * desktop active-agents feed stays empty-not-errored for Codex loops (AC-005).
 */

const TOOL_ITEM_TYPES = new Set<string>([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
]);

const CODEX_CAPABILITIES: ObservabilityCapabilityMatrix = {
  run: ObservabilityCapability.Supported,
  iteration: ObservabilityCapability.Supported,
  tool: ObservabilityCapability.Supported,
  spawn: ObservabilityCapability.Unsupported,
  agent: ObservabilityCapability.Unsupported,
  tokenUsage: ObservabilityCapability.Supported,
};

/** Normalize the wrapper event type across Codex CLI version drift. */
function normalizeEventType(type: string): string {
  return type.replace(/_/g, ".");
}

/** Read the item type from either `item.type` or `item.item_type`. */
function itemType(item: Record<string, unknown>): string | undefined {
  return asString(item.type) ?? asString(item.item_type);
}

/** Determine tool success from a completed item's exit code / status. */
function itemOk(item: Record<string, unknown>): boolean {
  if (typeof item.exit_code === "number") {
    return item.exit_code === 0;
  }
  const status = asString(item.status);
  if (status) {
    return status !== "failed" && status !== "error";
  }
  return true;
}

class CodexObservabilityAdapter implements HarnessObservabilityAdapter {
  readonly harness = LoopHarness.Codex;
  readonly capabilities = CODEX_CAPABILITIES;

  private readonly ctx: ObservabilityAdapterContext;
  /** item.id → pending tool metadata stamped on item.started receipt. */
  private readonly openItems = new Map<
    string,
    { startedAt: string; type: string }
  >();
  /** Previous cumulative token totals, for de-cumulating per-turn deltas. */
  private prevUsage: { input: number; cacheRead: number; output: number } = {
    input: 0,
    cacheRead: 0,
    output: 0,
  };

  constructor(ctx: ObservabilityAdapterContext) {
    this.ctx = ctx;
  }

  ingest(record: unknown): AdapterIngestResult {
    const rec = asRecord(record);
    const rawType = rec ? asString(rec.type) : undefined;
    if (!(rec && rawType)) {
      return emptyIngestResult();
    }
    const type = normalizeEventType(rawType);
    if (type === "item.started") {
      return this.handleItemStarted(rec);
    }
    if (type === "item.completed") {
      return this.handleItemCompleted(rec);
    }
    if (type === "turn.completed") {
      return this.handleTurnCompleted(rec);
    }
    return emptyIngestResult();
  }

  flush(): AdapterIngestResult {
    // Items that started but never completed: emit a terminal tool with null
    // ended_at/duration/ok (the documented "started but never completed"
    // sentinel), still symphony-stamped at start.
    const result = emptyIngestResult();
    for (const [, openItem] of this.openItems) {
      result.events.push(
        this.toolEvent(openItem.type, openItem.startedAt, null, null)
      );
    }
    this.openItems.clear();
    return result;
  }

  private handleItemStarted(rec: Record<string, unknown>): AdapterIngestResult {
    const item = asRecord(rec.item);
    const id = item ? asString(item.id) : undefined;
    const type = item ? itemType(item) : undefined;
    if (!(id && type && TOOL_ITEM_TYPES.has(type))) {
      return emptyIngestResult();
    }
    // Stamp start on receipt; only the first start for an id wins (AC-011).
    if (!this.openItems.has(id)) {
      this.openItems.set(id, { startedAt: this.ctx.now(), type });
    }
    return emptyIngestResult();
  }

  private handleItemCompleted(
    rec: Record<string, unknown>
  ): AdapterIngestResult {
    const item = asRecord(rec.item);
    const id = item ? asString(item.id) : undefined;
    const type = item ? itemType(item) : undefined;
    if (!(item && id && type && TOOL_ITEM_TYPES.has(type))) {
      return emptyIngestResult();
    }
    const endedAt = this.ctx.now();
    // Pair with the recorded start; if no start was seen, stamp a zero-duration
    // window at completion so the tool still carries symphony timestamps.
    const startedAt = this.openItems.get(id)?.startedAt ?? endedAt;
    this.openItems.delete(id);
    const result = emptyIngestResult();
    result.events.push(this.toolEvent(type, startedAt, endedAt, itemOk(item)));
    return result;
  }

  private handleTurnCompleted(
    rec: Record<string, unknown>
  ): AdapterIngestResult {
    const usage = asRecord(rec.usage);
    if (!usage) {
      return emptyIngestResult();
    }
    // Codex usage is cumulative across turns (matching the rollout token_count
    // convention). De-cumulate into a per-record delta so the desktop can sum
    // deltas without double counting.
    const curInput = asNumber(usage.input_tokens);
    const curCacheRead = asNumber(usage.cached_input_tokens);
    const curOutput =
      asNumber(usage.output_tokens) + asNumber(usage.reasoning_output_tokens);

    const deltaInput = Math.max(0, curInput - this.prevUsage.input);
    const deltaCacheRead = Math.max(0, curCacheRead - this.prevUsage.cacheRead);
    const deltaOutput = Math.max(0, curOutput - this.prevUsage.output);
    this.prevUsage = {
      input: curInput,
      cacheRead: curCacheRead,
      output: curOutput,
    };

    if (deltaInput === 0 && deltaCacheRead === 0 && deltaOutput === 0) {
      return emptyIngestResult();
    }
    const tokenUsage: ModelTokenUsage = {
      input: deltaInput,
      output: deltaOutput,
      // No cache-creation concept in Codex (D: cached_input_tokens→cacheRead).
      cacheRead: deltaCacheRead,
    };
    return { events: [], agentLifecycle: [], tokenUsage };
  }

  private toolEvent(
    toolName: string,
    startedAt: string,
    endedAt: string | null,
    ok: boolean | null
  ): RawPerfEvent {
    return {
      event: "tool",
      run_id: this.ctx.runId,
      iteration: this.ctx.iteration,
      // Codex tool work runs in the single root agent (no subagents).
      agent_id: this.ctx.runId,
      tool_name: toolName,
      started_at: startedAt,
      ended_at: endedAt,
      duration_s: endedAt === null ? null : durationSeconds(startedAt, endedAt),
      ok,
      harness: this.harness,
      ...(this.ctx.command ? { command: this.ctx.command } : {}),
    };
  }
}

/** Build a Codex observability adapter bound to a loop context. */
export function createCodexObservabilityAdapter(
  context: ObservabilityAdapterContext
): HarnessObservabilityAdapter {
  return new CodexObservabilityAdapter(context);
}
