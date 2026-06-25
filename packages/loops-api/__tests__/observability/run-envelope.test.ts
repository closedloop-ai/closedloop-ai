import { describe, expect, it } from "vitest";

import { LoopHarness } from "../../src/desktop-request";
import { createLoopRunEnvelope } from "../../src/observability";
import { makeClock } from "./fixtures";

describe("LoopRunEnvelope (AC-004)", () => {
  it("synthesizes run + single iteration with non-unknown identity", () => {
    const now = makeClock("2026-06-10T00:00:00.000Z", 5000);
    const envelope = createLoopRunEnvelope(
      {
        loopId: "loop_abc",
        command: "EXECUTE",
        repo: "closedloop-ai/symphony-alpha",
        branch: "symphony/pln-853",
        harness: LoopHarness.Claude,
      },
      now
    );

    const run = envelope.runStarted();
    expect(run.event).toBe("run");
    expect(run.run_id).toBe("loop_abc");
    expect(run.run_id).not.toBe("unknown");
    expect(run.command).toBe("EXECUTE");
    expect(run.repo).toBe("closedloop-ai/symphony-alpha");
    expect(run.branch).toBe("symphony/pln-853");
    expect(run.harness).toBe(LoopHarness.Claude);
    expect(run.started_at).toBe("2026-06-10T00:00:00.000Z");

    const iteration = envelope.runFinished({
      exitCode: 0,
      status: "completed",
    });
    expect(iteration.event).toBe("iteration");
    expect(iteration.run_id).toBe("loop_abc");
    // A bare-prompt invocation produces exactly one iteration (GAP-002).
    expect(iteration.iteration).toBe(1);
    expect(iteration.started_at).toBe("2026-06-10T00:00:00.000Z");
    expect(iteration.ended_at).toBe("2026-06-10T00:00:05.000Z");
    expect(iteration.duration_s).toBe(5);
    expect(iteration.claude_exit_code).toBe(0);
    expect(iteration.status).toBe("completed");
  });

  it("omits optional identity fields rather than emitting null", () => {
    const now = makeClock();
    const envelope = createLoopRunEnvelope(
      { loopId: "loop_min", harness: LoopHarness.Codex },
      now
    );
    const run = envelope.runStarted();
    expect("command" in run).toBe(false);
    expect("repo" in run).toBe(false);
    expect("branch" in run).toBe(false);
    expect(run.harness).toBe(LoopHarness.Codex);
  });

  it("fails open to a zero-duration window when runStarted was skipped", () => {
    const now = makeClock();
    const envelope = createLoopRunEnvelope(
      { loopId: "loop_x", harness: LoopHarness.Claude },
      now
    );
    const iteration = envelope.runFinished({ status: "failed" });
    expect(iteration.duration_s).toBe(0);
    expect(iteration.started_at).toBe(iteration.ended_at);
    expect("claude_exit_code" in iteration).toBe(false);
  });
});
