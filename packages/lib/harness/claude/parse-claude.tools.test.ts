/**
 * ISS-5292 Packet C: branch coverage for `parse-claude.ts` — tool-use and
 * tool-result handling.
 *
 * Sibling of `parse-claude.coverage.test.ts`, which owns the entry-, message-,
 * and session-level branches. This file owns everything that flows through
 * `TOOL_USE_HANDLERS` and `applyToolResult`: per-tool input validation arms, the
 * Read→Write diff baseline cache, the delegation sink, and `is_error` tracking.
 * Every test asserts an observable behavioral outcome — no source-text scans.
 */
import { describe, expect, it } from "vitest";
import {
  assistantLine,
  BASE_USAGE,
  userLine,
} from "./parse-claude.test-fixtures";
import { createSessionAccumulator } from "./parse-claude-accumulator";
import {
  parseClaudeTranscript,
  scanTranscriptLines,
} from "./parse-claude-core";

// ---------------------------------------------------------------------------
// Read tool result caching for Write diff (and partial Read skip)
// ---------------------------------------------------------------------------

describe("parseClaudeTranscript — Read result caching for Write diff", () => {
  it("uses cached Read content as diff baseline for a subsequent Write", async () => {
    // full Read (no offset/limit) → store in readContentByPath.
    const readLine = assistantLine({}, [
      {
        type: "tool_use",
        id: "toolu_read",
        name: "Read",
        input: { file_path: "/repo/src/auth.ts" },
      },
    ]);
    const readResult = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:02.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_read",
            // Stored after stripping "N\t" prefixes → "const a = 1;\nconst b = 2;"
            content: "1\tconst a = 1;\n2\tconst b = 2;",
          },
        ],
      },
    });
    const writeLine = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:03.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [
          {
            type: "tool_use",
            id: "toolu_write",
            name: "Write",
            input: {
              file_path: "/repo/src/auth.ts",
              content: "const a = 1;\nconst b = 2;\nconst c = 3;",
            },
          },
        ],
        usage: {
          input_tokens: 15,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });

    const session = await parseClaudeTranscript(
      [userLine(), readLine, readResult, writeLine],
      { sessionId: "read-write-diff" }
    );

    // Prior Read: 2 lines → Write adds 1 line (3 lines total).
    expect(session?.diffStats?.linesAdded).toBe(1);
    expect(session?.diffStats?.linesRemoved).toBe(0);
    expect(session?.diffStats?.filesChanged).toBe(1);
  });

  it("does not cache a partial Read (with offset) as a Write diff baseline", async () => {
    // isPartialRead = true → skip caching in readContentByPath.
    const partialReadLine = assistantLine({}, [
      {
        type: "tool_use",
        id: "toolu_partial",
        name: "Read",
        input: { file_path: "/repo/src/util.ts", offset: 10, limit: 50 },
      },
    ]);
    const partialResult = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:02.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_partial",
            content: "10\tsome line\n11\tanother line",
          },
        ],
      },
    });
    const writeLine = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:03.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [
          {
            type: "tool_use",
            id: "toolu_write2",
            name: "Write",
            input: {
              file_path: "/repo/src/util.ts",
              content: "complete\nnew\nfile",
            },
          },
        ],
        usage: {
          input_tokens: 15,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    });

    const session = await parseClaudeTranscript(
      [userLine(), partialReadLine, partialResult, writeLine],
      { sessionId: "partial-read-test" }
    );

    // No prior Read cached → fresh file: 3 lines = 3 added, 0 removed.
    expect(session?.diffStats?.linesAdded).toBe(3);
    expect(session?.diffStats?.linesRemoved).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// delegation kickoffs
// ---------------------------------------------------------------------------

