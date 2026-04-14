/**
 * Route tests for POST /chat-sessions/turn.
 *
 * Covers chat-runner token authentication, body validation, the chatKey
 * binding check, and the service-result → HTTP status mapping for
 * conflicts and successful upserts.
 */
import { vi } from "vitest";

// --- Mocks (must come before imports) ---

const { mockAuthenticateChatRunner } = vi.hoisted(() => ({
  mockAuthenticateChatRunner: vi.fn(),
}));

vi.mock("@repo/auth/chat-runner-jwt", () => ({
  authenticateChatRunner: mockAuthenticateChatRunner,
}));

vi.mock("../../service", async () => {
  const actual =
    await vi.importActual<typeof import("../../service")>("../../service");
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
import { createMockRequest } from "../../../../__tests__/utils/auth-helpers";
import { chatSessionsService } from "../../service";
import { POST } from "../route";

const ORG_ID = "test-org-id";
const USER_ID = "test-user-id";
const CHAT_KEY = "artifact:plan-123";
const GATEWAY_ID = "gateway-abc";

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

const USER_MESSAGE = {
  id: "user-1",
  role: "user" as const,
  content: "hello",
  timestamp: "2026-04-12T00:00:00.000Z",
};

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    chatKey: CHAT_KEY,
    userMessage: USER_MESSAGE,
    provider: "claude",
    model: "claude-sonnet-4-5",
    sourceGatewayId: GATEWAY_ID,
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
    messages: [USER_MESSAGE],
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

describe("POST /chat-sessions/turn", () => {
  it("returns 200 and the chat row on the happy path", async () => {
    vi.mocked(chatSessionsService.upsertTurn).mockResolvedValue({
      conflict: false,
      chat: buildChatRow() as never,
      resumeSessionId: null,
    });

    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/chat-sessions/turn",
        method: "POST",
        body: validBody(),
        headers: bearerHeaders(),
      })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.chat?.id).toBe("chat-uuid");
    expect(json.data.resumeSessionId).toBeNull();
    expect(chatSessionsService.upsertTurn).toHaveBeenCalledWith(
      USER_ID,
      ORG_ID,
      validBody()
    );
  });

  it("propagates resumeSessionId from the service", async () => {
    vi.mocked(chatSessionsService.upsertTurn).mockResolvedValue({
      conflict: false,
      chat: buildChatRow({
        sessionId: "sess-xyz",
        sessionSourceId: GATEWAY_ID,
      }) as never,
      resumeSessionId: "sess-xyz",
    });

    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/chat-sessions/turn",
        method: "POST",
        body: validBody(),
        headers: bearerHeaders(),
      })
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.resumeSessionId).toBe("sess-xyz");
  });

  it("returns 401 when Authorization header is missing", async () => {
    mockAuthenticateChatRunner.mockResolvedValue(null);

    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/chat-sessions/turn",
        method: "POST",
        body: validBody(),
      })
    );

    expect(response.status).toBe(401);
    expect(chatSessionsService.upsertTurn).not.toHaveBeenCalled();
  });

  it("returns 401 when the token fails verification", async () => {
    mockAuthenticateChatRunner.mockRejectedValue(new Error("bad signature"));

    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/chat-sessions/turn",
        method: "POST",
        body: validBody(),
        headers: bearerHeaders(),
      })
    );

    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.error).toContain("Invalid");
    expect(chatSessionsService.upsertTurn).not.toHaveBeenCalled();
  });

  it("returns 403 when claims.chatKey does not match body.chatKey", async () => {
    mockAuthenticateChatRunner.mockResolvedValue({
      ...VALID_CLAIMS,
      chatKey: "artifact:other-plan",
    });

    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/chat-sessions/turn",
        method: "POST",
        body: validBody(),
        headers: bearerHeaders(),
      })
    );

    expect(response.status).toBe(403);
    expect(chatSessionsService.upsertTurn).not.toHaveBeenCalled();
  });

  it("returns 400 when body is missing required fields", async () => {
    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/chat-sessions/turn",
        method: "POST",
        body: { chatKey: CHAT_KEY },
        headers: bearerHeaders(),
      })
    );

    expect(response.status).toBe(400);
    expect(chatSessionsService.upsertTurn).not.toHaveBeenCalled();
  });

  it("returns 400 when userMessage.role is not 'user'", async () => {
    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/chat-sessions/turn",
        method: "POST",
        body: validBody({
          userMessage: { ...USER_MESSAGE, role: "assistant" },
        }),
        headers: bearerHeaders(),
      })
    );

    expect(response.status).toBe(400);
    expect(chatSessionsService.upsertTurn).not.toHaveBeenCalled();
  });

  it("returns 409 with boundProvider when service reports a provider conflict", async () => {
    vi.mocked(chatSessionsService.upsertTurn).mockResolvedValue({
      conflict: true,
      boundProvider: "codex",
    });

    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/chat-sessions/turn",
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
