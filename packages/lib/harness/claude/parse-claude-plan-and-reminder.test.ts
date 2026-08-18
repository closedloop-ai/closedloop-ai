import { describe, expect, it } from "vitest";
import { ASSISTANT_LINE, USER_LINE } from "./parse-claude.test-fixtures";
import { parseClaudeTranscript } from "./parse-claude-core";

// FEA-3553: Claude implementation plans were silently dropped. These pin both
// extraction sources plus the negative case.
describe("parseClaudeTranscript plan extraction (FEA-3553)", () => {
  it("captures a plan from ExitPlanMode tool input", async () => {
    const plan =
      "# Implementation Plan\n\nPhase 1 — scaffold\nPhase 2 — wire it up\nPhase 3 — test";
    const session = await parseClaudeTranscript(
      [USER_LINE, exitPlanModeLine(plan, "2026-07-09T12:00:05.000Z")],
      { sessionId: "s" }
    );

    expect(session?.plans).toHaveLength(1);
    expect(session?.plans?.[0]).toEqual({
      source: "claude-exit-plan-mode",
      content: plan,
      timestamp: "2026-07-09T12:00:05.000Z",
    });
  });

  it("captures a plan the model presented inline as assistant prose", async () => {
    const prose = [
      "I loaded ExitPlanMode but I'm not actually in a plan-mode session, so",
      "I'll present the plan inline.",
      "",
      "## Implementation Plan",
      "",
      "Phase 1 — audit the parser",
      "Phase 2 — add the extraction path",
      "Phase 3 — cover it with tests",
    ].join("\n");
    const session = await parseClaudeTranscript(
      [USER_LINE, assistantTextLine(prose, "2026-07-09T12:00:06.000Z")],
      { sessionId: "s" }
    );

    expect(session?.plans).toHaveLength(1);
    expect(session?.plans?.[0].source).toBe("claude-inline-plan");
    expect(session?.plans?.[0].content).toContain("Phase 1 — audit the parser");
    expect(session?.plans?.[0].timestamp).toBe("2026-07-09T12:00:06.000Z");
  });

  it("does NOT mislabel ordinary prose as a plan (negative case)", async () => {
    const prose = [
      "Sure — that plan sounds reasonable to me. In Phase 1 of the rollout the",
      "team already shipped the login flow, so we can build on it. Let me know",
      "if you want me to start.",
    ].join("\n");
    const session = await parseClaudeTranscript(
      [USER_LINE, assistantTextLine(prose, "2026-07-09T12:00:07.000Z")],
      { sessionId: "s" }
    );

    expect(session?.plans ?? []).toEqual([]);
  });

  it("dedups a plan captured from both ExitPlanMode and an inline echo", async () => {
    const plan =
      "## Implementation Plan\n\nPhase 1 — do the thing\nPhase 2 — verify the thing";
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        exitPlanModeLine(plan, "2026-07-09T12:00:08.000Z"),
        assistantTextLine(plan, "2026-07-09T12:00:09.000Z"),
      ],
      { sessionId: "s" }
    );

    expect(session?.plans).toHaveLength(1);
    expect(session?.plans?.[0].source).toBe("claude-exit-plan-mode");
  });

  it("defaults plans to empty when the session has none", async () => {
    const session = await parseClaudeTranscript([USER_LINE, ASSISTANT_LINE], {
      sessionId: "s",
    });
    expect(session?.plans ?? []).toEqual([]);
  });
});

describe("parseClaudeTranscript system-reminder exclusion (FEA-2927)", () => {
  it("excludes a pure system-reminder entry from human messages", async () => {
    const sysReminderLine = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:00.000Z",
      cwd: "/home/me/myproject",
      message: {
        role: "user",
        content:
          "<system-reminder>\nThe task tools haven't been used recently.\n</system-reminder>",
      },
    });
    const session = await parseClaudeTranscript(
      [sysReminderLine, ASSISTANT_LINE],
      { sessionId: "s" }
    );
    expect(session).not.toBeNull();
    expect(session?.userMessages).toBe(0);
    expect(session?.messages.filter((m) => m.role === "human")).toHaveLength(0);
  });

  it("keeps a mixed entry (human text + system-reminder) as human", async () => {
    const mixedLine = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:00.000Z",
      cwd: "/home/me/myproject",
      message: {
        role: "user",
        content:
          "please fix the bug\n<system-reminder>\nSome injected context.\n</system-reminder>",
      },
    });
    const session = await parseClaudeTranscript([mixedLine, ASSISTANT_LINE], {
      sessionId: "s",
    });
    expect(session).not.toBeNull();
    expect(session?.userMessages).toBe(1);
    expect(session?.messages.filter((m) => m.role === "human")).toHaveLength(1);
  });

  it("excludes multiple multiline system-reminder blocks", async () => {
    const multiBlockLine = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:00.000Z",
      cwd: "/home/me/myproject",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>\nMCP server instructions block 1.\nWith multiple lines.\n</system-reminder>\n\n<system-reminder>\nAnother block of injected context.\n</system-reminder>",
          },
        ],
      },
    });
    const session = await parseClaudeTranscript(
      [multiBlockLine, ASSISTANT_LINE],
      { sessionId: "s" }
    );
    expect(session).not.toBeNull();
    expect(session?.userMessages).toBe(0);
    expect(session?.messages.filter((m) => m.role === "human")).toHaveLength(0);
  });

  it("does NOT classify empty input as a system-reminder", async () => {
    const emptyLine = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:00.000Z",
      cwd: "/home/me/myproject",
      message: { role: "user", content: "   " },
    });
    const session = await parseClaudeTranscript([emptyLine, ASSISTANT_LINE], {
      sessionId: "s",
    });
    expect(session).not.toBeNull();
    expect(session?.userMessages).toBe(1);
  });
});

function exitPlanModeLine(plan: string, timestamp: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    message: {
      role: "assistant",
      model: "claude-opus-4",
      content: [
        {
          type: "tool_use",
          id: "toolu_plan1",
          name: "ExitPlanMode",
          input: { plan },
        },
      ],
    },
  });
}

function assistantTextLine(text: string, timestamp: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    message: {
      role: "assistant",
      model: "claude-opus-4",
      content: [{ type: "text", text }],
    },
  });
}
