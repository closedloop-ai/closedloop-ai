import { describe, expect, it } from "vitest";
import {
  computePerfSummary,
  isPerfEvent,
  parsePerfEvents,
  parsePerfSummary,
} from "../perf-parser";

// ---------- helpers ----------

function toBuffer(content: string): Buffer {
  return Buffer.from(content, "utf-8");
}

function makeIterationLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: "iteration",
    run_id: "run-1",
    iteration: 1,
    duration_s: 10,
    status: "success",
    started_at: "2025-01-01T00:00:00Z",
    ended_at: "2025-01-01T00:00:10Z",
    claude_exit_code: 0,
    ...overrides,
  });
}

function makeAgentLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: "agent",
    run_id: "run-1",
    iteration: 1,
    agent_id: "agent-1",
    agent_type: "orchestrator",
    agent_name: "Orchestrator",
    started_at: "2025-01-01T00:00:00Z",
    ended_at: "2025-01-01T00:00:05Z",
    duration_s: 5,
    ...overrides,
  });
}

function makePipelineStepLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: "pipeline_step",
    run_id: "run-1",
    iteration: 1,
    step: 1,
    step_name: "build",
    duration_s: 3,
    skipped: false,
    exit_code: 0,
    started_at: "2025-01-01T00:00:00Z",
    ended_at: "2025-01-01T00:00:03Z",
    ...overrides,
  });
}

// ---------- isPerfEvent ----------

describe("isPerfEvent", () => {
  it("returns true for a valid iteration event", () => {
    expect(
      isPerfEvent({
        event: "iteration",
        run_id: "r1",
        iteration: 1,
        duration_s: 5,
      })
    ).toBe(true);
  });

  it("returns true for a valid pipeline_step event", () => {
    expect(
      isPerfEvent({
        event: "pipeline_step",
        run_id: "r1",
        step_name: "build",
        duration_s: 2,
      })
    ).toBe(true);
  });

  it("returns true for a valid agent event", () => {
    expect(
      isPerfEvent({
        event: "agent",
        run_id: "r1",
        agent_name: "Orchestrator",
        duration_s: 8,
      })
    ).toBe(true);
  });

  it("returns false for null", () => {
    expect(isPerfEvent(null)).toBe(false);
  });

  it("returns false for a non-object value", () => {
    expect(isPerfEvent("iteration")).toBe(false);
    expect(isPerfEvent(42)).toBe(false);
  });

  it("returns false for an unknown event type", () => {
    expect(
      isPerfEvent({
        event: "unknown_type",
        run_id: "r1",
        duration_s: 5,
      })
    ).toBe(false);
  });

  it("returns false for iteration event missing required fields", () => {
    // missing iteration number
    expect(
      isPerfEvent({ event: "iteration", run_id: "r1", duration_s: 5 })
    ).toBe(false);
    // missing duration_s
    expect(
      isPerfEvent({ event: "iteration", run_id: "r1", iteration: 1 })
    ).toBe(false);
  });

  it("returns false for pipeline_step event missing required fields", () => {
    // missing step_name
    expect(
      isPerfEvent({ event: "pipeline_step", run_id: "r1", duration_s: 2 })
    ).toBe(false);
  });

  it("returns false for agent event missing required fields", () => {
    // missing agent_name
    expect(isPerfEvent({ event: "agent", run_id: "r1", duration_s: 8 })).toBe(
      false
    );
  });
});

// ---------- parsePerfEvents ----------