describe("parseClaudeTranscript — delegation kickoffs", () => {
  it("collects delegation kickoffs onto the accumulator", async () => {
    // The desktop importer reads these back to reconcile each delegated agent
    // against its own transcript, so a kickoff that never lands here leaves that
    // agent permanently unattributed.
    const delegationLine = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [
          {
            type: "tool_use",
            id: "toolu_agent1",
            name: "Agent",
            input: {
              subagent_type: "code-reviewer",
              prompt: "Review the diff",
            },
          },
        ],
        usage: BASE_USAGE,
      },
    });
    const resultLine = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:09.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_agent1",
            content: [{ type: "text", text: "done" }],
          },
        ],
      },
      toolUseResult: { status: "completed", agentId: "child-abc123" },
    });

    const accumulator = createSessionAccumulator();
    await scanTranscriptLines(
      [userLine(), delegationLine, resultLine],
      accumulator
    );

    // Assert the CONTENT, not the count. A kickoff whose `agentId` is undefined
    // or whose `toolUseId` points at the wrong call is worthless to the desktop
    // reconciliation this test exists to protect, and a length check cannot tell
    // that apart from a correct one.
    const spawn = accumulator.delegations.find(
      (delegation) => delegation.toolUseId === "toolu_agent1"
    );
    expect(spawn).toBeDefined();
    expect(spawn?.type).toBe("code-reviewer");
    expect(spawn?.task).toBe("Review the diff");

    // The answering result names the child; the spawning call cannot. Both halves
    // have to land or the agent is never joined to its own transcript.
    const answered = accumulator.delegations.find(
      (delegation) => delegation.agentId === "child-abc123"
    );
    expect(answered).toBeDefined();
    expect(answered?.toolUseId).toBe("toolu_agent1");
  });

  it("parses the same delegation without a sink and still records the tool use", async () => {
    // Paired control: the one-shot form never exposes the kickoffs, and parsing
    // the same transcript through it must be unaffected by that.
    const delegationLine = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [
          {
            type: "tool_use",
            id: "toolu_agent2",
            name: "Agent",
            input: {
              subagent_type: "code-reviewer",
              prompt: "Review the diff",
            },
          },
        ],
        usage: BASE_USAGE,
      },
    });

    const session = await parseClaudeTranscript([userLine(), delegationLine], {
      sessionId: "delegation-no-sink",
    });

    expect(session?.toolUses.find((t) => t.name === "Agent")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// TOOL_USE_HANDLERS — false arms for Skill, ExitPlanMode, ScheduleWakeup
// ---------------------------------------------------------------------------

describe("parseClaudeTranscript — Skill tool without skill property", () => {
  it("skips skillName assignment when the input has no string skill field", async () => {
    // typeof inp.skill !== "string" → skip skillName
    const skillLine = assistantLine({}, [
      {
        type: "tool_use",
        id: "toolu_skill1",
        name: "Skill",
        input: { skill: 42 }, // number — not a string
      },
    ]);
    const session = await parseClaudeTranscript([userLine(), skillLine], {
      sessionId: "skill-no-string",
    });
    const tu = session?.toolUses.find((t) => t.name === "Skill");
    expect(tu).toBeDefined();
    expect(tu?.skillName).toBeUndefined();
  });

  it("records skillName when the input carries a string skill field", async () => {
    // Paired control: the true arm must produce skillName, so
    // the assertion above fails if the condition is negated.
    const skillLine = assistantLine({}, [
      {
        type: "tool_use",
        id: "toolu_skill2",
        name: "Skill",
        input: { skill: "design-review" },
      },
    ]);
    const session = await parseClaudeTranscript([userLine(), skillLine], {
      sessionId: "skill-string",
    });
    const tu = session?.toolUses.find((t) => t.name === "Skill");
    expect(tu?.skillName).toBe("design-review");
  });
});

describe("parseClaudeTranscript — ExitPlanMode without string plan input", () => {
  it("does not record a plan when the ExitPlanMode input lacks a string plan", async () => {
    // typeof inp.plan !== "string" → skip recordPlan
    const planModeToolLine = assistantLine({}, [
      {
        type: "tool_use",
        id: "toolu_plan",
        name: "ExitPlanMode",
        input: { plan: null }, // null — not a string
      },
    ]);
    const session = await parseClaudeTranscript(
      [userLine(), planModeToolLine],
      {
        sessionId: "exit-plan-no-string",
      }
    );
    expect(session?.plans).toHaveLength(0);
  });

  it("records a plan when the ExitPlanMode input carries a string plan", async () => {
    // Paired control for the true arm.
    const planModeToolLine = assistantLine({}, [
      {
        type: "tool_use",
        id: "toolu_plan2",
        name: "ExitPlanMode",
        input: { plan: "1. do the thing\n2. verify it" },
      },
    ]);
    const session = await parseClaudeTranscript(
      [userLine(), planModeToolLine],
      {
        sessionId: "exit-plan-string",
      }
    );
    expect(session?.plans).toHaveLength(1);
  });
});

describe("parseClaudeTranscript — ScheduleWakeup false arms", () => {
  it("skips when prompt is not a string", async () => {
    // typeof raw !== "string" → skip
    const wakeupLine = assistantLine({}, [
      {
        type: "tool_use",
        id: "toolu_wake1",
        name: "ScheduleWakeup",
        input: { prompt: 42 }, // not a string
      },
    ]);
    const session = await parseClaudeTranscript([userLine(), wakeupLine], {
      sessionId: "wakeup-no-string",
    });
    // No scheduled prompts — user message is not suppressed
    expect(session?.userMessages).toBe(1);
  });

  it("skips when prompt trims to empty", async () => {
    // prompt.length === 0 after trim → skip
    const wakeupLine = assistantLine({}, [
      {
        type: "tool_use",
        id: "toolu_wake2",
        name: "ScheduleWakeup",
        input: { prompt: "   " }, // whitespace only
      },
    ]);
    const session = await parseClaudeTranscript([userLine(), wakeupLine], {
      sessionId: "wakeup-empty-prompt",
    });
    expect(session?.userMessages).toBe(1);
  });

  it("registers a non-empty string prompt, suppressing its later re-injection", async () => {
    // Paired control for Branches 114[0] + 115[0]. The observable consequence of
    // registration is that the harness's later re-injection of the SAME text as a
    // `user` entry is not counted as a human turn. Both skip-cases above leave the
    // registry empty, so that re-injected turn WOULD count — which is exactly what
    // makes their `userMessages === 1` assertions non-vacuous.
    const wakeupLine = assistantLine({}, [
      {
        type: "tool_use",
        id: "toolu_wake3",
        name: "ScheduleWakeup",
        input: { prompt: "check the deploy" },
      },
    ]);
    const reinjectedLine = userLine(
      { timestamp: "2026-07-09T12:05:00.000Z" },
      "check the deploy"
    );

    const session = await parseClaudeTranscript(
      [userLine(), wakeupLine, reinjectedLine],
      { sessionId: "wakeup-real-prompt" }
    );

    expect(
      session?.toolUses.find((t) => t.name === "ScheduleWakeup")
    ).toBeDefined();
    // Only the genuine opening turn counts; the re-injection is suppressed.
    expect(session?.userMessages).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// applyToolResult — timestamp-less tool result
// ---------------------------------------------------------------------------

describe("parseClaudeTranscript — tool result with no timestamp", () => {
  it("skips resultTimestamp when the tool_result entry has no timestamp", async () => {
    // isoTs(entry.timestamp) → null → if (resultTs) is false → skip
    const toolUseLine = assistantLine({}, [
      {
        type: "tool_use",
        id: "toolu_notimestamp",
        name: "Bash",
        input: { command: "ls" },
      },
    ]);
    const resultNoTs = JSON.stringify({
      type: "user",
      // No timestamp field → isoTs(undefined) = null
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_notimestamp",
            content: "file.txt",
          },
        ],
      },
    });

    const session = await parseClaudeTranscript(
      [userLine(), toolUseLine, resultNoTs],
      { sessionId: "tool-result-no-ts" }
    );

    const tu = session?.toolUses.find((t) => t.id === "toolu_notimestamp");
    expect(tu).toBeDefined();
    // resultTimestamp was not set because entry had no timestamp
    expect(tu?.resultTimestamp).toBeUndefined();
  });

  it("stamps resultTimestamp when the tool_result entry carries one", async () => {
    // Paired control for the true arm.
    const toolUseLine = assistantLine({}, [
      {
        type: "tool_use",
        id: "toolu_withtimestamp",
        name: "Bash",
        input: { command: "ls" },
      },
    ]);
    const resultWithTs = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:04.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_withtimestamp",
            content: "file.txt",
          },
        ],
      },
    });

    const session = await parseClaudeTranscript(
      [userLine(), toolUseLine, resultWithTs],
      { sessionId: "tool-result-with-ts" }
    );

    const tu = session?.toolUses.find((t) => t.id === "toolu_withtimestamp");
    expect(tu?.resultTimestamp).toBe("2026-07-09T12:00:04.000Z");
  });
});

