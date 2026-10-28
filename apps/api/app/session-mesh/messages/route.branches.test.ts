import { Status } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

const mocks = vi.hoisted(() => ({
  authOptions: [] as unknown[],
  userId: "0199a1b2-0000-7000-8000-000000000002",
  organizationId: "0199a1b2-0000-7000-8000-000000000001",
  publish: vi.fn(),
  messageForRecipient: vi.fn(),
}));

vi.mock("../auth", async () => {
  const { createTestAuthContext } = await import(
    "@/__tests__/utils/auth-helpers"
  );
  const { buildSessionMeshAuthMock } = await import(
    "@/__tests__/support/session-mesh/with-session-mesh-auth.test-helpers"
  );
  return {
    withSessionMeshAuth: buildSessionMeshAuthMock(mocks, createTestAuthContext),
  };
});
vi.mock("../service", () => ({
  sessionMeshService: {
    publish: mocks.publish,
    messageForRecipient: mocks.messageForRecipient,
  },
}));

const URL_BASE = "https://api.example.test/session-mesh/messages";
const MESSAGE_ID = "0199a1b2-0000-7000-8000-0000000000aa";
const context = { params: Promise.resolve({}) };
const WRITE_SCOPE = { requiredScopes: ["write"] };
const publishBody = {
  idempotencyKey: "idem-1",
  authorAgentId: "agent-1",
  kind: "discovery",
  workspace: { repository: "repo", revision: "rev" },
  summary: "found it",
};

function post(body: unknown) {
  return POST(
    new NextRequest(URL_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    context
  );
}

function get(params: Record<string, string>) {
  return GET(
    new NextRequest(`${URL_BASE}?${new URLSearchParams(params)}`),
    context
  );
}

describe("POST /session-mesh/messages", () => {
  it("rejects an invalid message before publishing", async () => {
    const response = await post({ ...publishBody, kind: "gossip" });

    expect(response.status).toBe(400);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("maps a Forbidden publish result to 403 session_mesh_publish_forbidden", async () => {
    mocks.publish.mockResolvedValue({ ok: false, error: Status.Forbidden });

    const response = await post(publishBody);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "session_mesh_publish_forbidden",
    });
  });

  it("publishes the validated message and returns the service result", async () => {
    const value = {
      message: { id: MESSAGE_ID },
      deliveries: 1,
      idempotent: false,
    };
    mocks.publish.mockResolvedValue({ ok: true, value });

    const response = await post(publishBody);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: value });
    expect(mocks.publish).toHaveBeenCalledWith(
      {
        organizationId: mocks.organizationId,
        userId: mocks.userId,
        message: expect.objectContaining({
          idempotencyKey: "idem-1",
          recipientAgentIds: [],
          sensitivity: "normal",
          expiresInSeconds: 3600,
        }),
      },
      undefined
    );
  });
});

describe("GET /session-mesh/messages", () => {
  it.each([
    ["agentId", { messageId: MESSAGE_ID }],
    ["messageId", { agentId: "agent-1" }],
    ["blank agentId", { agentId: "  ", messageId: MESSAGE_ID }],
  ])("requires both ids (missing %s)", async (_label, params) => {
    const response = await get(params);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "agentId and messageId are required",
    });
    expect(mocks.messageForRecipient).not.toHaveBeenCalled();
  });

  it("maps a null delivery to 404", async () => {
    mocks.messageForRecipient.mockResolvedValue(null);

    const response = await get({ agentId: "agent-1", messageId: MESSAGE_ID });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: "Session Mesh message not found",
    });
  });

  it("returns the delivery and its message for trimmed ids", async () => {
    const delivery = { id: "d-1", message: { id: MESSAGE_ID } };
    mocks.messageForRecipient.mockResolvedValue(delivery);

    const response = await get({
      agentId: " agent-1 ",
      messageId: ` ${MESSAGE_ID} `,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { message: { id: MESSAGE_ID }, delivery },
    });
    expect(mocks.messageForRecipient).toHaveBeenCalledWith({
      organizationId: mocks.organizationId,
      userId: mocks.userId,
      agentId: "agent-1",
      messageId: MESSAGE_ID,
    });
  });
});

describe("session mesh auth wiring", () => {
  it("passes the write scope to the auth wrapper for mutating handlers", () => {
    expect(mocks.authOptions).toEqual([WRITE_SCOPE, undefined]);
  });
});

describe("messages route failures", () => {
  it("returns a 500 when publishing throws", async () => {
    mocks.publish.mockRejectedValue(new Error("db down"));

    const response = await post(publishBody);

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: "Failed to publish Session Mesh message",
    });
  });

  it("returns a 500 when the recipient read throws", async () => {
    mocks.messageForRecipient.mockRejectedValue(new Error("db down"));

    const response = await get({ agentId: "agent-1", messageId: MESSAGE_ID });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: "Failed to fetch Session Mesh message",
    });
  });
});