describe("parsePerfEvents", () => {
  it("returns empty array for an empty buffer", () => {
    const result = parsePerfEvents(Buffer.alloc(0));
    expect(result).toEqual([]);
  });

  it("parses a single valid iteration event", () => {
    const buffer = toBuffer(makeIterationLine());
    const result = parsePerfEvents(buffer);
    expect(result).toHaveLength(1);
    expect(result[0]!.event).toBe("iteration");
  });

  it("parses multiple events of different types from separate lines", () => {
    const buffer = toBuffer(
      [makeIterationLine(), makeAgentLine(), makePipelineStepLine()].join("\n")
    );
    const result = parsePerfEvents(buffer);
    expect(result).toHaveLength(3);
    expect(result[0]!.event).toBe("iteration");
    expect(result[1]!.event).toBe("agent");
    expect(result[2]!.event).toBe("pipeline_step");
  });

  it("skips malformed JSON lines without throwing", () => {
    const buffer = toBuffer(
      [
        makeIterationLine({ iteration: 1 }),
        "this is { not valid json",
        makeIterationLine({ iteration: 2 }),
      ].join("\n")
    );
    const result = parsePerfEvents(buffer);
    expect(result).toHaveLength(2);
  });

  it("skips lines that do not satisfy isPerfEvent (unknown event type)", () => {
    const unknownEvent = JSON.stringify({
      event: "unknown_type",
      run_id: "r1",
      duration_s: 5,
    });
    const buffer = toBuffer(
      [makeIterationLine(), unknownEvent, makeAgentLine()].join("\n")
    );
    const result = parsePerfEvents(buffer);
    expect(result).toHaveLength(2);
    expect(
      result.every((e) => e.event === "iteration" || e.event === "agent")
    ).toBe(true);
  });

  it("skips lines exceeding 64KB but still processes other lines", () => {
    const oversizedLine = "x".repeat(65_537); // > MAX_LINE_BYTES (65536)
    const buffer = toBuffer(
      [makeIterationLine(), oversizedLine, makeAgentLine()].join("\n")
    );
    const result = parsePerfEvents(buffer);
    expect(result).toHaveLength(2);
    expect(result[0]!.event).toBe("iteration");
    expect(result[1]!.event).toBe("agent");
  });

  it("skips blank lines without error", () => {
    const buffer = toBuffer(
      ["", makeIterationLine(), "   ", makeAgentLine(), ""].join("\n")
    );
    const result = parsePerfEvents(buffer);
    expect(result).toHaveLength(2);
  });

  it("stops processing after 10,000 events", () => {
    const lines: string[] = [];
    // 10,001 valid iteration lines
    for (let i = 1; i <= 10_001; i++) {
      lines.push(makeIterationLine({ iteration: i }));
    }
    const buffer = toBuffer(lines.join("\n"));
    const result = parsePerfEvents(buffer);
    expect(result).toHaveLength(10_000);
  });
});

// ---------- computePerfSummary ----------

