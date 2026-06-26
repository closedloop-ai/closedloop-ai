import { LoopHarness } from "../desktop-request";
import {
  type AdapterIngestResult,
  emptyIngestResult,
  type HarnessObservabilityAdapter,
  type ObservabilityAdapterContext,
  ObservabilityCapability,
  type ObservabilityCapabilityMatrix,
} from "./adapter-contract";
import { asRecord, asString, durationSeconds } from "./adapter-utils";
import type { RawPerfEvent } from "./perf-events";

/**
 * Claude stream-json observability adapter (AC-001, AC-005).
 *
 * Parses the `claude -p --output-format stream-json` record stream into
 * canonical `tool`, `spawn`, and `agent` raw events:
 * - `tool_use` blocks open a pending tool keyed by block id.
 * - the matching `tool_result` (paired by `tool_use_id`) closes it and emits a
 *   `loop.perf.tool` with symphony-stamped started/ended timestamps.
 * - a `tool_use` named `Task` is a subagent spawn: it emits `loop.perf.spawn`
 *   immediately and an active-agent `start` delta; its `tool_result` emits
 *   `loop.perf.agent` and an active-agent `stop` delta.
 *
 * Per-subagent token attribution is best-effort and omitted here: the top-level
 * stream does not cleanly attribute usage to a specific subagent, so `agent`
 * events carry duration + type/name only and never fabricate token counts
 * (D-008/Q-004). The parser is version-tolerant: unknown records are ignored,
 * never reported as parse failures.
 */

const TASK_TOOL_NAME = "Task";
const ROOT_AGENT_ID = "root";

const CLAUDE_CAPABILITIES: ObservabilityCapabilityMatrix = {
  run: ObservabilityCapability.Supported,
  iteration: ObservabilityCapability.Supported,
  tool: ObservabilityCapability.Supported,
  spawn: ObservabilityCapability.Supported,
  agent: ObservabilityCapability.Supported,
  tokenUsage: ObservabilityCapability.Unsupported,
};

type OpenTool = {
  toolName: string;
  startedAt: string;
  agentId: string;
  isTask: boolean;
  agentType: string;
  agentName: string;
};

class ClaudeObservabilityAdapter implements HarnessObservabilityAdapter {
  readonly harness = LoopHarness.Claude;
  readonly capabilities = CLAUDE_CAPABILITIES;

  private readonly ctx: ObservabilityAdapterContext;
  private readonly openTools = new Map<string, OpenTool>();
  private sessionId: string | undefined;

  constructor(ctx: ObservabilityAdapterContext) {
    this.ctx = ctx;
  }

  ingest(record: unknown): AdapterIngestResult {
    const rec = asRecord(record);
    if (!rec) {
      return emptyIngestResult();
    }
    const sessionId = asString(rec.session_id);
    if (sessionId) {
      this.sessionId = sessionId;
    }
    const type = rec.type;
    if (type === "assistant") {
      return this.handleAssistant(rec);
    }
    if (type === "user") {
      return this.handleUser(rec);
    }
    return emptyIngestResult();
  }

  flush(): AdapterIngestResult {
    // Emit a best-effort terminal `tool` for any tool that never completed
    // (the harness exited mid-call). ended_at/duration/ok are left null — the
    // documented sentinel for "started but never completed". Open subagents are
    // also closed as `tool` rather than fabricating an `agent` window.
    const result = emptyIngestResult();
    for (const [, open] of this.openTools) {
      result.events.push(this.toolEvent(open, null, null));
      if (open.isTask) {
        result.agentLifecycle.push({ kind: "stop", agentId: open.agentId });
      }
    }
    this.openTools.clear();
    return result;
  }

