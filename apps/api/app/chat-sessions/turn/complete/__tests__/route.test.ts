/**
 * Route tests for POST /chat-sessions/turn/complete.
 *
 * Covers chat-runner token authentication, body validation (including the
 * both-or-neither sessionId + sessionSourceId refinement), the chatKey
 * binding check, and the service-result → HTTP status mapping for
 * notFound, conflict and successful completions.
 */
import { vi } from "vitest";

// --- Mocks (must come before imports) ---

const { mockAuthenticateChatRunner } = vi.hoisted(() => ({
  mockAuthenticateChatRunner: vi.fn(),
}));

vi.mock("@repo/auth/chat-runner-jwt", () => ({
  authenticateChatRunner: mockAuthenticateChatRunner,
}));

vi.mock("../../../service", async () => {
  const actual =
    await vi.importActual<typeof import("../../../service")>(
      "../../../service"
    );
  return {
    ...actual,
    chatSessionsService: {
      findByKey: vi.fn(),
      create: vi.fn(),
      appendMessages: vi.fn(),
      deleteChat: vi.fn(),
      upsertTurn: vi.fn(),
      appendAssistantTurn: vi.fn(),
    },
  };
});

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// --- Imports (after mocks) ---

import { beforeEach, describe, expect, it } from "vitest";
import { createMockRequest } from "../../../../../__tests__/utils/auth-helpers";
import { chatSessionsService } from "../../../service";
import { POST } from "../route";

const ORG_ID = "test-org-id";
const USER_ID = "test-user-id";
const CHAT_KEY = "artifact:plan-123";

const VALID_CLAIMS = {
  userId: USER_ID,
  organizationId: ORG_ID,
  chatKey: CHAT_KEY,
  tokenId: "jti-1",
  audience: "closedloop-chat-runner",
  issuer: "closedloop-api",
  issuedAt: 0,
  expiresAt: 0,
};

const ASSISTANT_MESSAGE = {
  id: "asst-1",
  role: "assistant" as const,
  content: "hi back",
  timestamp: "2026-04-12T00:00:01.000Z",
};

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    chatKey: CHAT_KEY,
    provider: "claude",
    messages: [ASSISTANT_MESSAGE],
    sessionId: null,
    sessionSourceId: null,
    ...overrides,
  };
}

function buildChatRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "chat-uuid",
    chatKey: CHAT_KEY,
    userId: USER_ID,
    organizationId: ORG_ID,
    provider: "claude",
    model: "claude-sonnet-4-5",
    messages: [ASSISTANT_MESSAGE],
    sessionId: null,
    sessionSourceId: null,
    context: null,
    createdAt: new Date("2026-04-12T00:00:00.000Z"),
    updatedAt: new Date("2026-04-12T00:00:00.000Z"),
    ...overrides,
  };
}

function bearerHeaders() {
  return { authorization: "Bearer test-token" };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticateChatRunner.mockResolvedValue(VALID_CLAIMS);
});

describe("POST /chat-sessions/turn/complete", () => {
  it("returns 200 and the updated chat on the happy path", async () => {
    vi.mocked(chatSessionsService.appendAssistantTurn).mockResolvedValue({
      ok: true,
      value: {
        chat: buildChatRow({
          sessionId: "sess-xyz",
          sessionSourceId: "gateway-abc",
        }) as never,
      },
    });

    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/chat-sessions/turn/complete",
        method: "POST",
        body: validBody({
          sessionId: "sess-xyz",
          sessionSourceId: "gateway-abc",
        }),
        headers: bearerHeaders(),
      })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.chat?.id).toBe("chat-uuid");
    expect(json.data.chat?.sessionId).toBe("sess-xyz");
    expect(chatSessionsService.appendAssistantTurn).toHaveBeenCalledWith(
      USER_ID,
      validBody({
        sessionId: "sess-xyz",
        sessionSourceId: "gateway-abc",
      })
    );
  });

  it("returns 401 when Authorization header is missing", async () => {
    mockAuthenticateChatRunner.mockResolvedValue(null);

    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/chat-sessions/turn/complete",
        method: "POST",
        body: validBody(),
      })
    );

    expect(response.status).toBe(401);
    expect(chatSessionsService.appendAssistantTurn).not.toHaveBeenCalled();
  });

  it("returns 401 when token verification throws", async () => {
    mockAuthenticateChatRunner.mockRejectedValue(new Error("bad token"));

    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/chat-sessions/turn/complete",
        method: "POST",
        body: validBody(),
        headers: bearerHeaders(),
      })
    );

    expect(response.status).toBe(401);
  });

  it("returns 403 when claims.chatKey does not match body.chatKey", async () => {
    mockAuthenticateChatRunner.mockResolvedValue({
      ...VALID_CLAIMS,
      chatKey: "artifact:other-plan",
    });

    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/chat-sessions/turn/complete",
        method: "POST",
        body: validBody(),
        headers: bearerHeaders(),
      })
    );

    expect(response.status).toBe(403);
    expect(chatSessionsService.appendAssistantTurn).not.toHaveBeenCalled();
  });

  it("returns 400 when body fails validation", async () => {
    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/chat-sessions/turn/complete",
        method: "POST",
        body: { chatKey: CHAT_KEY, provider: "claude" },
        headers: bearerHeaders(),
      })
    );

    expect(response.status).toBe(400);
    expect(chatSessionsService.appendAssistantTurn).not.toHaveBeenCalled();
  });

  it("returns 400 when sessionId is set but sessionSourceId is null", async () => {
    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/chat-sessions/turn/complete",
        method: "POST",
        body: validBody({
          sessionId: "sess-xyz",
          sessionSourceId: null,
        }),
        headers: bearerHeaders(),
      })
    );

    expect(response.status).toBe(400);
    expect(chatSessionsService.appendAssistantTurn).not.toHaveBeenCalled();
  });

  it("returns 400 when sessionSourceId is set but sessionId is null", async () => {
    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/chat-sessions/turn/complete",
        method: "POST",
        body: validBody({
          sessionId: null,
          sessionSourceId: "gateway-abc",
        }),
        headers: bearerHeaders(),
      })
    );

    expect(response.status).toBe(400);
    expect(chatSessionsService.appendAssistantTurn).not.toHaveBeenCalled();
  });

  it("returns 404 when service reports notFound", async () => {
    vi.mocked(chatSessionsService.appendAssistantTurn).mockResolvedValue({
      ok: false,
      error: { kind: "notFound" },
    });

    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/chat-sessions/turn/complete",
        method: "POST",
        body: validBody(),
        headers: bearerHeaders(),
      })
    );

    expect(response.status).toBe(404);
  });

  it("returns 409 with boundProvider when service reports a provider conflict", async () => {
    vi.mocked(chatSessionsService.appendAssistantTurn).mockResolvedValue({
      ok: false,
      error: { kind: "providerConflict", boundProvider: "codex" },
    });

    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/chat-sessions/turn/complete",
        method: "POST",
        body: validBody(),
        headers: bearerHeaders(),
      })
    );

    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.boundProvider).toBe("codex");
    expect(JSON.stringify(json)).toContain("codex");
  });
});
