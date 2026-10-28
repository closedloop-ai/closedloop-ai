import { sessionMeshPresenceValidator } from "@repo/api/src/types/session-mesh";
import { describe, expect, it, vi } from "vitest";
import {
  executeMeshCommand,
  meshCommandValidator,
} from "../src/main/session-mesh/session-mesh-commands.js";

const messageId = "821cb07e-2867-42fc-a77d-43d10f1ef4e4";
const presence = sessionMeshPresenceValidator.parse({
  agentId: "codex:current",
  workspace: { repository: "example.test/org/repo", revision: "sha" },
});
function command(operation: string, payload: Record<string, unknown> = {}) {
  return meshCommandValidator.parse({
    operation,
    agentId: presence.agentId,
    payload,
  });
}

describe("Session Mesh native commands", () => {
  it("forwards both context cursors and preserves returned held-history continuation", async () => {
    const page = {
      inbox: [{ messageId, status: "held" }],
      nextInboxCursor: messageId,
      nextRosterCursor: "claude:later",
    };
    const request = vi.fn().mockResolvedValue(page);
    expect(
      await executeMeshCommand(
        command("context", {
          cursor: "claude:peer/with space",
          inboxCursor: messageId,
        }),
        presence,
        request
      )
    ).toEqual(page);
    const url = new URL(request.mock.calls[0][0], "https://api.example.test");
    expect(url.pathname).toBe("/session-mesh/related");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      agentId: presence.agentId,
      repository: presence.workspace.repository,
      cursor: "claude:peer/with space",
      inboxCursor: messageId,
    });
  });

  it("omits absent context cursors", async () => {
    const request = vi.fn().mockResolvedValue({ inbox: [] });
    await executeMeshCommand(command("context"), presence, request);
    const query = new URL(request.mock.calls[0][0], "https://api.example.test")
      .searchParams;
    expect(query.has("cursor")).toBe(false);
    expect(query.has("inboxCursor")).toBe(false);
  });

  it.each([
    { cursor: "" },
    { cursor: "x".repeat(501) },
    { inboxCursor: "not-a-uuid" },
  ])(
    "rejects malformed context pagination before requesting: %j",
    (payload) => {
      const request = vi.fn();
      expect(() =>
        executeMeshCommand(command("context", payload), presence, request)
      ).toThrow();
      expect(request).not.toHaveBeenCalled();
    }
  );

  it.each(["useful", "conflict_resolved"])(
    "forwards %s attribution with current identity and stable retry key",
    async (kind) => {
      const request = vi.fn().mockResolvedValue({ event: { id: messageId } });
      const payload = {
        messageId,
        kind,
        agentId: "claude:spoofed",
        idempotencyKey: "one-observed-outcome",
        rationale:
          "Recipient used the shared caller list to resolve the overlap.",
        estimatedTimeSavedMinutes: 4,
        estimatedCostSavedUsd: 0.25,
      };
      await executeMeshCommand(command("feedback", payload), presence, request);
      await executeMeshCommand(command("feedback", payload), presence, request);
      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls[0]).toEqual([
        "/session-mesh/feedback",
        { ...payload, agentId: presence.agentId },
      ]);
      expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
    }
  );

  it("does not invent a savings value when the recipient supplies no estimate", async () => {
    const request = vi.fn().mockResolvedValue({ event: { id: messageId } });
    await executeMeshCommand(
      command("feedback", {
        messageId,
        kind: "useful",
        idempotencyKey: "outcome-without-estimate",
        rationale: "The shared evidence answered the question.",
      }),
      presence,
      request
    );
    expect(request.mock.calls[0][1]).not.toHaveProperty(
      "estimatedTimeSavedMinutes"
    );
    expect(request.mock.calls[0][1]).not.toHaveProperty(
      "estimatedCostSavedUsd"
    );
  });

  it.each([
    { idempotencyKey: "" },
    { rationale: "" },
    { estimatedCostSavedUsd: -1 },
    { estimatedTimeSavedMinutes: "unknown" },
  ])("rejects invalid feedback without an external write: %j", (invalid) => {
    const request = vi.fn();
    expect(() =>
      executeMeshCommand(
        command("feedback", {
          messageId,
          kind: "useful",
          idempotencyKey: "outcome",
          rationale: "Observed recipient outcome",
          ...invalid,
        }),
        presence,
        request
      )
    ).toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
