/**
 * @file parse-claude-definitions.test.ts
 * @description The definition-snapshot lane: capturing the exact prompt text a
 * skill, sub-agent, or slash command was invoked with.
 *
 * Written against mutation-testing survivors. This module had the most
 * NO-COVERAGE mutants of any in the parser — whole branches never executed, not
 * merely surviving — because the existing evidence suite covers the happy path
 * for a skill and little else. The refusals matter more than the happy path
 * here: the base-directory wrapper is the ONLY proof that a chunk of meta text
 * is definition content rather than ordinary injected context, so every branch
 * that declines to attach is protecting a snapshot from being fabricated out of
 * an unrelated reminder.
 */
import { describe, expect, it } from "vitest";
import { parseClaudeTranscript } from "./parse-claude-core";

const TS = "2026-07-09T12:00:01.000Z";

const USER_LINE = JSON.stringify({
  type: "user",
  timestamp: "2026-07-09T12:00:00.000Z",
  cwd: "/workspace/project",
  message: { role: "user", content: "go" },
});

const USAGE = { input_tokens: 10, output_tokens: 5 };

/** The wrapper the harness puts around real definition content. */
function wrapped(kind: "skill" | "agent" | "command", body: string): string {
  return `Base directory for this ${kind}: /some/dir\n\n${body}`;
}

/** An assistant turn making one tool call. */
function toolCall(block: Record<string, unknown>, timestamp = TS): string {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    message: {
      role: "assistant",
      model: "claude-opus-4",
      content: [block],
      usage: USAGE,
    },
  });
}

/** The `isMeta` record that carries a definition body back. */
function metaDefinition(
  fields: Record<string, unknown>,
  text: string,
  timestamp = "2026-07-09T12:00:02.000Z"
): string {
  return JSON.stringify({
    type: "user",
    timestamp,
    isMeta: true,
    ...fields,
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

describe("a definition attaches to the tool call that triggered it", () => {
  it("attaches a Skill definition to the Skill tool use", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        toolCall({
          type: "tool_use",
          id: "toolu_skill",
          name: "Skill",
          input: { skill: "code-review" },
        }),
        metaDefinition(
          { sourceToolUseID: "toolu_skill" },
          wrapped("skill", "Review the diff carefully.")
        ),
      ],
      { sessionId: "def-skill" }
    );

    const snapshot = session?.toolUses[0]?.definitionSnapshot;
    expect(snapshot).toMatchObject({
      kind: "skill",
      rawName: "code-review",
      normalizedName: "code-review",
      content: "Review the diff carefully.",
    });
    // The skills projection carries it through.
    expect(session?.skills[0]?.definitionSnapshot).toMatchObject({
      kind: "skill",
    });
  });

  it("attaches a sub-agent definition and mirrors it onto the spawned agent row", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        toolCall({
          type: "tool_use",
          id: "toolu_agent",
          name: "Agent",
          input: { subagent_type: "code-reviewer", prompt: "review" },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-07-09T12:00:03.000Z",
          agentId: "ad00546980b4b4701",
          isSidechain: true,
          attributionAgent: "code-reviewer",
          message: {
            role: "assistant",
            model: "claude-opus-4",
            content: [
              { type: "tool_use", id: "toolu_child", name: "Read", input: {} },
            ],
            usage: USAGE,
          },
        }),
        metaDefinition(
          { sourceToolUseID: "toolu_agent" },
          wrapped("agent", "You are a reviewer.")
        ),
      ],
      { sessionId: "def-agent" }
    );

    const call = session?.toolUses.find((t) => t.id === "toolu_agent");
    expect(call?.definitionSnapshot).toMatchObject({
      kind: "subagent",
      rawName: "code-reviewer",
      content: "You are a reviewer.",
    });
    // The agent this call spawned carries the same definition, matched on type.
    expect(session?.subagents?.[0]?.definitionSnapshot).toMatchObject({
      kind: "subagent",
      rawName: "code-reviewer",
    });
  });

  it("accepts `agent_type` as well as `subagent_type`", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        toolCall({
          type: "tool_use",
          id: "toolu_agent",
          name: "Task",
          input: { agent_type: "explorer", prompt: "look" },
        }),
        metaDefinition(
          { sourceToolUseID: "toolu_agent" },
          wrapped("agent", "Explore.")
        ),
      ],
      { sessionId: "def-agent-type" }
    );

    expect(session?.toolUses[0]?.definitionSnapshot).toMatchObject({
      kind: "subagent",
      rawName: "explorer",
    });
  });
});

describe("a definition attaches to the slash command that invoked it", () => {
  it("joins on the invoking turn id and strips the leading slash", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        JSON.stringify({
          type: "user",
          timestamp: TS,
          promptId: "prompt-1",
          message: {
            role: "user",
            content: "<command-name>/design-review</command-name>",
          },
        }),
        metaDefinition(
          { promptId: "prompt-1" },
          wrapped("command", "Run the design review.")
        ),
      ],
      { sessionId: "def-command" }
    );

    expect(session?.slashCommands[0]?.definitionSnapshot).toMatchObject({
      kind: "command",
      rawName: "design-review",
      normalizedName: "/design-review",
      content: "Run the design review.",
    });
  });

  it("attaches nothing when no command was recorded for that turn", async () => {
    // The `!command` refusal. A meta record can name a promptId the session
    // never saw a command on — inventing a snapshot for it would attribute
    // prompt text to a command that was never invoked.
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        metaDefinition(
          { promptId: "never-seen" },
          wrapped("command", "orphan body")
        ),
      ],
      { sessionId: "def-command-orphan" }
    );

    expect(session?.slashCommands).toEqual([]);
  });
});

