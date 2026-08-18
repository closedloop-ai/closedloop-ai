/**
 * @file parse-claude-delegations.test.ts
 * @description ISS-4592: the delegation-kickoff join, at the core (browser-safe)
 * layer. Covers the in-line sidechain lane end-to-end through
 * `parseClaudeTranscript`, plus the pure fold/apply helpers the desktop shell
 * composes for the sidecar lane.
 *
 * Deliberately asserted here: that ABSENT kickoff data leaves the keys OFF the
 * record rather than writing `null`. That is the property keeping an unenriched
 * session's parser output byte-identical to pre-ISS-4592, which the frozen
 * golden oracles assert by deep-equality.
 */
import { describe, expect, it } from "vitest";
import type { NormalizedSubagent } from "../types";
import { parseClaudeTranscript } from "./parse-claude-core";
import {
  applyDelegationToSubagent,
  boundedDelegationType,
  buildDelegationToolUseIndex,
  CLAUDE_DELEGATION_TASK_MAX_BYTES,
  CLAUDE_DELEGATION_TYPE_MAX_CHARS,
  type ClaudeDelegation,
  delegationFromToolUseResult,
  delegationsFromEntryToolUses,
  mergeDelegations,
  toolResultIdFromEntry,
} from "./parse-claude-delegations";

/** A trailing high surrogate — what a naive UTF-16 slice would leave behind. */
const TRAILING_LONE_SURROGATE_RE = /[\uD800-\uDBFF]$/;

const SESSION_ID = "delegation-session";
const CHILD_AGENT_ID = "a7bb59fb7a25cac2e";
const CHILD_SUBAGENT_ID = `agent-${CHILD_AGENT_ID}`;

const USER_LINE = JSON.stringify({
  type: "user",
  timestamp: "2026-07-09T12:00:00.000Z",
  cwd: "/home/me/myproject",
  message: { role: "user", content: "hello" },
});

function delegationToolUseLine(options: {
  toolUseId: string;
  toolName?: string;
  typeKey?: string;
  type?: string;
  prompt?: string;
  description?: string;
}): string {
  const input: Record<string, unknown> = {};
  if (options.description != null) {
    input.description = options.description;
  }
  if (options.type != null) {
    input[options.typeKey ?? "subagent_type"] = options.type;
  }
  if (options.prompt != null) {
    input.prompt = options.prompt;
  }
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-09T12:00:01.000Z",
    message: {
      role: "assistant",
      model: "claude-sonnet-5",
      content: [
        {
          type: "tool_use",
          id: options.toolUseId,
          name: options.toolName ?? "Agent",
          input,
        },
      ],
    },
  });
}

function delegationResultLine(options: {
  toolUseId: string;
  agentId?: string;
  agentType?: string;
  prompt?: string;
}): string {
  const toolUseResult: Record<string, unknown> = { status: "completed" };
  if (options.agentId != null) {
    toolUseResult.agentId = options.agentId;
  }
  if (options.agentType != null) {
    toolUseResult.agentType = options.agentType;
  }
  if (options.prompt != null) {
    toolUseResult.prompt = options.prompt;
  }
  return JSON.stringify({
    type: "user",
    timestamp: "2026-07-09T12:00:09.000Z",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: options.toolUseId,
          content: [{ type: "text", text: "done" }],
        },
      ],
    },
    toolUseResult,
  });
}

/**
 * A sidechain line carrying a tool_use, which is what makes the core create
 * the child's subagent record inline (`ensureSidechainSubagent` runs on the
 * tool_use branch, so a text-only sidechain line registers no subagent).
 */
function sidechainLine(agentId: string, toolUseId: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-09T12:00:05.000Z",
    isSidechain: true,
    agentId,
    uuid: `${agentId}-line`,
    message: {
      role: "assistant",
      model: "claude-sonnet-5",
      content: [
        {
          type: "tool_use",
          id: toolUseId,
          name: "Read",
          input: { file_path: "/repo/src/index.ts" },
        },
      ],
    },
  });
}

function subagentById(
  subagents: readonly NormalizedSubagent[] | undefined,
  id: string
): NormalizedSubagent | undefined {
  return subagents?.find((subagent) => subagent.id === id);
}

