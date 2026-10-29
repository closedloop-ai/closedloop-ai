import { Status } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, POST } from "./route";

const mocks = vi.hoisted(() => ({
  authOptions: [] as unknown[],
  userId: "0199a1b2-0000-7000-8000-000000000002",
  organizationId: "0199a1b2-0000-7000-8000-000000000001",
  rosterPage: vi.fn(),
  upsertPresence: vi.fn(),
  unregisterPresence: vi.fn(),
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
    rosterPage: mocks.rosterPage,
    upsertPresence: mocks.upsertPresence,
    unregisterPresence: mocks.unregisterPresence,
  },
}));

const URL_BASE = "https://api.example.test/session-mesh/presence";
const context = { params: Promise.resolve({}) };
const WRITE_SCOPE = { requiredScopes: ["write"] };

function jsonRequest(method: string, body: unknown) {
  return new NextRequest(URL_BASE, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /session-mesh/presence", () => {
  beforeEach(() => {
    mocks.rosterPage.mockResolvedValue({ agents: [] });
  });

  it("rejects a roster cursor longer than 500 characters", async () => {
    const response = await GET(
      new NextRequest(`${URL_BASE}?cursor=${"x".repeat(501)}`),
      context
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Invalid roster cursor",
    });
    expect(mocks.rosterPage).not.toHaveBeenCalled();
  });

  it("forwards trimmed filters and cursor to the roster page", async () => {
    mocks.rosterPage.mockResolvedValue({ agents: [], nextCursor: "a-2" });
    const query = new URLSearchParams({
      repository: " repo ",
      revision: " rev ",
      cursor: " a-1 ",
    });

    const response = await GET(
      new NextRequest(`${URL_BASE}?${query}`),
      context
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { agents: [], nextCursor: "a-2" },
    });
    expect(mocks.rosterPage).toHaveBeenCalledWith(
      mocks.organizationId,
      { repository: "repo", revision: "rev" },
      "a-1"
    );
  });

  it("forwards the caller org id with no filters or cursor", async () => {
    const response = await GET(new NextRequest(URL_BASE), context);

    expect(response.status).toBe(200);
    expect(mocks.rosterPage).toHaveBeenCalledWith(
      mocks.organizationId,
      { repository: undefined, revision: undefined },
      undefined
    );
  });
});

describe("POST /session-mesh/presence", () => {
  const presence = {
    agentId: "agent-1",
    workspace: { repository: "repo", revision: "rev" },
  };

  it("rejects an invalid presence body before writing", async () => {
    const response = await POST(
      jsonRequest("POST", { workspace: presence.workspace }),
      context
    );

    expect(response.status).toBe(400);
    expect(mocks.upsertPresence).not.toHaveBeenCalled();
  });

  it("maps a Forbidden upsert result to 403 session_mesh_agent_forbidden", async () => {
    mocks.upsertPresence.mockResolvedValue({
      ok: false,
      error: Status.Forbidden,
    });

    const response = await POST(jsonRequest("POST", presence), context);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      success: false,
      code: "session_mesh_agent_forbidden",
    });
  });

  it("upserts the validated presence and returns it", async () => {
    mocks.upsertPresence.mockResolvedValue({
      ok: true,
      value: { id: "p-1" },
    });

    const response = await POST(jsonRequest("POST", presence), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { presence: { id: "p-1" } },
    });
    expect(mocks.upsertPresence).toHaveBeenCalledWith(
      {
        organizationId: mocks.organizationId,
        userId: mocks.userId,
        presence: expect.objectContaining({
          agentId: "agent-1",
          harness: "unknown",
          expiresInSeconds: 90,
          workspace: expect.objectContaining({ paths: [], symbols: [] }),
        }),
      },
      undefined
    );
  });
});

describe("DELETE /session-mesh/presence", () => {
  it("rejects a body without an agent id", async () => {
    const response = await DELETE(jsonRequest("DELETE", {}), context);

    expect(response.status).toBe(400);
    expect(mocks.unregisterPresence).not.toHaveBeenCalled();
  });

  it("forwards the trimmed agent id and reports the removed count", async () => {
    mocks.unregisterPresence.mockResolvedValue({ count: 1 });

    const response = await DELETE(
      jsonRequest("DELETE", { agentId: " agent-1 " }),
      context
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { removed: 1 },
    });
    expect(mocks.unregisterPresence).toHaveBeenCalledWith(
      {
        organizationId: mocks.organizationId,
        userId: mocks.userId,
        agentId: "agent-1",
      },
      undefined
    );
  });
});

describe("session mesh auth wiring", () => {
  it("passes the write scope to the auth wrapper for mutating handlers", () => {
    expect(mocks.authOptions).toEqual([undefined, WRITE_SCOPE, WRITE_SCOPE]);
  });
});

describe("presence route boundaries and failures", () => {
  it("accepts a roster cursor of exactly 500 characters", async () => {
    mocks.rosterPage.mockResolvedValue({ agents: [] });
    const cursor = "x".repeat(500);

    const response = await GET(
      new NextRequest(`${URL_BASE}?cursor=${cursor}`),
      context
    );

    expect(response.status).toBe(200);
    expect(mocks.rosterPage).toHaveBeenCalledWith(
      mocks.organizationId,
      { repository: undefined, revision: undefined },
      cursor
    );
  });

  it.each([
    ["GET", "Failed to read Session Mesh presence"],
    ["POST", "Failed to update Session Mesh presence"],
    ["DELETE", "Failed to unregister Session Mesh presence"],
  ] as const)(
    "returns a 500 when %s fails in the service",
    async (method, error) => {
      const failure = new Error("db down");
      mocks.rosterPage.mockRejectedValue(failure);
      mocks.upsertPresence.mockRejectedValue(failure);
      mocks.unregisterPresence.mockRejectedValue(failure);
      const handler = { GET, POST, DELETE }[method];
      const body = {
        agentId: "agent-1",
        workspace: { repository: "repo", revision: "rev" },
      };

      const response = await handler(
        method === "GET"
          ? new NextRequest(URL_BASE)
          : jsonRequest(method, body),
        context
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ success: false, error });
    }
  );
});