describe("the lane refuses anything it cannot prove is a definition", () => {
  it("ignores a meta record with no base-directory wrapper", async () => {
    // The wrapper is the ONLY proof. Ordinary `isMeta` text — a system reminder,
    // injected context — must not become a definition.
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        toolCall({
          type: "tool_use",
          id: "toolu_skill",
          name: "Skill",
          input: { skill: "code-review" },
        }),
        metaDefinition(
          { sourceToolUseID: "toolu_skill" },
          "Just some injected context, no wrapper."
        ),
      ],
      { sessionId: "def-no-wrapper" }
    );

    expect(session?.toolUses[0]?.definitionSnapshot).toBeUndefined();
  });

  it("ignores a wrapped body on a record that is not isMeta", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        toolCall({
          type: "tool_use",
          id: "toolu_skill",
          name: "Skill",
          input: { skill: "code-review" },
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-07-09T12:00:02.000Z",
          sourceToolUseID: "toolu_skill",
          message: {
            role: "user",
            content: [{ type: "text", text: wrapped("skill", "body") }],
          },
        }),
      ],
      { sessionId: "def-not-meta" }
    );

    expect(session?.toolUses[0]?.definitionSnapshot).toBeUndefined();
  });

  it("attaches nothing when the referenced tool use does not exist", async () => {
    // The `!toolUse` refusal: a `sourceToolUseID` pointing at a call this
    // transcript never carried.
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        toolCall({
          type: "tool_use",
          id: "toolu_real",
          name: "Skill",
          input: { skill: "code-review" },
        }),
        metaDefinition(
          { sourceToolUseID: "toolu_missing" },
          wrapped("skill", "body")
        ),
      ],
      { sessionId: "def-missing-tool" }
    );

    expect(session?.toolUses[0]?.definitionSnapshot).toBeUndefined();
  });

  it("attaches nothing for a non-delegation tool that is not a Skill", async () => {
    // A `Read` is neither a skill nor a delegation, so there is no component
    // whose definition this could be.
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        toolCall({
          type: "tool_use",
          id: "toolu_read",
          name: "Read",
          input: { file_path: "a.ts" },
        }),
        metaDefinition(
          { sourceToolUseID: "toolu_read" },
          wrapped("skill", "body")
        ),
      ],
      { sessionId: "def-wrong-tool" }
    );

    expect(session?.toolUses[0]?.definitionSnapshot).toBeUndefined();
  });

  it("attaches nothing to a delegation whose input names no agent type", async () => {
    // The `!rawName` refusal — a delegation call with neither `subagent_type`
    // nor `agent_type` has no name to record the definition under.
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        toolCall({
          type: "tool_use",
          id: "toolu_agent",
          name: "Agent",
          input: { prompt: "do it" },
        }),
        metaDefinition(
          { sourceToolUseID: "toolu_agent" },
          wrapped("agent", "body")
        ),
      ],
      { sessionId: "def-no-rawname" }
    );

    expect(session?.toolUses[0]?.definitionSnapshot).toBeUndefined();
  });
});

describe("the captured body is bounded and trimmed of harness scaffolding", () => {
  it("drops an ARGUMENTS trailer from the captured content", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        toolCall({
          type: "tool_use",
          id: "toolu_skill",
          name: "Skill",
          input: { skill: "code-review" },
        }),
        metaDefinition(
          { sourceToolUseID: "toolu_skill" },
          `${wrapped("skill", "The real body.")}\n\nARGUMENTS:\n--verbose`
        ),
      ],
      { sessionId: "def-arguments" }
    );

    expect(session?.toolUses[0]?.definitionSnapshot?.content).toBe(
      "The real body."
    );
  });

  it("captures nothing when the body exceeds the byte ceiling", async () => {
    // Oversized definition content is dropped rather than truncated: a partial
    // prompt shown as the definition would misrepresent what actually ran.
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        toolCall({
          type: "tool_use",
          id: "toolu_skill",
          name: "Skill",
          input: { skill: "code-review" },
        }),
        metaDefinition(
          { sourceToolUseID: "toolu_skill" },
          wrapped("skill", "x".repeat(200_000))
        ),
      ],
      { sessionId: "def-oversized" }
    );

    expect(session?.toolUses[0]?.definitionSnapshot).toBeUndefined();
  });

  it("assembles the body from a plain string content as well as blocks", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        toolCall({
          type: "tool_use",
          id: "toolu_skill",
          name: "Skill",
          input: { skill: "code-review" },
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-07-09T12:00:02.000Z",
          isMeta: true,
          sourceToolUseID: "toolu_skill",
          message: { role: "user", content: wrapped("skill", "String body.") },
        }),
      ],
      { sessionId: "def-string-content" }
    );

    expect(session?.toolUses[0]?.definitionSnapshot?.content).toBe(
      "String body."
    );
  });
});
