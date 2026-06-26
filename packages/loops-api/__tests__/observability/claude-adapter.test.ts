import { describe, expect, it } from "vitest";

import { LoopHarness } from "../../src/desktop-request";
import {
  type ActiveAgentDelta,
  createClaudeObservabilityAdapter,
  type HarnessObservabilityAdapter,
  type RawPerfEvent,
} from "../../src/observability";
import { CLAUDE_STREAM_FIXTURE, makeClock, makeContext } from "./fixtures";

function drain(
  adapter: HarnessObservabilityAdapter,
  records: unknown[]
): { events: RawPerfEvent[]; lifecycle: ActiveAgentDelta[] } {
  const events: RawPerfEvent[] = [];
  const lifecycle: ActiveAgentDelta[] = [];
  for (const record of records) {
    const result = adapter.ingest(record);
    events.push(...result.events);
    lifecycle.push(...result.agentLifecycle);
  }
  const flushed = adapter.flush();
  events.push(...flushed.events);
  lifecycle.push(...flushed.agentLifecycle);
  return { events, lifecycle };
}

describe("ClaudeObservabilityAdapter (AC-001, AC-005)", () => {
  it("derives tool/spawn/agent events and active-agent deltas from stream-json", () => {
    const now = makeClock("2026-06-10T00:00:00.000Z", 1000);
    const adapter = createClaudeObservabilityAdapter(
      makeContext(LoopHarness.Claude, now)
    );
    const { events, lifecycle } = drain(adapter, CLAUDE_STREAM_FIXTURE);

    const tool = events.find((e) => e.event === "tool");
    expect(tool).toMatchObject({
      event: "tool",
      tool_name: "Bash",
      ok: true,
      agent_id: "sess_1",
      duration_s: 1,
      harness: LoopHarness.Claude,
      run_id: "loop_123",
      iteration: 1,
    });

    const spawn = events.find((e) => e.event === "spawn");
    expect(spawn).toMatchObject({
      event: "spawn",
      planned_subagent_type: "code-reviewer",
      parent_agent_id: "sess_1",
      parent_session_id: "sess_1",
      harness: LoopHarness.Claude,
    });

    const agent = events.find((e) => e.event === "agent");
    expect(agent).toMatchObject({
      event: "agent",
      agent_id: "toolu_task",
      agent_type: "code-reviewer",
      agent_name: "Review the diff",
      duration_s: 2,
      harness: LoopHarness.Claude,
    });
    // Per-subagent tokens are best-effort and omitted, never fabricated (D-008).
    expect((agent as { input_tokens?: number }).input_tokens).toBeUndefined();
    expect((agent as { output_tokens?: number }).output_tokens).toBeUndefined();

    expect(lifecycle).toEqual([
      {
        kind: "start",
        agentId: "toolu_task",
        agentType: "code-reviewer",
        agentName: "Review the diff",
        startedAt: "2026-06-10T00:00:02.000Z",
      },
      { kind: "stop", agentId: "toolu_task" },
    ]);
  });

  it("declares full capabilities", () => {
    const adapter = createClaudeObservabilityAdapter(
      makeContext(LoopHarness.Claude, makeClock())
    );
    expect(adapter.capabilities).toEqual({
      run: "supported",
      iteration: "supported",
      tool: "supported",
      spawn: "supported",
      agent: "supported",
      tokenUsage: "unsupported",
    });
  });

  it("emits a null-sentinel tool on flush for an unclosed tool", () => {
    const now = makeClock();
    const adapter = createClaudeObservabilityAdapter(
      makeContext(LoopHarness.Claude, now)
    );
    adapter.ingest({
      type: "assistant",
      session_id: "s",
      message: {
        content: [{ type: "tool_use", id: "open_1", name: "Read", input: {} }],
      },
    });
    const flushed = adapter.flush();
    expect(flushed.events).toHaveLength(1);
    expect(flushed.events[0]).toMatchObject({
      event: "tool",
      tool_name: "Read",
      ended_at: null,
      duration_s: null,
      ok: null,
    });
  });

  it("ignores unknown records without throwing", () => {
    const adapter = createClaudeObservabilityAdapter(
      makeContext(LoopHarness.Claude, makeClock())
    );
    expect(adapter.ingest({ type: "system", subtype: "init" }).events).toEqual(
      []
    );
    expect(adapter.ingest("not an object").events).toEqual([]);
    expect(adapter.ingest(null).events).toEqual([]);
  });
});
