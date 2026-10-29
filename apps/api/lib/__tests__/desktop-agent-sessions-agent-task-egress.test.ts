import { describe, expect, it } from "vitest";
import { parseDesktopAgentSessionsPayload } from "../desktop-agent-sessions-schema";
import { validDesktopAgentSessionsPayload as validPayload } from "./desktop-agent-sessions-handler-fixtures";

describe("parseDesktopAgentSessionsPayload — agent task text (ISS-6894)", () => {
  /**
   * ISS-6894: delegated `task` text is prohibited on the sync wire, so the key
   * is gone from the agent schema. An installed desktop still sends it, and the
   * schema is deliberately not `.strict()` — these pin the STRIP rather than a
   * rejection, because rejecting would dead-letter every pre-cutover client.
   */
  const payloadWithAgent = (agent: Record<string, unknown>) => ({
    ...validPayload,
    sessions: [{ ...validPayload.sessions[0], agents: [agent] }],
  });

  const baseAgent = {
    externalAgentId: "agent-1",
    name: "Main agent",
    type: "main",
    subagentType: null,
    status: "active",
    currentTool: null,
    startedAt: "2026-05-20T17:00:00.000Z",
    updatedAt: "2026-05-20T17:05:00.000Z",
    endedAt: null,
    awaitingInputSince: null,
    parentExternalAgentId: null,
  };

  it("accepts an older client that still sends task, and drops the value", () => {
    const result = parseDesktopAgentSessionsPayload(
      payloadWithAgent({
        ...baseAgent,
        task: "Refactor the collector and land the slice.",
      })
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sessions[0].agents[0]).not.toHaveProperty("task");
    }
  });

  it("accepts a current client that omits task entirely", () => {
    const result = parseDesktopAgentSessionsPayload(
      payloadWithAgent(baseAgent)
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sessions[0].agents[0]).not.toHaveProperty("task");
    }
  });
});
