import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import { describe, expect, it } from "vitest";
import {
  deriveIsLocal,
  getCommandLabels,
  terminalLabel,
} from "../loop-display";

describe("getCommandLabels", () => {
  it("returns the configured labels for a known command", () => {
    expect(getCommandLabels(LoopCommand.Plan)).toEqual({
      noun: "Plan",
      progress: "Plan generating",
      completed: "Plan generated",
      failed: "Plan failed",
    });
  });

  it("falls back to the raw command for unknown values (forward-compat)", () => {
    const unknown = "FUTURE_COMMAND" as LoopCommand;
    expect(getCommandLabels(unknown)).toEqual({
      noun: "FUTURE_COMMAND",
      progress: "FUTURE_COMMAND",
      completed: "FUTURE_COMMAND",
      failed: "FUTURE_COMMAND failed",
    });
  });
});

describe("terminalLabel", () => {
  it("distinguishes cancelled, timed-out, and failed", () => {
    expect(terminalLabel(LoopStatus.Cancelled, LoopCommand.Plan)).toBe(
      "Plan cancelled"
    );
    expect(terminalLabel(LoopStatus.TimedOut, LoopCommand.Plan)).toBe(
      "Plan timed out"
    );
    expect(terminalLabel(LoopStatus.Failed, LoopCommand.Plan)).toBe(
      "Plan failed"
    );
  });
});

describe("deriveIsLocal", () => {
  it("is true when a compute target is present", () => {
    expect(deriveIsLocal({ computeTarget: { id: "ct_1" } })).toBe(true);
  });

  it("is false when the compute target is null or absent", () => {
    expect(deriveIsLocal({ computeTarget: null })).toBe(false);
    expect(deriveIsLocal({})).toBe(false);
  });
});
