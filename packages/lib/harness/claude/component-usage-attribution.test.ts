/**
 * ISS-7795: per-invocation token attribution for skills and commands.
 *
 * The expected counts here are written as literals chosen when the fixture was
 * written, NOT summed from the fixture by the test — the duplication is the
 * assertion. A test that re-derived them from the same records would agree with
 * any attribution the producer happened to make, including charging one skill
 * for another's turns.
 */
import { describe, expect, it } from "vitest";
import { parseClaudeTranscript } from "./parse-claude";

const SESSION_ID = "iss7795-session";

type UsageCounts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

function assistantTurn(options: {
  uuid: string;
  messageId: string;
  timestamp: string;
  model: string;
  counts: UsageCounts;
  attributionSkill?: string;
  toolUse?: { id: string; name: string; input: Record<string, unknown> };
}): string {
  const content: Record<string, unknown>[] = [{ type: "text", text: "work" }];
  if (options.toolUse) {
    content.push({
      type: "tool_use",
      id: options.toolUse.id,
      name: options.toolUse.name,
      input: options.toolUse.input,
    });
  }
  return JSON.stringify({
    type: "assistant",
    uuid: options.uuid,
    timestamp: options.timestamp,
    requestId: `req_${options.uuid}`,
    ...(options.attributionSkill
      ? { attributionSkill: options.attributionSkill }
      : {}),
    message: {
      id: options.messageId,
      model: options.model,
      content,
      usage: {
        input_tokens: options.counts.input,
        output_tokens: options.counts.output,
        cache_read_input_tokens: options.counts.cacheRead,
        cache_creation_input_tokens: options.counts.cacheWrite,
      },
    },
  });
}

/**
 * A run that enters `alpha`, nests `beta` inside it, returns to `alpha`, and
 * then invokes `alpha` a second time. Every shape the attribution has to get
 * right is present: a nested callee, a caller resuming after it, and a repeat
 * invocation of a component already seen.
 */
function nestedSkillTranscript(): string[] {
  return [
    assistantTurn({
      uuid: "00000000-0000-4000-8000-000000000001",
      messageId: "msg_open_alpha",
      timestamp: "2026-08-23T10:00:00.000Z",
      model: "claude-opus-4-8",
      counts: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
      toolUse: {
        id: "toolu_alpha_1",
        name: "Skill",
        input: { skill: "alpha" },
      },
    }),
    assistantTurn({
      uuid: "00000000-0000-4000-8000-000000000002",
      messageId: "msg_alpha_body",
      timestamp: "2026-08-23T10:00:01.000Z",
      model: "claude-opus-4-8",
      counts: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      attributionSkill: "alpha",
      toolUse: { id: "toolu_beta_1", name: "Skill", input: { skill: "beta" } },
    }),
    assistantTurn({
      uuid: "00000000-0000-4000-8000-000000000003",
      messageId: "msg_beta_body",
      timestamp: "2026-08-23T10:00:02.000Z",
      model: "claude-opus-4-8",
      counts: { input: 100, output: 200, cacheRead: 300, cacheWrite: 400 },
      attributionSkill: "beta",
    }),
    assistantTurn({
      uuid: "00000000-0000-4000-8000-000000000004",
      messageId: "msg_alpha_resume",
      timestamp: "2026-08-23T10:00:03.000Z",
      model: "claude-opus-4-8",
      counts: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 },
      attributionSkill: "alpha",
    }),
  ];
}

