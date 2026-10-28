/**
 * ISS-12552: a Codex MCP call made as a namespaced function call carries its
 * call id, so its invocation is identified by that id instead of its position.
 * A call-id'd call's duration is measured from its call to its result time;
 * the Codex parser records no result time for a namespaced function call, so
 * that half uses a tool use that carries one.
 */
import { parseCodexRollout } from "@repo/lib/harness/codex/parse-codex";
import { describe, expect, it } from "vitest";
import { deriveAgentComponentInvocationCandidates } from "../src/main/database/component-invocations.js";
import { makeSession } from "./normalized-session-test-utils.js";

const CALL_ID = "call_xqRHSlQFit4K1fx9O6UexE0i";

describe("a Codex namespaced MCP call's invocation (ISS-12552)", () => {
  it("is identified by its call id, not its position", async () => {
    const session = await parseCodexRollout(
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-10-16T10:00:00.000Z",
          payload: { cwd: "/workspace/proj", cli_version: "0.162.1" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-10-16T10:00:01.000Z",
          payload: {
            type: "function_call",
            name: "get_document",
            namespace: "mcp__closedloop",
            arguments: JSON.stringify({ documentId: "PLN-2191" }),
            call_id: CALL_ID,
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-10-16T10:00:03.000Z",
          payload: {
            type: "function_call_output",
            call_id: CALL_ID,
            output: JSON.stringify({ id: "d1", slug: "PLN-2191" }),
          },
        }),
      ],
      { sessionId: "codex-mcp-invocation" }
    );
    if (!session) {
      throw new Error("rollout did not parse");
    }

    const invocations = deriveAgentComponentInvocationCandidates(
      session,
      "main-agent",
      "2026-10-16T10:05:00.000Z"
    ).filter((candidate) => candidate.providerToolUseId === CALL_ID);

    expect(invocations).toEqual([
      expect.objectContaining({
        externalInvocationId: CALL_ID,
        invokedAt: "2026-10-16T10:00:01.000Z",
      }),
    ]);
  });

  it("measures a call-id'd call from its call to its result", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "get_document",
          mcpNamespace: "mcp__closedloop",
          providerToolUseId: CALL_ID,
          timestamp: "2026-10-16T10:00:01.000Z",
          resultTimestamp: "2026-10-16T10:00:03.000Z",
        },
      ],
    });

    expect(
      deriveAgentComponentInvocationCandidates(
        session,
        "main-agent",
        "2026-10-16T10:05:00.000Z"
      ).filter((candidate) => candidate.providerToolUseId === CALL_ID)
    ).toEqual([
      expect.objectContaining({
        externalInvocationId: CALL_ID,
        durationMs: 2000,
      }),
    ]);
  });
});
