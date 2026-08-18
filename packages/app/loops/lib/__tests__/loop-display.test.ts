import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import { describe, expect, it } from "vitest";
import {
  deriveIsLocal,
  getCommandLabels,
  getLoopBreadcrumbLabel,
  shortLoopId,
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

describe("shortLoopId", () => {
  it("returns the leading id slice for disambiguation", () => {
    expect(shortLoopId("loop_abcdef123456")).toBe("loop_abc");
  });
});

describe("getLoopBreadcrumbLabel", () => {
  const loop = { command: LoopCommand.Execute, id: "loop_abcdef123456" };

  it("leads with the command noun then the artifact title when present", () => {
    expect(getLoopBreadcrumbLabel(loop, "FEA-3979: Fix breadcrumb")).toBe(
      "Code: FEA-3979: Fix breadcrumb"
    );
  });

  it("trims the artifact title", () => {
    expect(getLoopBreadcrumbLabel(loop, "  Padded title  ")).toBe(
      "Code: Padded title"
    );
  });

  it("appends a short id to the bare noun when there is no artifact title", () => {
    expect(getLoopBreadcrumbLabel(loop, null)).toBe("Code loop_abc");
    expect(getLoopBreadcrumbLabel(loop, undefined)).toBe("Code loop_abc");
    expect(getLoopBreadcrumbLabel(loop, "   ")).toBe("Code loop_abc");
  });

  it("names a manual loop with the Manual noun, not the raw MANUAL command", () => {
    const manual = { command: LoopCommand.Manual, id: "loop_abcdef123456" };
    expect(getLoopBreadcrumbLabel(manual)).toBe("Manual loop_abc");
  });

  it("falls back to a short id when the command has no label", () => {
    const unlabeled = {
      command: "  " as LoopCommand,
      id: "loop_abcdef123456",
    };
    expect(getLoopBreadcrumbLabel(unlabeled)).toBe("Loop loop_abc");
  });
});
