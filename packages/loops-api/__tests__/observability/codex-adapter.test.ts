import { describe, expect, it } from "vitest";

import { LoopHarness } from "../../src/desktop-request";
import {
  createCodexObservabilityAdapter,
  type RawPerfEvent,
} from "../../src/observability";
import type { ModelTokenUsage } from "../../src/tokens";
import { CODEX_STREAM_FIXTURE, makeClock, makeContext } from "./fixtures";

describe("CodexObservabilityAdapter (AC-002, AC-009, AC-011)", () => {
  it("maps item events to tool events with symphony-stamped timestamps", () => {
    const now = makeClock("2026-06-10T00:00:00.000Z", 1000);
    const adapter = createCodexObservabilityAdapter(
      makeContext(LoopHarness.Codex, now)
    );

    const events: RawPerfEvent[] = [];
    let tokenUsage: ModelTokenUsage | undefined;
    for (const record of CODEX_STREAM_FIXTURE) {
      const result = adapter.ingest(record);
      events.push(...result.events);
      if (result.tokenUsage) {
        tokenUsage = result.tokenUsage;
      }
      // Codex never produces active-agent deltas (AC-005).
      expect(result.agentLifecycle).toEqual([]);
    }

    const commandTool = events.find(
      (e) => e.event === "tool" && e.tool_name === "command_execution"
    );
    // started on item.started receipt, ended on item.completed receipt (AC-011).
    expect(commandTool).toMatchObject({
      event: "tool",
      tool_name: "command_execution",
      started_at: "2026-06-10T00:00:00.000Z",
      ended_at: "2026-06-10T00:00:01.000Z",
      duration_s: 1,
      ok: true,
      agent_id: "loop_123",
      harness: LoopHarness.Codex,
    });

    const fileChangeTool = events.find(
      (e) => e.event === "tool" && e.tool_name === "file_change"
    );
    // No item.started → stamp a zero-duration window at completion (AC-011).
    expect(fileChangeTool).toMatchObject({
      event: "tool",
      tool_name: "file_change",
      duration_s: 0,
      ok: true,
    });
    if (fileChangeTool && fileChangeTool.event === "tool") {
      expect(fileChangeTool.started_at).toBe(fileChangeTool.ended_at);
    }

    // turn.completed.usage → ModelTokenUsage (cached→cacheRead, reasoning folded
    // into output, no cacheCreation).
    expect(tokenUsage).toEqual({
      input: 1000,
      output: 250,
      cacheRead: 400,
    });
  });

  it("declares spawn/agent unsupported and never emits them", () => {
    const adapter = createCodexObservabilityAdapter(
      makeContext(LoopHarness.Codex, makeClock())
    );
    expect(adapter.capabilities.spawn).toBe("unsupported");
    expect(adapter.capabilities.agent).toBe("unsupported");

    const events: RawPerfEvent[] = [];
    for (const record of CODEX_STREAM_FIXTURE) {
      events.push(...adapter.ingest(record).events);
    }
    expect(events.some((e) => e.event === "spawn")).toBe(false);
    expect(events.some((e) => e.event === "agent")).toBe(false);
  });

  it("de-cumulates token usage across turns", () => {
    const adapter = createCodexObservabilityAdapter(
      makeContext(LoopHarness.Codex, makeClock())
    );
    const first = adapter.ingest({
      type: "turn.completed",
      usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 },
    });
    expect(first.tokenUsage).toEqual({ input: 100, output: 20, cacheRead: 0 });
    const second = adapter.ingest({
      type: "turn.completed",
      usage: { input_tokens: 250, cached_input_tokens: 30, output_tokens: 60 },
    });
    expect(second.tokenUsage).toEqual({
      input: 150,
      output: 40,
      cacheRead: 30,
    });
  });

  it("preserves open item type when flushing incomplete tools", () => {
    const adapter = createCodexObservabilityAdapter(
      makeContext(LoopHarness.Codex, makeClock())
    );

    adapter.ingest({
      type: "item.started",
      item: { id: "web-1", type: "web_search" },
    });

    const flushed = adapter.flush();
    expect(flushed.events).toHaveLength(1);
    expect(flushed.events[0]).toMatchObject({
      event: "tool",
      tool_name: "web_search",
      ended_at: null,
      duration_s: null,
      ok: null,
    });
  });

  it("ignores unknown records without throwing", () => {
    const adapter = createCodexObservabilityAdapter(
      makeContext(LoopHarness.Codex, makeClock())
    );
    expect(adapter.ingest({ type: "thread.started" }).events).toEqual([]);
    expect(adapter.ingest(null).events).toEqual([]);
  });
});
