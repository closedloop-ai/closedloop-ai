import { TokenSourceIdentityAvailability } from "@repo/api/src/types/token-cost-provenance";
import { describe, expect, it } from "vitest";
import { requestKeyFor } from "../request-key";
import { claudeTranscriptEntryUuidScheme } from "../usage-dedup";
import { parseClaudeTranscript } from "./parse-claude";

// ISS-12552 (PRD-800 "Proving usage"): a tool call names the request
// that issued it, so its receipt can be joined to that request's usage. Claude
// writes one transcript line per content block of a request; the request's
// usage identity lists every one of those lines, the tool call's own included.

const USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

function assistantLine(
  uuid: string | undefined,
  content: unknown[],
  timestamp = "2026-10-20T12:00:01.000Z"
): string {
  return JSON.stringify({
    type: "assistant",
    ...(uuid ? { uuid } : {}),
    timestamp,
    requestId: "req_1",
    message: {
      id: "msg_1",
      role: "assistant",
      model: "claude-opus-4",
      content,
      usage: USAGE,
    },
  });
}

const USER_LINE = JSON.stringify({
  type: "user",
  uuid: "11111111-1111-4111-8111-111111111111",
  timestamp: "2026-10-20T12:00:00.000Z",
  cwd: "project",
  message: { role: "user", content: "write the plan" },
});

const TEXT_LINE_UUID = "22222222-2222-4222-8222-222222222222";
const TOOL_LINE_UUID = "33333333-3333-4333-8333-333333333333";

describe("parseClaudeTranscript tool call request key (ISS-12552)", () => {
  it("names a request its own usage identity lists", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        assistantLine(TEXT_LINE_UUID, [{ type: "text", text: "Saving." }]),
        assistantLine(TOOL_LINE_UUID, [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "mcp__closedloop__create-document",
            input: { title: "Plan" },
          },
        ]),
      ],
      { sessionId: "request-key" }
    );

    const toolUse = session?.toolUses.find((use) => use.id === "toolu_1");
    expect(toolUse?.requestKey).toBe(
      requestKeyFor(claudeTranscriptEntryUuidScheme, TOOL_LINE_UUID)
    );
    const requestKeys = (session?.tokenSeries ?? []).flatMap((entry) => {
      const identity = entry.sourceIdentity;
      return identity?.availability ===
        TokenSourceIdentityAvailability.Available
        ? identity.sourceRecordIds.map((id) =>
            requestKeyFor(identity.scheme, id)
          )
        : [];
    });
    expect(requestKeys).toContain(toolUse?.requestKey);
  });

  it("names no request for a line without a uuid", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        assistantLine(undefined, [
          {
            type: "tool_use",
            id: "toolu_2",
            name: "mcp__closedloop__create-document",
            input: { title: "Plan" },
          },
        ]),
      ],
      { sessionId: "request-key-absent" }
    );

    expect(
      session?.toolUses.find((use) => use.id === "toolu_2")
    ).not.toHaveProperty("requestKey");
  });
});