describe("Claude delegation kickoff (ISS-4592)", () => {
  it("carries the kickoff onto the in-line sidechain subagent it spawned", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        delegationToolUseLine({
          toolUseId: "toolu_kickoff",
          type: "Explore",
          prompt: "Investigate the dashboard bug",
          description: "Find dashboard bug",
        }),
        sidechainLine(CHILD_AGENT_ID, "toolu_child_read"),
        delegationResultLine({
          toolUseId: "toolu_kickoff",
          agentId: CHILD_AGENT_ID,
          agentType: "Explore",
        }),
      ],
      { sessionId: SESSION_ID }
    );

    const child = subagentById(session?.subagents, CHILD_SUBAGENT_ID);
    expect(child?.type).toBe("Explore");
    expect(child?.task).toBe("Investigate the dashboard bug");
    expect(child?.metadata?.spawnedByToolUseId).toBe("toolu_kickoff");
    expect(child?.metadata?.description).toBe("Find dashboard bug");
  });

  it("accepts the legacy `Task` tool name and `agent_type` input key", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        delegationToolUseLine({
          toolUseId: "toolu_legacy",
          toolName: "Task",
          typeKey: "agent_type",
          type: "general-purpose",
          prompt: "Legacy harness kickoff",
        }),
        sidechainLine(CHILD_AGENT_ID, "toolu_child_read"),
        delegationResultLine({
          toolUseId: "toolu_legacy",
          agentId: CHILD_AGENT_ID,
        }),
      ],
      { sessionId: SESSION_ID }
    );

    const child = subagentById(session?.subagents, CHILD_SUBAGENT_ID);
    expect(child?.type).toBe("general-purpose");
    expect(child?.task).toBe("Legacy harness kickoff");
  });

  it("gives each of two same-type delegations in one turn its OWN kickoff", async () => {
    // The join must be by the tool_use/agent id pair, never by order or by the
    // turn's promptId — two Explore delegations in one turn are otherwise
    // indistinguishable and would swap prompts.
    const secondAgentId = "b1c2d3e4f5a6b7c8";
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        delegationToolUseLine({
          toolUseId: "toolu_first",
          type: "Explore",
          prompt: "FIRST prompt",
        }),
        delegationToolUseLine({
          toolUseId: "toolu_second",
          type: "Explore",
          prompt: "SECOND prompt",
        }),
        sidechainLine(CHILD_AGENT_ID, "toolu_child_a"),
        sidechainLine(secondAgentId, "toolu_child_b"),
        delegationResultLine({
          toolUseId: "toolu_second",
          agentId: secondAgentId,
        }),
        delegationResultLine({
          toolUseId: "toolu_first",
          agentId: CHILD_AGENT_ID,
        }),
      ],
      { sessionId: SESSION_ID }
    );

    expect(subagentById(session?.subagents, CHILD_SUBAGENT_ID)?.task).toBe(
      "FIRST prompt"
    );
    expect(
      subagentById(session?.subagents, `agent-${secondAgentId}`)?.task
    ).toBe("SECOND prompt");
  });

  it("OMITS the keys entirely when the transcript carries no kickoff", async () => {
    const session = await parseClaudeTranscript(
      [USER_LINE, sidechainLine(CHILD_AGENT_ID, "toolu_child_read")],
      { sessionId: SESSION_ID }
    );

    const child = subagentById(session?.subagents, CHILD_SUBAGENT_ID);
    expect(child).toBeDefined();
    expect(child?.task ?? null).toBeNull();
    expect(child?.metadata?.spawnedByToolUseId ?? null).toBeNull();
  });

  it("does not enrich when the result payload names no child agent", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        delegationToolUseLine({
          toolUseId: "toolu_orphan",
          type: "Explore",
          prompt: "unjoinable",
        }),
        sidechainLine(CHILD_AGENT_ID, "toolu_child_read"),
        // No agentId: nothing identifies which child this answered.
        delegationResultLine({ toolUseId: "toolu_orphan" }),
      ],
      { sessionId: SESSION_ID }
    );

    expect(
      subagentById(session?.subagents, CHILD_SUBAGENT_ID)?.task ?? null
    ).toBeNull();
  });

  it("truncates an oversized prompt at the byte cap, preserving the 500-char prefix", async () => {
    // The DB layer stores task.slice(0, 500) and the live-hook reconciliation
    // compares against that prefix, so truncation must never disturb it.
    const hugePrompt = "x".repeat(CLAUDE_DELEGATION_TASK_MAX_BYTES * 2);
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        delegationToolUseLine({
          toolUseId: "toolu_big",
          type: "Explore",
          prompt: hugePrompt,
        }),
        sidechainLine(CHILD_AGENT_ID, "toolu_child_read"),
        delegationResultLine({
          toolUseId: "toolu_big",
          agentId: CHILD_AGENT_ID,
        }),
      ],
      { sessionId: SESSION_ID }
    );

    const task =
      subagentById(session?.subagents, CHILD_SUBAGENT_ID)?.task ?? "";
    expect(new TextEncoder().encode(task).length).toBeLessThanOrEqual(
      CLAUDE_DELEGATION_TASK_MAX_BYTES
    );
    expect(task.slice(0, 500)).toBe(hugePrompt.slice(0, 500));
  });

  it("truncates a multi-byte prompt without emitting a partial code unit", () => {
    const emoji = "🙂".repeat(CLAUDE_DELEGATION_TASK_MAX_BYTES);
    const [delegation] = delegationsFromEntryToolUses(
      JSON.parse(
        delegationToolUseLine({
          toolUseId: "toolu_emoji",
          type: "Explore",
          prompt: emoji,
        })
      )
    );

    const bytes = new TextEncoder().encode(delegation?.task ?? "");
    expect(bytes.length).toBeLessThanOrEqual(CLAUDE_DELEGATION_TASK_MAX_BYTES);
    // A byte-cut multi-byte sequence decodes to U+FFFD, never a lone surrogate.
    expect(delegation?.task).not.toMatch(TRAILING_LONE_SURROGATE_RE);
  });

  it("never overwrites a value the record already carries", () => {
    const subagent: NormalizedSubagent = {
      id: CHILD_SUBAGENT_ID,
      name: "existing",
      type: "already-set",
      task: "already-set-task",
      metadata: { spawnedByToolUseId: "toolu_original" },
    };
    applyDelegationToSubagent(subagent, {
      toolUseId: "toolu_later",
      agentId: CHILD_AGENT_ID,
      type: "late-type",
      task: "late-task",
      description: "late-description",
    });

    expect(subagent.type).toBe("already-set");
    expect(subagent.task).toBe("already-set-task");
    expect(subagent.metadata?.spawnedByToolUseId).toBe("toolu_original");
    // An absent field is still fillable — additive, not all-or-nothing.
    expect(subagent.metadata?.description).toBe("late-description");
  });

  it("leaves a record untouched when the delegation carries nothing", () => {
    const subagent: NormalizedSubagent = {
      id: CHILD_SUBAGENT_ID,
      name: "bare",
    };
    const empty: ClaudeDelegation = {
      toolUseId: null,
      agentId: null,
      type: null,
      task: null,
      description: null,
    };
    applyDelegationToSubagent(subagent, empty);

    // No empty `metadata: {}` may appear — the frozen oracles deep-equal.
    expect(subagent).toEqual({ id: CHILD_SUBAGENT_ID, name: "bare" });
  });

  it("recovers the kickoff from a tool_result whose tool_use line is gone", async () => {
    // A truncated head (or a dropped malformed line) leaves the tool_result
    // without its tool_use. `toolUseResult` still names the child and its type,
    // so the delegation must survive rather than being discarded with the
    // unresolved tool-use lookup.
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        sidechainLine(CHILD_AGENT_ID, "toolu_child_read"),
        delegationResultLine({
          toolUseId: "toolu_vanished",
          agentId: CHILD_AGENT_ID,
          agentType: "code-reviewer",
          prompt: "Review the diff",
        }),
      ],
      { sessionId: SESSION_ID }
    );

    const child = subagentById(session?.subagents, CHILD_SUBAGENT_ID);
    expect(child?.type).toBe("code-reviewer");
    expect(child?.task).toBe("Review the diff");
    expect(child?.metadata?.spawnedByToolUseId).toBe("toolu_vanished");
  });

  it("omits an over-cap type instead of failing the strict worker boundary", async () => {
    // `type` is capped at the worker IPC boundary; an over-long value would
    // reject the WHOLE session payload, so the producer drops just the field.
    // Omitted rather than truncated: a truncated identifier is a wrong label.
    const oversized = "x".repeat(CLAUDE_DELEGATION_TYPE_MAX_CHARS + 1);
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        delegationToolUseLine({ toolUseId: "toolu_big", type: oversized }),
        sidechainLine(CHILD_AGENT_ID, "toolu_child_read"),
        delegationResultLine({
          toolUseId: "toolu_big",
          agentId: CHILD_AGENT_ID,
          prompt: "Do the thing",
        }),
      ],
      { sessionId: SESSION_ID }
    );

    const child = subagentById(session?.subagents, CHILD_SUBAGENT_ID);
    expect(child?.type).toBeUndefined();
    // The rest of the delegation still lands — one bad field, not one lost session.
    expect(child?.task).toBe("Do the thing");

    expect(boundedDelegationType(oversized)).toBeNull();
    expect(
      boundedDelegationType("x".repeat(CLAUDE_DELEGATION_TYPE_MAX_CHARS))
    ).toBe("x".repeat(CLAUDE_DELEGATION_TYPE_MAX_CHARS));
    expect(boundedDelegationType(null)).toBeNull();
  });

  it("folds partial sources into one delegation, first non-null winning", () => {
    const fromInput: ClaudeDelegation = {
      toolUseId: "toolu_x",
      agentId: null,
      type: "Explore",
      task: "the full prompt",
      description: "short label",
    };
    const fromResult: ClaudeDelegation = {
      toolUseId: "toolu_x",
      agentId: CHILD_AGENT_ID,
      type: "Explore",
      task: null,
      description: null,
    };

    expect(mergeDelegations(fromInput, fromResult)).toEqual({
      toolUseId: "toolu_x",
      agentId: CHILD_AGENT_ID,
      type: "Explore",
      task: "the full prompt",
      description: "short label",
    });
  });
});