describe("computePerfSummary", () => {
  it("returns zero totals and empty breakdowns for an empty event list", () => {
    const summary = computePerfSummary([]);
    expect(summary.totalIterations).toBe(0);
    expect(summary.totalDurationS).toBe(0);
    expect(summary.agentBreakdown).toEqual([]);
    expect(summary.pipelineStepBreakdown).toEqual([]);
  });

  it("counts a single iteration event correctly", () => {
    const events = parsePerfEvents(
      toBuffer(makeIterationLine({ duration_s: 7 }))
    );
    const summary = computePerfSummary(events);
    expect(summary.totalIterations).toBe(1);
    expect(summary.totalDurationS).toBe(7);
  });

  it("sums duration across multiple iteration events", () => {
    const buffer = toBuffer(
      [
        makeIterationLine({ iteration: 1, duration_s: 10 }),
        makeIterationLine({ iteration: 2, duration_s: 20 }),
        makeIterationLine({ iteration: 3, duration_s: 5 }),
      ].join("\n")
    );
    const events = parsePerfEvents(buffer);
    const summary = computePerfSummary(events);
    expect(summary.totalIterations).toBe(3);
    expect(summary.totalDurationS).toBe(35);
  });

  it("aggregates agent events by agent_name with callCount and totalDurationS", () => {
    const buffer = toBuffer(
      [
        makeAgentLine({ agent_name: "Orchestrator", duration_s: 5 }),
        makeAgentLine({ agent_name: "Orchestrator", duration_s: 3 }),
        makeAgentLine({ agent_name: "Implementation", duration_s: 8 }),
      ].join("\n")
    );
    const events = parsePerfEvents(buffer);
    const summary = computePerfSummary(events);

    expect(summary.agentBreakdown).toHaveLength(2);

    const orch = summary.agentBreakdown.find(
      (a) => a.agentName === "Orchestrator"
    );
    expect(orch).toBeDefined();
    expect(orch!.callCount).toBe(2);
    expect(orch!.totalDurationS).toBe(8);

    const impl = summary.agentBreakdown.find(
      (a) => a.agentName === "Implementation"
    );
    expect(impl).toBeDefined();
    expect(impl!.callCount).toBe(1);
    expect(impl!.totalDurationS).toBe(8);
  });

  it("includes agentType in agent breakdown entries", () => {
    const buffer = toBuffer(
      makeAgentLine({ agent_name: "Orchestrator", agent_type: "orchestrator" })
    );
    const events = parsePerfEvents(buffer);
    const summary = computePerfSummary(events);
    expect(summary.agentBreakdown[0]!.agentType).toBe("orchestrator");
  });

  it("aggregates pipeline_step events with skipCount", () => {
    const buffer = toBuffer(
      [
        makePipelineStepLine({ step_name: "build", skipped: false }),
        makePipelineStepLine({ step_name: "build", skipped: true }),
        makePipelineStepLine({ step_name: "build", skipped: true }),
        makePipelineStepLine({ step_name: "test", skipped: false }),
      ].join("\n")
    );
    const events = parsePerfEvents(buffer);
    const summary = computePerfSummary(events);

    expect(summary.pipelineStepBreakdown).toHaveLength(2);

    const build = summary.pipelineStepBreakdown.find(
      (s) => s.stepName === "build"
    );
    expect(build).toBeDefined();
    expect(build!.callCount).toBe(3);
    expect(build!.skipCount).toBe(2);

    const test = summary.pipelineStepBreakdown.find(
      (s) => s.stepName === "test"
    );
    expect(test).toBeDefined();
    expect(test!.callCount).toBe(1);
    expect(test!.skipCount).toBe(0);
  });

  it("does not add agents beyond 50 distinct names to breakdown", () => {
    const lines: string[] = [];
    // 51 distinct agent names
    for (let i = 1; i <= 51; i++) {
      lines.push(
        makeAgentLine({ agent_name: `Agent-${i}`, agent_id: `a-${i}` })
      );
    }
    const events = parsePerfEvents(toBuffer(lines.join("\n")));
    const summary = computePerfSummary(events);
    expect(summary.agentBreakdown.length).toBeLessThanOrEqual(50);
  });

  it("caps agent_name longer than 255 characters to 255 characters in breakdown", () => {
    const longName = "A".repeat(300);
    const buffer = toBuffer(makeAgentLine({ agent_name: longName }));
    const events = parsePerfEvents(buffer);
    const summary = computePerfSummary(events);
    expect(summary.agentBreakdown).toHaveLength(1);
    expect(summary.agentBreakdown[0]!.agentName).toHaveLength(255);
    expect(summary.agentBreakdown[0]!.agentName).toBe("A".repeat(255));
  });
});

// ---------- parsePerfSummary (integration) ----------

describe("parsePerfSummary", () => {
  it("returns zero totals and empty arrays for an empty buffer", () => {
    const summary = parsePerfSummary(Buffer.alloc(0));
    expect(summary.totalIterations).toBe(0);
    expect(summary.totalDurationS).toBe(0);
    expect(summary.agentBreakdown).toEqual([]);
    expect(summary.pipelineStepBreakdown).toEqual([]);
  });

  it("parses a single iteration event from buffer and returns correct summary", () => {
    const buffer = toBuffer(makeIterationLine({ duration_s: 15 }));
    const summary = parsePerfSummary(buffer);
    expect(summary.totalIterations).toBe(1);
    expect(summary.totalDurationS).toBe(15);
  });

  it("parses mixed event types and produces combined summary", () => {
    const buffer = toBuffer(
      [
        makeIterationLine({ iteration: 1, duration_s: 10 }),
        makeAgentLine({ agent_name: "Orchestrator", duration_s: 4 }),
        makePipelineStepLine({ step_name: "build", skipped: false }),
        makePipelineStepLine({ step_name: "build", skipped: true }),
      ].join("\n")
    );
    const summary = parsePerfSummary(buffer);
    expect(summary.totalIterations).toBe(1);
    expect(summary.totalDurationS).toBe(10);
    expect(summary.agentBreakdown).toHaveLength(1);
    expect(summary.agentBreakdown[0]!.agentName).toBe("Orchestrator");
    expect(summary.pipelineStepBreakdown).toHaveLength(1);
    expect(summary.pipelineStepBreakdown[0]!.skipCount).toBe(1);
  });
});
