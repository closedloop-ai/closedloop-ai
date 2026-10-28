import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  authOptions: [] as unknown[],
  userId: "0199a1b2-0000-7000-8000-000000000002",
  organizationId: "0199a1b2-0000-7000-8000-000000000001",
  resolveCurrentPresence: vi.fn(),
  rosterPage: vi.fn(),
  deliveryHistoryPage: vi.fn(),
  subscription: vi.fn(),
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
    resolveCurrentPresence: mocks.resolveCurrentPresence,
    rosterPage: mocks.rosterPage,
    deliveryHistoryPage: mocks.deliveryHistoryPage,
    subscription: mocks.subscription,
  },
}));

const INBOX_CURSOR = "0199a1b2-0000-7000-8000-0000000000cc";
const current = { agentId: "agent-1", repository: "repo", revision: "rev-1" };
const subscription = { muted: false, digestOnly: true };

function request(params: Record<string, string> = {}) {
  const query = new URLSearchParams(params).toString();
  return GET(
    new NextRequest(
      `https://api.example.test/session-mesh/related${query ? `?${query}` : ""}`
    ),
    { params: Promise.resolve({}) }
  );
}

describe("GET /session-mesh/related", () => {
  beforeEach(() => {
    mocks.resolveCurrentPresence.mockResolvedValue(current);
    mocks.rosterPage.mockResolvedValue({ agents: [{ agentId: "peer" }] });
    mocks.deliveryHistoryPage.mockResolvedValue({ messages: [{ id: "d-1" }] });
    mocks.subscription.mockResolvedValue(subscription);
  });

  it.each([
    ["a non-UUID inbox cursor", { inboxCursor: "not-a-uuid" }],
    ["an empty roster cursor", { cursor: "" }],
    ["an oversized roster cursor", { cursor: "x".repeat(501) }],
  ])("rejects %s before resolving presence", async (_label, params) => {
    const response = await request({ agentId: "agent-1", ...params });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: "Invalid coordination cursor",
    });
    expect(mocks.resolveCurrentPresence).not.toHaveBeenCalled();
  });

  it("returns 400 when no current presence resolves", async () => {
    mocks.resolveCurrentPresence.mockResolvedValue(null);

    const response = await request({ sessionId: "  s-1  " });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: "A current owned Session Mesh agentId or sessionId is required",
    });
    expect(mocks.resolveCurrentPresence).toHaveBeenCalledWith({
      organizationId: mocks.organizationId,
      userId: mocks.userId,
      agentId: undefined,
      sessionId: "s-1",
    });
    expect(mocks.rosterPage).not.toHaveBeenCalled();
  });

  it("forwards the resolved repository and omits continuation cursors", async () => {
    const response = await request({ agentId: " agent-1 ", revision: "  " });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        currentAgentId: "agent-1",
        currentWorkspace: { repository: "repo", revision: "rev-1" },
        roster: [{ agentId: "peer" }],
        inbox: [{ id: "d-1" }],
        subscription,
      },
    });
    expect(mocks.resolveCurrentPresence).toHaveBeenCalledWith({
      organizationId: mocks.organizationId,
      userId: mocks.userId,
      agentId: "agent-1",
      sessionId: undefined,
    });
    expect(mocks.rosterPage).toHaveBeenCalledWith(
      mocks.organizationId,
      { repository: "repo", revision: undefined },
      undefined
    );
    expect(mocks.deliveryHistoryPage).toHaveBeenCalledWith({
      organizationId: mocks.organizationId,
      userId: mocks.userId,
      agentId: "agent-1",
      cursor: undefined,
    });
    expect(mocks.subscription).toHaveBeenCalledWith({
      organizationId: mocks.organizationId,
      userId: mocks.userId,
      repository: "repo",
    });
  });

  it("forwards cursors and revision and echoes both next cursors", async () => {
    mocks.rosterPage.mockResolvedValue({
      agents: [],
      nextCursor: "agent-9",
    });
    mocks.deliveryHistoryPage.mockResolvedValue({
      messages: [],
      nextCursor: "d-9",
    });

    const response = await request({
      agentId: "agent-1",
      revision: " rev-2 ",
      cursor: "agent-5",
      inboxCursor: INBOX_CURSOR,
    });

    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      nextRosterCursor: "agent-9",
      nextInboxCursor: "d-9",
    });
    expect(mocks.rosterPage).toHaveBeenCalledWith(
      mocks.organizationId,
      { repository: "repo", revision: "rev-2" },
      "agent-5"
    );
    expect(mocks.deliveryHistoryPage).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: INBOX_CURSOR })
    );
  });

  it("returns a 500 when a read fails", async () => {
    mocks.subscription.mockRejectedValue(new Error("db down"));

    const response = await request({ agentId: "agent-1" });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      success: false,
      error: "Failed to read related Session Mesh work",
    });
  });
});