// ---------------------------------------------------------------------------
// ISS-5292 Packet C: branch coverage additions for uncovered paths
// ---------------------------------------------------------------------------

describe("delegationFromToolUseResult — non-object inputs (Branch 2[0])", () => {
  it("returns null for null input", () => {
    // Branch 2[0]: !toolUseResult || typeof toolUseResult !== "object" → null.
    expect(delegationFromToolUseResult("toolu_x", null)).toBeNull();
  });

  it("returns null for a string input", () => {
    expect(delegationFromToolUseResult("toolu_x", "not-an-object")).toBeNull();
  });

  it("returns null for a number input", () => {
    expect(delegationFromToolUseResult("toolu_x", 42)).toBeNull();
  });

  it("returns null when agentId is absent from the payload", () => {
    // toolUseResult is an object but has no agentId → null.
    expect(
      delegationFromToolUseResult("toolu_x", { status: "completed" })
    ).toBeNull();
  });
});

describe("delegationsFromEntryToolUses — guard branches", () => {
  it("returns [] when message is absent", () => {
    // Branch: !message || typeof message !== "object" → [].
    expect(delegationsFromEntryToolUses({})).toEqual([]);
  });

  it("returns [] when message.content is not an array", () => {
    // Branch: !Array.isArray(content) → [].
    expect(
      delegationsFromEntryToolUses({
        message: { role: "user", content: "text" },
      })
    ).toEqual([]);
  });

  it("skips null blocks in content (rawBlock null guard)", () => {
    // Branch: !rawBlock || typeof rawBlock !== "object" → continue.
    const result = delegationsFromEntryToolUses({
      message: {
        role: "user",
        content: [
          null,
          {
            type: "tool_use",
            id: "toolu_y",
            name: "Agent",
            input: { subagent_type: "Explore", prompt: "do something" },
          },
        ],
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("Explore");
  });

  it("skips non-delegation tool_use blocks", () => {
    // Branch: CLAUDE_DELEGATION_TOOL_NAMES.has(block.name) → false → continue.
    const result = delegationsFromEntryToolUses({
      message: {
        role: "user",
        content: [{ type: "tool_use", id: "toolu_r", name: "Read", input: {} }],
      },
    });
    expect(result).toEqual([]);
  });

  it("uses agent_type as fallback when subagent_type is absent", () => {
    // Branch: stringValue(input.subagent_type) null → fall to agent_type.
    const result = delegationsFromEntryToolUses({
      message: {
        role: "user",
        content: [
          {
            type: "tool_use",
            id: "toolu_legacy",
            name: "Task",
            input: { agent_type: "code-reviewer", prompt: "check the diff" },
          },
        ],
      },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("code-reviewer");
    expect(result[0]?.task).toBe("check the diff");
  });
});

describe("mergeDelegations — incoming wins when base has null fields", () => {
  it("promotes every null base field with the incoming non-null value", () => {
    // Branches 19[1], 21[1], 22[1], 23[1]: base.X ?? incoming.X → incoming wins.
    const base: ClaudeDelegation = {
      toolUseId: null,
      agentId: null,
      type: null,
      task: null,
      description: null,
    };
    const incoming: ClaudeDelegation = {
      toolUseId: "toolu_new",
      agentId: "agent-new-id",
      type: "Explore",
      task: "new task",
      description: "new description",
    };

    expect(mergeDelegations(base, incoming)).toEqual({
      toolUseId: "toolu_new",
      agentId: "agent-new-id",
      type: "Explore",
      task: "new task",
      description: "new description",
    });
  });
});

describe("toolResultIdFromEntry (ZERO prior hits)", () => {
  it("returns null when message is absent", () => {
    expect(toolResultIdFromEntry({})).toBeNull();
  });

  it("returns null when message.content is not an array", () => {
    expect(
      toolResultIdFromEntry({ message: { role: "user", content: "text" } })
    ).toBeNull();
  });

  it("skips null blocks and returns null when only null blocks are present", () => {
    expect(
      toolResultIdFromEntry({ message: { role: "user", content: [null] } })
    ).toBeNull();
  });

  it("skips non-tool_result blocks and returns null", () => {
    expect(
      toolResultIdFromEntry({
        message: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      })
    ).toBeNull();
  });

  it("returns the tool_use_id from a tool_result block", () => {
    expect(
      toolResultIdFromEntry({
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_abc", content: [] },
          ],
        },
      })
    ).toBe("toolu_abc");
  });

  it("returns the FIRST tool_result's tool_use_id in a multi-block list", () => {
    expect(
      toolResultIdFromEntry({
        message: {
          role: "user",
          content: [
            { type: "text", text: "preamble" },
            { type: "tool_result", tool_use_id: "toolu_first", content: [] },
            { type: "tool_result", tool_use_id: "toolu_second", content: [] },
          ],
        },
      })
    ).toBe("toolu_first");
  });
});

describe("buildDelegationToolUseIndex (ZERO prior hits)", () => {
  it("indexes Agent tool_use entries from the main session's toolUses", () => {
    const session = {
      sessionId: "idx-test",
      toolUses: [
        {
          name: "Agent",
          id: "toolu_main1",
          timestamp: null,
          input: { subagent_type: "Explore" },
        },
        { name: "Read", id: "toolu_main2", timestamp: null },
      ],
      subagents: [],
    } as unknown as Parameters<typeof buildDelegationToolUseIndex>[0];

    const index = buildDelegationToolUseIndex(session);
    expect(index.has("toolu_main1")).toBe(true);
    expect(index.has("toolu_main2")).toBe(false);
  });

  it("also indexes Agent tool_use entries from subagent toolUses", () => {
    const session = {
      sessionId: "idx-subagent-test",
      toolUses: [],
      subagents: [
        {
          id: "agent-child",
          name: "child",
          toolUses: [
            {
              name: "Task",
              id: "toolu_nested",
              timestamp: null,
              input: { agent_type: "code-reviewer" },
            },
            { name: "Bash", id: "toolu_bash", timestamp: null },
          ],
        },
      ],
    } as unknown as Parameters<typeof buildDelegationToolUseIndex>[0];

    const index = buildDelegationToolUseIndex(session);
    expect(index.has("toolu_nested")).toBe(true);
    expect(index.has("toolu_bash")).toBe(false);
  });

  it("skips entries whose id is not a string", () => {
    const session = {
      sessionId: "idx-noid-test",
      toolUses: [
        { name: "Agent", id: undefined, timestamp: null },
        { name: "Agent", id: "toolu_valid", timestamp: null },
      ],
      subagents: [],
    } as unknown as Parameters<typeof buildDelegationToolUseIndex>[0];

    const index = buildDelegationToolUseIndex(session);
    expect(index.size).toBe(1);
    expect(index.has("toolu_valid")).toBe(true);
  });
});

describe("applyDelegationToSubagent — true-path assignment branches", () => {
  it("assigns type, task, and toolUseId when the record carries none of them", () => {
    // Exercises the if-true branches for all three field writes.
    const subagent: NormalizedSubagent = { id: "agent-bare", name: "bare" };
    applyDelegationToSubagent(subagent, {
      toolUseId: "toolu_new",
      agentId: "bare",
      type: "code-reviewer",
      task: "review the diff",
      description: null,
    });

    expect(subagent.type).toBe("code-reviewer");
    expect(subagent.task).toBe("review the diff");
    expect(subagent.metadata?.spawnedByToolUseId).toBe("toolu_new");
  });
});
