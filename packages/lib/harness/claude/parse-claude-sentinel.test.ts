import { describe, expect, it } from "vitest";
import { ASSISTANT_LINE } from "./parse-claude.test-fixtures";
import { parseClaudeTranscript } from "./parse-claude-core";

describe("parseClaudeTranscript — autonomous-loop-dynamic sentinel (FEA-3595)", () => {
  it("excludes a single sentinel expansion from human messages", async () => {
    const lines = [
      JSON.stringify({
        type: "user",
        timestamp: "2024-03-09T16:00:00.000Z",
        cwd: "/home/dev/proj",
        message: { role: "user", content: "Start the build." },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2024-03-09T16:00:01.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_wakeup_sentinel",
              name: "ScheduleWakeup",
              input: { prompt: "<<autonomous-loop-dynamic>>" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2024-03-09T16:05:00.000Z",
        message: {
          role: "user",
          content:
            "This is the resolved autonomous loop prompt text that differs from the sentinel.",
        },
      }),
      ASSISTANT_LINE,
    ];

    const session = await parseClaudeTranscript(lines, {
      sessionId: "sentinel-single",
    });
    expect(session).not.toBeNull();
    expect(session?.userMessages).toBe(1);
    const humanMessages = session!.messages.filter((m) => m.role === "human");
    expect(humanMessages).toHaveLength(1);
    expect(humanMessages[0]?.text).toBe("Start the build.");
  });

  it("excludes multiple sentinel expansions across consecutive firings", async () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        timestamp: "2024-03-09T16:00:00.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_wakeup_s1",
              name: "ScheduleWakeup",
              input: { prompt: "<<autonomous-loop-dynamic>>" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2024-03-09T16:05:00.000Z",
        message: {
          role: "user",
          content: "First resolved loop iteration text.",
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2024-03-09T16:05:01.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_wakeup_s2",
              name: "ScheduleWakeup",
              input: { prompt: "<<autonomous-loop-dynamic>>" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2024-03-09T16:10:00.000Z",
        message: {
          role: "user",
          content: "Second resolved loop iteration — different text.",
        },
      }),
      ASSISTANT_LINE,
    ];

    const session = await parseClaudeTranscript(lines, {
      sessionId: "sentinel-multi",
    });
    expect(session).not.toBeNull();
    expect(session?.userMessages).toBe(0);
    expect(session!.messages.filter((m) => m.role === "human")).toHaveLength(0);
  });

  it("counts a genuine prompt after the sentinel count is exhausted", async () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        timestamp: "2024-03-09T16:00:00.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_wakeup_e1",
              name: "ScheduleWakeup",
              input: { prompt: "<<autonomous-loop-dynamic>>" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2024-03-09T16:05:00.000Z",
        message: {
          role: "user",
          content: "Resolved sentinel expansion — consumed.",
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2024-03-09T16:06:00.000Z",
        message: {
          role: "user",
          content: "Genuine typed prompt after sentinel is exhausted.",
        },
      }),
      ASSISTANT_LINE,
    ];

    const session = await parseClaudeTranscript(lines, {
      sessionId: "sentinel-exhaust",
    });
    expect(session).not.toBeNull();
    expect(session?.userMessages).toBe(1);
    const humanMessages = session!.messages.filter((m) => m.role === "human");
    expect(humanMessages).toHaveLength(1);
    expect(humanMessages[0]?.text).toBe(
      "Genuine typed prompt after sentinel is exhausted."
    );
  });

  it("lets a slash-command expansion consume its OWN recorded prompt while a sentinel is also pending", async () => {
    // FEA-3595 review: the sentinel fallback must run AFTER both exact forms.
    // With a sentinel AND `/foo bar` pending, the expanded `/foo bar` firing
    // fails the RAW text match — if the fallback ran first it would eat the
    // sentinel, leaving the real sentinel firing to be counted as a human turn
    // and reproducing the very bug this fallback exists to fix.
    const lines = [
      JSON.stringify({
        type: "assistant",
        timestamp: "2024-03-09T16:00:00.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_wakeup_sentinel_coexist",
              name: "ScheduleWakeup",
              input: { prompt: "<<autonomous-loop-dynamic>>" },
            },
            {
              type: "tool_use",
              id: "toolu_wakeup_slash_coexist",
              name: "ScheduleWakeup",
              input: { prompt: "/foo bar" },
            },
          ],
        },
      }),
      // The slash-command wake-up fires FIRST, as expanded XML.
      JSON.stringify({
        type: "user",
        timestamp: "2024-03-09T16:05:00.000Z",
        message: {
          role: "user",
          content:
            "<command-name>/foo</command-name>\n<command-args>bar</command-args>",
        },
      }),
      // Then the sentinel fires, resolved to unrelated text.
      JSON.stringify({
        type: "user",
        timestamp: "2024-03-09T16:10:00.000Z",
        message: {
          role: "user",
          content: "Resolved autonomous loop instructions, nothing like above.",
        },
      }),
      ASSISTANT_LINE,
    ];

    const session = await parseClaudeTranscript(lines, {
      sessionId: "sentinel-slash-coexist",
    });
    expect(session).not.toBeNull();
    expect(session?.userMessages).toBe(0);
    expect(session!.messages.filter((m) => m.role === "human")).toHaveLength(0);
  });

  it("does not suppress a genuine prompt when the ScheduleWakeup call failed", async () => {
    // FEA-3595 review: the sentinel is registered from the tool USE, not from a
    // confirmed firing. A call that errored schedules nothing and never
    // re-injects, so it must not consume the next genuine human prompt.
    const lines = [
      JSON.stringify({
        type: "assistant",
        timestamp: "2024-03-09T16:00:00.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_wakeup_failed",
              name: "ScheduleWakeup",
              input: { prompt: "<<autonomous-loop-dynamic>>" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2024-03-09T16:00:01.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_wakeup_failed",
              is_error: true,
              content: "Error: delaySeconds must be provided unless stop=true",
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2024-03-09T16:06:00.000Z",
        message: {
          role: "user",
          content: "A real question I typed after the wake-up call failed.",
        },
      }),
      ASSISTANT_LINE,
    ];

    const session = await parseClaudeTranscript(lines, {
      sessionId: "sentinel-failed-call",
    });
    expect(session).not.toBeNull();
    expect(session?.userMessages).toBe(1);
    const humanMessages = session!.messages.filter((m) => m.role === "human");
    expect(humanMessages).toHaveLength(1);
    expect(humanMessages[0]?.text).toBe(
      "A real question I typed after the wake-up call failed."
    );
  });

  it("still suppresses the firing when only one of two ScheduleWakeup calls failed", async () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        timestamp: "2024-03-09T16:00:00.000Z",
        message: {
          model: "claude-opus-4-5",
          content: [
            {
              type: "tool_use",
              id: "toolu_wakeup_bad",
              name: "ScheduleWakeup",
              input: { prompt: "<<autonomous-loop-dynamic>>" },
            },
            {
              type: "tool_use",
              id: "toolu_wakeup_good",
              name: "ScheduleWakeup",
              input: { prompt: "<<autonomous-loop-dynamic>>" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2024-03-09T16:00:01.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_wakeup_bad",
              is_error: true,
              content: "Error: invalid delaySeconds",
            },
          ],
        },
      }),
      // Exactly ONE firing is expected — the surviving registration covers it.
      JSON.stringify({
        type: "user",
        timestamp: "2024-03-09T16:05:00.000Z",
        message: {
          role: "user",
          content: "Resolved loop text for the good call.",
        },
      }),
      // A second unmatched prompt has no eligible registration left.
      JSON.stringify({
        type: "user",
        timestamp: "2024-03-09T16:06:00.000Z",
        message: { role: "user", content: "Genuine follow-up I typed myself." },
      }),
      ASSISTANT_LINE,
    ];

    const session = await parseClaudeTranscript(lines, {
      sessionId: "sentinel-partial-failure",
    });
    expect(session).not.toBeNull();
    expect(session?.userMessages).toBe(1);
    const humanMessages = session!.messages.filter((m) => m.role === "human");
    expect(humanMessages).toHaveLength(1);
    expect(humanMessages[0]?.text).toBe("Genuine follow-up I typed myself.");
  });
});