// ---------------------------------------------------------------------------
// Orphan tool_result with no toolUseResult
// ---------------------------------------------------------------------------

describe("parseClaudeTranscript — orphan tool_result without toolUseResult", () => {
  it("silently ignores an orphan tool_result that has no toolUseResult", async () => {
    // orphanDelegation is null because entry.toolUseResult is absent.
    // The tool_result references a tool_use that was never emitted (no match).
    const resultLine = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:02.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_orphan",
            content: "result text",
          },
        ],
      },
      // toolUseResult deliberately absent → delegationFromToolUseResult returns null
    });

    const session = await parseClaudeTranscript(
      [userLine(), assistantLine(), resultLine],
      { sessionId: "orphan-no-delegation" }
    );

    // No crash; the orphan tool_result is silently dropped.
    expect(session).not.toBeNull();
    expect(session?.toolUses).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// toolUseResult with is_error — Branches 160[0], 161[0/1], 162[0/1]
// ---------------------------------------------------------------------------

describe("parseClaudeTranscript — toolUseResult.is_error tracking", () => {
  it("records a tool result error with string content (Branches 160[0], 161[0])", async () => {
    // tur.is_error is truthy → enter error block.
    // typeof tur.content === "string" → slice it.
    const errorResultLine = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:02.000Z",
      message: { role: "user", content: [] },
      toolUseResult: {
        is_error: true,
        content: "Command failed: permission denied",
      },
    });

    const session = await parseClaudeTranscript(
      [userLine(), assistantLine(), errorResultLine],
      { sessionId: "tool-result-error-string" }
    );

    expect(session).not.toBeNull();
    expect(session?.toolResultErrors).toHaveLength(1);
    expect(session?.toolResultErrors[0]?.content).toContain(
      "permission denied"
    );
  });

  it("records no error when is_error is absent", async () => {
    // Paired control: same shape, is_error omitted → the error block is skipped.
    const okResultLine = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:02.000Z",
      message: { role: "user", content: [] },
      toolUseResult: { content: "Command succeeded" },
    });

    const session = await parseClaudeTranscript(
      [userLine(), assistantLine(), okResultLine],
      { sessionId: "tool-result-ok" }
    );

    expect(session?.toolResultErrors).toHaveLength(0);
  });

  it("serializes non-string content to JSON for error tracking (162[0])", async () => {
    // typeof tur.content !== "string" → JSON.stringify path.
    // tur.content is non-null → tur.content (not "").
    const errorResultLine = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:02.000Z",
      message: { role: "user", content: [] },
      toolUseResult: {
        is_error: true,
        content: { code: 500, message: "Internal error" },
      },
    });

    const session = await parseClaudeTranscript(
      [userLine(), assistantLine(), errorResultLine],
      { sessionId: "tool-result-error-object" }
    );

    expect(session?.toolResultErrors).toHaveLength(1);
    expect(session?.toolResultErrors[0]?.content).toContain("500");
  });

  it("serializes null content as an empty JSON string", async () => {
    // tur.content is null → ?? "" → JSON.stringify("") → '""'.
    const errorResultLine = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:02.000Z",
      message: { role: "user", content: [] },
      toolUseResult: {
        is_error: true,
        content: null,
      },
    });

    const session = await parseClaudeTranscript(
      [userLine(), assistantLine(), errorResultLine],
      { sessionId: "tool-result-error-null" }
    );

    expect(session?.toolResultErrors).toHaveLength(1);
    // `?? ""` supplies the empty string, which JSON.stringify renders as `""`.
    expect(session?.toolResultErrors[0]?.content).toBe('""');
  });
});
