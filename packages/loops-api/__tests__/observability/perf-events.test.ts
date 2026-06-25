import { describe, expect, it } from "vitest";

import { LoopHarness } from "../../src/desktop-request";
import { perfEventSchema } from "../../src/observability";

describe("perfEventSchema (relocated SSOT)", () => {
  it("parses a legacy plugin record with no harness field (AC-007)", () => {
    const legacy = {
      event: "tool",
      run_id: "run_1",
      iteration: 1,
      agent_id: "agent_1",
      tool_name: "Bash",
      started_at: "2026-06-10T00:00:00.000Z",
      ended_at: "2026-06-10T00:00:01.000Z",
      duration_s: 1,
      ok: true,
    };
    const parsed = perfEventSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.event).toBe("tool");
      // harness is absent for legacy records.
      expect((parsed.data as { harness?: string }).harness).toBeUndefined();
    }
  });

  it("accepts the optional harness discriminator (D-007)", () => {
    const native = {
      event: "run",
      run_id: "run_1",
      started_at: "2026-06-10T00:00:00.000Z",
      harness: LoopHarness.Codex,
    };
    const parsed = perfEventSchema.safeParse(native);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.event === "run") {
      expect(parsed.data.harness).toBe(LoopHarness.Codex);
    }
  });

  it("still parses all 8 legacy event types (AC-007)", () => {
    const base = { run_id: "r", iteration: 2 };
    const samples: Record<string, unknown>[] = [
      { event: "run", run_id: "r", started_at: "t" },
      {
        event: "phase",
        ...base,
        phase: "Phase 1",
        status: "running",
        started_at: "t",
      },
      {
        event: "iteration",
        ...base,
        started_at: "t",
        ended_at: "t2",
        duration_s: 1,
        status: "ok",
      },
      {
        event: "pipeline_step",
        ...base,
        step: 8.5,
        step_name: "x",
        started_at: "t",
        ended_at: "t2",
        duration_s: 1,
        skipped: false,
      },
      {
        event: "agent",
        ...base,
        agent_id: "a",
        agent_type: "t",
        agent_name: "n",
        started_at: "t",
        ended_at: "t2",
        duration_s: 1,
      },
      {
        event: "tool",
        ...base,
        agent_id: "a",
        tool_name: "Bash",
        started_at: "t",
      },
      {
        event: "skill",
        ...base,
        agent_id: "a",
        tool_name: "Skill",
        skill_name: "s",
        started_at: "t",
        ended_at: "t2",
        duration_s: 1,
        ok: true,
      },
      {
        event: "spawn",
        ...base,
        parent_agent_id: "p",
        started_at: "t",
      },
    ];
    for (const sample of samples) {
      const parsed = perfEventSchema.safeParse(sample);
      expect(parsed.success, `event=${sample.event}`).toBe(true);
    }
  });
});