describe("ISS-7795 per-invocation usage attribution", () => {
  it("measures each skill from the turns the harness stamped for it", async () => {
    const session = await parseClaudeTranscript(nestedSkillTranscript(), {
      sessionId: SESSION_ID,
    });
    const alpha = session?.skills.find((skill) => skill.name === "alpha");
    const beta = session?.skills.find((skill) => skill.name === "beta");

    // alpha's own body turn plus the turn where it resumed after beta returned.
    // The turn that OPENED alpha is not alpha's — no skill was active yet.
    expect(alpha?.usage).toEqual({
      model: "claude-opus-4-8",
      inputTokens: 6,
      outputTokens: 8,
      cacheReadTokens: 10,
      cacheWriteTokens: 12,
    });
    // beta gets only its own turn, never its caller's.
    expect(beta?.usage).toEqual({
      model: "claude-opus-4-8",
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 300,
      cacheWriteTokens: 400,
    });
  });

  it("leaves usage absent when the harness attributed no turn", async () => {
    const session = await parseClaudeTranscript(
      [
        assistantTurn({
          uuid: "00000000-0000-4000-8000-000000000010",
          messageId: "msg_unstamped",
          timestamp: "2026-08-23T11:00:00.000Z",
          model: "claude-opus-4-8",
          counts: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 },
          toolUse: {
            id: "toolu_lonely",
            name: "Skill",
            input: { skill: "lonely" },
          },
        }),
      ],
      { sessionId: SESSION_ID }
    );
    const lonely = session?.skills.find((skill) => skill.name === "lonely");

    // The positive sibling above proves a stamped skill DOES get a value, so
    // this absence is the producer declining to invent one rather than the
    // producer being inert.
    expect(lonely).toBeDefined();
    expect(lonely?.usage).toBeUndefined();
  });

  /**
   * The command half. A slash entry's component key keeps its leading `/`
   * (`normalizeCommandComponentKey`), while the harness stamp never carries one,
   * so this is the only case that exercises the slash-stripping the join depends
   * on — every skill name is already slash-free, which makes the skill cases
   * above blind to it.
   */
  it("measures a slash command from the turns stamped with its bare name", async () => {
    const session = await parseClaudeTranscript(
      [
        JSON.stringify({
          type: "user",
          uuid: "00000000-0000-4000-8000-000000000030",
          timestamp: "2026-08-23T13:00:00.000Z",
          message: {
            role: "user",
            content: "<command-name>/deploy</command-name>",
          },
        }),
        assistantTurn({
          uuid: "00000000-0000-4000-8000-000000000031",
          messageId: "msg_deploy_body",
          timestamp: "2026-08-23T13:00:01.000Z",
          model: "claude-opus-4-8",
          counts: { input: 41, output: 42, cacheRead: 43, cacheWrite: 44 },
          attributionSkill: "deploy",
        }),
      ],
      { sessionId: SESSION_ID }
    );
    const deploy = session?.slashCommands.find((command) =>
      command.name.includes("deploy")
    );

    expect(deploy?.usage).toEqual({
      model: "claude-opus-4-8",
      inputTokens: 41,
      outputTokens: 42,
      cacheReadTokens: 43,
      cacheWriteTokens: 44,
    });
  });

  it("reports no single model when one invocation spans two", async () => {
    const session = await parseClaudeTranscript(
      [
        assistantTurn({
          uuid: "00000000-0000-4000-8000-000000000020",
          messageId: "msg_open_mixed",
          timestamp: "2026-08-23T12:00:00.000Z",
          model: "claude-opus-4-8",
          counts: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
          toolUse: {
            id: "toolu_mixed",
            name: "Skill",
            input: { skill: "mixed" },
          },
        }),
        assistantTurn({
          uuid: "00000000-0000-4000-8000-000000000021",
          messageId: "msg_mixed_a",
          timestamp: "2026-08-23T12:00:01.000Z",
          model: "claude-opus-4-8",
          counts: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5 },
          attributionSkill: "mixed",
        }),
        assistantTurn({
          uuid: "00000000-0000-4000-8000-000000000022",
          messageId: "msg_mixed_b",
          timestamp: "2026-08-23T12:00:02.000Z",
          model: "claude-fable-5",
          counts: { input: 20, output: 30, cacheRead: 40, cacheWrite: 50 },
          attributionSkill: "mixed",
        }),
      ],
      { sessionId: SESSION_ID }
    );
    const mixed = session?.skills.find((skill) => skill.name === "mixed");

    // Tokens still add — they are additive across models. The model does not,
    // so it is null rather than whichever one happened to be seen first.
    expect(mixed?.usage).toEqual({
      model: null,
      inputTokens: 22,
      outputTokens: 33,
      cacheReadTokens: 44,
      cacheWriteTokens: 55,
    });
  });
});
