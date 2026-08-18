import { describe, expect, it } from "vitest";
import { parseClaudeTranscript } from "./parse-claude-core";

const USER_LINE = JSON.stringify({
  type: "user",
  timestamp: "2026-07-09T12:00:00.000Z",
  cwd: "/home/me/myproject",
  message: { role: "user", content: "hello" },
});

describe("parseClaudeTranscript invocation evidence (FEA-3294)", () => {
  it("preserves command metadata and its embedded definition snapshot", async () => {
    const command = JSON.stringify({
      type: "user",
      uuid: "command-turn-uuid",
      promptId: "prompt-stable-1",
      timestamp: "2026-07-09T12:00:02.000Z",
      message: {
        role: "user",
        content:
          "<command-message>deploy</command-message>\n<command-name>/deploy</command-name>\n<command-args>prod</command-args>",
      },
    });
    const expansion = JSON.stringify({
      type: "user",
      uuid: "command-expansion-uuid",
      promptId: "prompt-stable-1",
      isMeta: true,
      timestamp: "2026-07-09T12:00:02.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "Base directory for this skill: /tmp/commands/deploy",
              "",
              "# Deploy",
              "Ship it safely.",
              "",
              "ARGUMENTS: prod",
            ].join("\n"),
          },
        ],
      },
    });

    const session = await parseClaudeTranscript(
      [USER_LINE, command, expansion],
      { sessionId: "command-session" }
    );

    expect(session?.slashCommands).toEqual([
      {
        name: "/deploy",
        timestamp: "2026-07-09T12:00:02.000Z",
        userTurnId: "prompt-stable-1",
        definitionSnapshot: {
          kind: "command",
          rawName: "deploy",
          normalizedName: "/deploy",
          content: "# Deploy\nShip it safely.",
          capturedAt: "2026-07-09T12:00:02.000Z",
        },
      },
    ]);
  });

  it("uses the Claude entry uuid when a slash-command prompt id is absent", async () => {
    const command = JSON.stringify({
      type: "user",
      uuid: "command-turn-uuid-only",
      timestamp: "2026-07-09T12:00:02.000Z",
      message: {
        role: "user",
        content:
          "<command-message>review</command-message>\n<command-name>/review</command-name>",
      },
    });

    const session = await parseClaudeTranscript([USER_LINE, command], {
      sessionId: "command-uuid-session",
    });

    expect(session?.slashCommands).toEqual([
      {
        name: "/review",
        timestamp: "2026-07-09T12:00:02.000Z",
        userTurnId: "command-turn-uuid-only",
      },
    ]);
  });

  it("preserves Claude tool_use_id and exact Skill snapshot linkage", async () => {
    const skillTool = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:03.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [
          {
            type: "tool_use",
            id: "toolu_skill_1",
            name: "Skill",
            input: { skill: "review" },
          },
        ],
      },
    });
    const expansion = JSON.stringify({
      type: "user",
      uuid: "skill-expansion-uuid",
      isMeta: true,
      sourceToolUseID: "toolu_skill_1",
      timestamp: "2026-07-09T12:00:03.100Z",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "Base directory for this skill: /tmp/skills/review\n\n# Review\nCheck the diff.",
          },
        ],
      },
    });

    const session = await parseClaudeTranscript(
      [USER_LINE, skillTool, expansion],
      { sessionId: "skill-session" }
    );

    expect(session?.toolUses[0]).toMatchObject({
      id: "toolu_skill_1",
      providerToolUseId: "toolu_skill_1",
      skillName: "review",
      definitionSnapshot: {
        kind: "skill",
        rawName: "review",
        normalizedName: "review",
        content: "# Review\nCheck the diff.",
      },
    });
    expect(session?.skills).toEqual([
      expect.objectContaining({
        name: "review",
        providerToolUseId: "toolu_skill_1",
        definitionSnapshot: expect.objectContaining({ kind: "skill" }),
      }),
    ]);
  });

  it("accepts only a causally-linked markdown-agent definition expansion", async () => {
    const agentTool = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:04.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [
          {
            type: "tool_use",
            id: "toolu_agent_1",
            name: "Agent",
            input: { subagent_type: "code-reviewer", prompt: "Review it" },
          },
        ],
      },
    });
    const unrelatedMeta = JSON.stringify({
      type: "user",
      uuid: "unrelated-meta",
      isMeta: true,
      timestamp: "2026-07-09T12:00:04.050Z",
      message: { role: "user", content: "ordinary injected metadata" },
    });
    const agentExpansion = JSON.stringify({
      type: "user",
      uuid: "agent-expansion",
      isMeta: true,
      sourceToolUseID: "toolu_agent_1",
      timestamp: "2026-07-09T12:00:04.100Z",
      message: {
        role: "user",
        content:
          "Base directory for this agent: /tmp/agents/code-reviewer\n\n# Reviewer\nReview carefully.",
      },
    });

    const session = await parseClaudeTranscript(
      [USER_LINE, agentTool, unrelatedMeta, agentExpansion],
      { sessionId: "agent-session" }
    );

    expect(session?.toolUses[0].definitionSnapshot).toEqual({
      kind: "subagent",
      rawName: "code-reviewer",
      normalizedName: "code-reviewer",
      content: "# Reviewer\nReview carefully.",
      capturedAt: "2026-07-09T12:00:04.100Z",
    });
  });

  it("uses Claude agentId as stable child identity across sidechain records", async () => {
    const firstTool = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:05.000Z",
      uuid: "sidechain-record-1",
      parentUuid: null,
      sessionId: "parent-session",
      agentId: "ad00546980b4b4701",
      isSidechain: true,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_child_1",
            name: "Read",
            input: { file_path: "one.ts" },
          },
        ],
      },
    });
    const namedTool = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:06.000Z",
      uuid: "sidechain-record-2",
      parentUuid: "sidechain-record-1",
      sessionId: "parent-session",
      agentId: "ad00546980b4b4701",
      attributionAgent: "code-review:code-review-worker",
      isSidechain: true,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_child_2",
            name: "Bash",
            input: { command: "git diff --check" },
          },
        ],
      },
    });

    const session = await parseClaudeTranscript(
      [USER_LINE, firstTool, namedTool],
      { sessionId: "parent-session" }
    );

    expect(session?.subagents).toHaveLength(1);
    expect(session?.subagents?.[0]).toMatchObject({
      id: "agent-ad00546980b4b4701",
      parentId: null,
      nativeSubagentId: "ad00546980b4b4701",
      name: "code-review:code-review-worker",
      rawName: "code-review:code-review-worker",
      normalizedName: "code-review:code-review-worker",
    });
    expect(
      session?.subagents?.[0]?.toolUses?.map((toolUse) => toolUse.id)
    ).toEqual(["toolu_child_1", "toolu_child_2"]);
    expect(session?.toolUses.map((toolUse) => toolUse.subagentId)).toEqual([
      "agent-ad00546980b4b4701",
      "agent-ad00546980b4b4701",
    ]);
  });
});
