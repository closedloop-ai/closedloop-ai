/**
 * @file parse-claude-sidechain-provenance.test.ts
 * @description Token provenance and the subagent roster must agree.
 *
 * `deriveSidechainSubagentId` states the contract directly: "The parser DOES emit
 * a `NormalizedSubagent` under this id, so a consumer joining
 * `tokenSeries.subagentId` to `subagents[].id` resolves rather than missing."
 *
 * That held only for turns that called a tool, because the row was created from
 * the `tool_use` handler while the provenance stamp is applied to every
 * usage-bearing sidechain record. A delegated turn that only spoke — text, or
 * thinking — therefore billed tokens to an agent that appears nowhere in the
 * roster. These pin the join itself rather than either half of it.
 */
import { describe, expect, it } from "vitest";
import { parseClaudeTranscript } from "./parse-claude-core";
import { UNATTRIBUTED_SUBAGENT_ID } from "./parse-claude-subagents";

const USER_LINE = JSON.stringify({
  type: "user",
  timestamp: "2026-07-09T12:00:00.000Z",
  cwd: "/workspace/project",
  message: { role: "user", content: "go" },
});

const USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

const sidechainTurn = (
  content: unknown[],
  extra: Record<string, unknown> = {}
) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-09T12:00:01.000Z",
    isSidechain: true,
    ...extra,
    message: {
      role: "assistant",
      model: "claude-opus-4",
      content,
      usage: USAGE,
    },
  });

/** Every provenance stamp must name a subagent the session also lists. */
function unresolvedProvenance(session: {
  tokenSeries: { subagentId?: string | null }[];
  subagents: { id: string }[];
}): string[] {
  const roster = new Set(session.subagents.map((agent) => agent.id));
  return session.tokenSeries
    .map((record) => record.subagentId)
    .filter((id): id is string => Boolean(id))
    .filter((id) => !roster.has(id));
}

describe("a usage-bearing sidechain turn always has a roster row", () => {
  it("resolves provenance for an IDENTIFIED text-only delegated turn", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        sidechainTurn([{ type: "text", text: "thinking out loud" }], {
          agentId: "ad00546980b4b4701",
          attributionAgent: "general-purpose",
        }),
      ],
      { sessionId: "sidechain-text-only" }
    );

    expect(session).not.toBeNull();
    // The turn is billed to somebody, so somebody has to be listed.
    expect(session?.tokenSeries.some((record) => record.subagentId)).toBe(true);
    expect(unresolvedProvenance(session as never)).toEqual([]);
    expect((session?.subagents ?? []).map((agent) => agent.id)).toContain(
      "agent-ad00546980b4b4701"
    );
  });

  it("resolves provenance for a thinking-only delegated turn", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        sidechainTurn([{ type: "thinking", thinking: "quiet reasoning" }], {
          agentId: "ad00546980b4b4701",
        }),
      ],
      { sessionId: "sidechain-thinking-only" }
    );

    expect(unresolvedProvenance(session as never)).toEqual([]);
  });

  it("resolves provenance for an IDLESS text-only delegated turn", async () => {
    // No agentId, uuid, parentUuid or sessionId: the turn is provably not the
    // parent's, so it is stamped with the sentinel — which must still resolve.
    const session = await parseClaudeTranscript(
      [USER_LINE, sidechainTurn([{ type: "text", text: "anonymous" }])],
      { sessionId: "sidechain-idless" }
    );

    expect(
      session?.tokenSeries.some(
        (record) => record.subagentId === UNATTRIBUTED_SUBAGENT_ID
      )
    ).toBe(true);
    expect(unresolvedProvenance(session as never)).toEqual([]);
  });

  it("still resolves when the delegated turn DID call a tool", async () => {
    // The path that already worked, kept as the control so a regression in the
    // tool lane is not hidden by the new one.
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        sidechainTurn(
          [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }],
          { agentId: "ad00546980b4b4701" }
        ),
      ],
      { sessionId: "sidechain-tool" }
    );

    expect(unresolvedProvenance(session as never)).toEqual([]);
  });

  it("leaves a NON-sidechain turn attributed to the parent", async () => {
    // The paired control for the whole file: an ordinary assistant turn must not
    // acquire a subagent row, or every parent turn would look delegated.
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-07-09T12:00:01.000Z",
          message: {
            role: "assistant",
            model: "claude-opus-4",
            content: [{ type: "text", text: "parent speaking" }],
            usage: USAGE,
          },
        }),
      ],
      { sessionId: "parent-turn" }
    );

    expect(session?.subagents).toEqual([]);
    expect(session?.tokenSeries.every((record) => !record.subagentId)).toBe(
      true
    );
  });
});