  private handleAssistant(rec: Record<string, unknown>): AdapterIngestResult {
    const result = emptyIngestResult();
    const message = asRecord(rec.message);
    const content = message?.content;
    if (!Array.isArray(content)) {
      return result;
    }
    const parentToolUseId = asString(rec.parent_tool_use_id);
    for (const rawBlock of content) {
      const block = asRecord(rawBlock);
      if (block?.type !== "tool_use") {
        continue;
      }
      const id = asString(block.id);
      const toolName = asString(block.name);
      if (!(id && toolName)) {
        continue;
      }
      const input = asRecord(block.input) ?? {};
      const isTask = toolName === TASK_TOOL_NAME;
      const startedAt = this.ctx.now();
      if (isTask) {
        const agentType = asString(input.subagent_type) ?? "agent";
        const agentName = asString(input.description) ?? agentType;
        this.openTools.set(id, {
          toolName,
          startedAt,
          agentId: id,
          isTask: true,
          agentType,
          agentName,
        });
        result.events.push(this.spawnEvent(parentToolUseId, agentType));
        result.agentLifecycle.push({
          kind: "start",
          agentId: id,
          agentType,
          agentName,
          startedAt,
        });
      } else {
        this.openTools.set(id, {
          toolName,
          startedAt,
          agentId: parentToolUseId ?? this.sessionId ?? ROOT_AGENT_ID,
          isTask: false,
          agentType: "",
          agentName: "",
        });
      }
    }
    return result;
  }

  private handleUser(rec: Record<string, unknown>): AdapterIngestResult {
    const result = emptyIngestResult();
    const message = asRecord(rec.message);
    const content = message?.content;
    if (!Array.isArray(content)) {
      return result;
    }
    for (const rawBlock of content) {
      const block = asRecord(rawBlock);
      if (block?.type !== "tool_result") {
        continue;
      }
      const toolUseId = asString(block.tool_use_id);
      if (!toolUseId) {
        continue;
      }
      const open = this.openTools.get(toolUseId);
      if (!open) {
        continue;
      }
      this.openTools.delete(toolUseId);
      const endedAt = this.ctx.now();
      const ok = block.is_error !== true;
      if (open.isTask) {
        result.events.push(this.agentEvent(open, endedAt));
        result.agentLifecycle.push({ kind: "stop", agentId: open.agentId });
      } else {
        result.events.push(this.toolEvent(open, endedAt, ok));
      }
    }
    return result;
  }

  private spawnEvent(
    parentToolUseId: string | undefined,
    plannedSubagentType: string
  ): RawPerfEvent {
    return {
      event: "spawn",
      run_id: this.ctx.runId,
      iteration: this.ctx.iteration,
      parent_agent_id: parentToolUseId ?? this.sessionId ?? ROOT_AGENT_ID,
      planned_subagent_type: plannedSubagentType,
      started_at: this.ctx.now(),
      harness: this.harness,
      ...(this.ctx.command ? { command: this.ctx.command } : {}),
      ...(this.sessionId ? { parent_session_id: this.sessionId } : {}),
    };
  }

  private agentEvent(open: OpenTool, endedAt: string): RawPerfEvent {
    return {
      event: "agent",
      run_id: this.ctx.runId,
      iteration: this.ctx.iteration,
      agent_id: open.agentId,
      agent_type: open.agentType,
      agent_name: open.agentName,
      started_at: open.startedAt,
      ended_at: endedAt,
      duration_s: durationSeconds(open.startedAt, endedAt),
      harness: this.harness,
      ...(this.ctx.command ? { command: this.ctx.command } : {}),
      ...(this.sessionId ? { parent_session_id: this.sessionId } : {}),
    };
  }

  private toolEvent(
    open: OpenTool,
    endedAt: string | null,
    ok: boolean | null
  ): RawPerfEvent {
    return {
      event: "tool",
      run_id: this.ctx.runId,
      iteration: this.ctx.iteration,
      agent_id: open.agentId,
      tool_name: open.toolName,
      started_at: open.startedAt,
      ended_at: endedAt,
      duration_s:
        endedAt === null ? null : durationSeconds(open.startedAt, endedAt),
      ok,
      harness: this.harness,
      ...(this.ctx.command ? { command: this.ctx.command } : {}),
    };
  }
}

/** Build a Claude observability adapter bound to a loop context. */
export function createClaudeObservabilityAdapter(
  context: ObservabilityAdapterContext
): HarnessObservabilityAdapter {
  return new ClaudeObservabilityAdapter(context);
}
