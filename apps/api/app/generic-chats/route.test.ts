import { vi } from "vitest";

// --- Mocks (must come before imports) ---

let mockAuthContext: import("@/lib/auth/with-auth").AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context?.params),
}));

vi.mock("./service", async () => {
  const actual = await vi.importActual<typeof import("./service")>("./service");
  return {
    ...actual,
    genericChatsService: {
      findByKey: vi.fn(),
      create: vi.fn(),
      appendMessages: vi.fn(),
      deleteChat: vi.fn(),
    },
  };
});

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// --- Imports (after mocks) ---

import { beforeEach, describe, expect, it } from "vitest";
import {
  createMockRequest,
  createTestAuthContext,
} from "../../__tests__/utils/auth-helpers";
import { DELETE, GET, PATCH, POST } from "./route";
import { genericChatsService } from "./service";

const ORG_ID = "test-org-id";
const USER_ID = "test-user-id";
const OTHER_USER_ID = "other-user-id";
const CHAT_KEY = "artifact:plan-123";

const SAMPLE_USER_MESSAGE = {
  id: "user-1",
  role: "user" as const,
  content: "hello",
  timestamp: "2026-04-12T00:00:00.000Z",
};

const SAMPLE_ASSISTANT_MESSAGE = {
  id: "asst-1",
  role: "assistant" as const,
  content: "hi back",
  timestamp: "2026-04-12T00:00:01.000Z",
};

function buildChatRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "chat-uuid",
    chatKey: CHAT_KEY,
    userId: USER_ID,
    organizationId: ORG_ID,
    provider: "claude",
    model: "claude-sonnet-4-5",
    messages: [SAMPLE_USER_MESSAGE],
    sessionId: null,
    context: null,
    createdAt: new Date("2026-04-12T00:00:00.000Z"),
    updatedAt: new Date("2026-04-12T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext({
    user: {
      id: USER_ID,
      organizationId: ORG_ID,
    } as any,
  });
});

describe("GET /generic-chats", () => {
  it("returns 400 when chatKey is missing", async () => {
    const response = await GET(
      createMockRequest({
        url: "http://localhost:3002/generic-chats",
      }),
      {} as any
    );
    expect(response.status).toBe(400);
    expect(genericChatsService.findByKey).not.toHaveBeenCalled();
  });

  it("returns chat: null when no row exists for the user", async () => {
    vi.mocked(genericChatsService.findByKey).mockResolvedValue(null);

    const response = await GET(
      createMockRequest({
        url: `http://localhost:3002/generic-chats?chatKey=${encodeURIComponent(CHAT_KEY)}`,
      }),
      {} as any
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.chat).toBeNull();
    expect(genericChatsService.findByKey).toHaveBeenCalledWith(
      USER_ID,
      CHAT_KEY
    );
  });

  it("returns chat: null when the row belongs to a different user", async () => {
    vi.mocked(genericChatsService.findByKey).mockResolvedValue(
      buildChatRow({ userId: OTHER_USER_ID }) as any
    );

    const response = await GET(
      createMockRequest({
        url: `http://localhost:3002/generic-chats?chatKey=${encodeURIComponent(CHAT_KEY)}`,
      }),
      {} as any
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.chat).toBeNull();
  });

  it("returns the chat when the row belongs to the caller", async () => {
    vi.mocked(genericChatsService.findByKey).mockResolvedValue(
      buildChatRow() as any
    );

    const response = await GET(
      createMockRequest({
        url: `http://localhost:3002/generic-chats?chatKey=${encodeURIComponent(CHAT_KEY)}`,
      }),
      {} as any
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.chat?.id).toBe("chat-uuid");
    expect(json.data.chat?.chatKey).toBe(CHAT_KEY);
  });
});

describe("POST /generic-chats — reconciliation", () => {
  it("POST existing chat returns reconciled row", async () => {
    const reconciledRow = buildChatRow({
      messages: [SAMPLE_USER_MESSAGE, SAMPLE_ASSISTANT_MESSAGE],
    });
    vi.mocked(genericChatsService.create).mockResolvedValue(
      reconciledRow as any
    );

    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/generic-chats",
        method: "POST",
        body: {
          chatKey: CHAT_KEY,
          provider: "claude",
          model: "claude-sonnet-4-5",
          messages: [SAMPLE_USER_MESSAGE, SAMPLE_ASSISTANT_MESSAGE],
        },
      }),
      {} as any
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.chat?.id).toBe("chat-uuid");
    expect(json.data.chat?.messages).toHaveLength(2);
    expect(json.data.chat?.messages[0].id).toBe(SAMPLE_USER_MESSAGE.id);
    expect(json.data.chat?.messages[1].id).toBe(SAMPLE_ASSISTANT_MESSAGE.id);
    expect(genericChatsService.create).toHaveBeenCalledTimes(1);
    expect(genericChatsService.create).toHaveBeenCalledWith({
      userId: USER_ID,
      organizationId: ORG_ID,
      chatKey: CHAT_KEY,
      provider: "claude",
      model: "claude-sonnet-4-5",
      context: undefined,
      messages: [SAMPLE_USER_MESSAGE, SAMPLE_ASSISTANT_MESSAGE],
    });
  });
});

describe("POST /generic-chats", () => {
  it("returns 400 when body fails validation", async () => {
    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/generic-chats",
        method: "POST",
        body: { provider: "claude" },
      }),
      {} as any
    );
    expect(response.status).toBe(400);
    expect(genericChatsService.create).not.toHaveBeenCalled();
  });

  it("returns 400 when provider is not claude or codex", async () => {
    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/generic-chats",
        method: "POST",
        body: {
          chatKey: CHAT_KEY,
          provider: "gemini",
          model: "g-pro",
        },
      }),
      {} as any
    );
    expect(response.status).toBe(400);
    expect(genericChatsService.create).not.toHaveBeenCalled();
  });

  it("creates a chat and returns the row", async () => {
    vi.mocked(genericChatsService.create).mockResolvedValue(
      buildChatRow() as any
    );

    const response = await POST(
      createMockRequest({
        url: "http://localhost:3002/generic-chats",
        method: "POST",
        body: {
          chatKey: CHAT_KEY,
          provider: "claude",
          model: "claude-sonnet-4-5",
          context: "doc-context",
          messages: [SAMPLE_USER_MESSAGE],
        },
      }),
      {} as any
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.chat?.id).toBe("chat-uuid");
    expect(genericChatsService.create).toHaveBeenCalledWith({
      userId: USER_ID,
      organizationId: ORG_ID,
      chatKey: CHAT_KEY,
      provider: "claude",
      model: "claude-sonnet-4-5",
      context: "doc-context",
      messages: [SAMPLE_USER_MESSAGE],
    });
  });
});

describe("PATCH /generic-chats", () => {
  it("returns 400 when messages array is empty", async () => {
    const response = await PATCH(
      createMockRequest({
        url: "http://localhost:3002/generic-chats",
        method: "PATCH",
        body: {
          chatKey: CHAT_KEY,
          provider: "claude",
          messages: [],
        },
      }),
      {} as any
    );
    expect(response.status).toBe(400);
    expect(genericChatsService.appendMessages).not.toHaveBeenCalled();
  });

  it("returns 404 when service reports notFound", async () => {
    vi.mocked(genericChatsService.appendMessages).mockResolvedValue({
      notFound: true,
    } as any);

    const response = await PATCH(
      createMockRequest({
        url: "http://localhost:3002/generic-chats",
        method: "PATCH",
        body: {
          chatKey: CHAT_KEY,
          provider: "claude",
          messages: [SAMPLE_ASSISTANT_MESSAGE],
        },
      }),
      {} as any
    );
    expect(response.status).toBe(404);
  });

  it("returns 409 when service reports a provider conflict", async () => {
    vi.mocked(genericChatsService.appendMessages).mockResolvedValue({
      conflict: true,
      boundProvider: "codex",
    } as any);

    const response = await PATCH(
      createMockRequest({
        url: "http://localhost:3002/generic-chats",
        method: "PATCH",
        body: {
          chatKey: CHAT_KEY,
          provider: "claude",
          messages: [SAMPLE_ASSISTANT_MESSAGE],
        },
      }),
      {} as any
    );
    expect(response.status).toBe(409);
    const json = await response.json();
    expect(JSON.stringify(json)).toContain("codex");
  });

  it("returns the updated chat when service succeeds", async () => {
    const updated = buildChatRow({
      messages: [SAMPLE_USER_MESSAGE, SAMPLE_ASSISTANT_MESSAGE],
      sessionId: "sess-1",
    });
    vi.mocked(genericChatsService.appendMessages).mockResolvedValue({
      chat: updated,
    } as any);

    const response = await PATCH(
      createMockRequest({
        url: "http://localhost:3002/generic-chats",
        method: "PATCH",
        body: {
          chatKey: CHAT_KEY,
          provider: "claude",
          messages: [SAMPLE_ASSISTANT_MESSAGE],
          sessionId: "sess-1",
        },
      }),
      {} as any
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.chat?.sessionId).toBe("sess-1");
    expect(json.data.chat?.messages).toHaveLength(2);
    expect(genericChatsService.appendMessages).toHaveBeenCalledWith(
      USER_ID,
      CHAT_KEY,
      "claude",
      [SAMPLE_ASSISTANT_MESSAGE],
      "sess-1"
    );
  });

  it("PATCH idempotency — duplicate message id is a no-op", async () => {
    const existingRow = buildChatRow({
      messages: [SAMPLE_USER_MESSAGE, SAMPLE_ASSISTANT_MESSAGE],
    });

    // First PATCH: service appends the new assistant message
    vi.mocked(genericChatsService.appendMessages).mockResolvedValueOnce({
      chat: existingRow,
    } as any);

    const patchBody = {
      chatKey: CHAT_KEY,
      provider: "claude",
      messages: [SAMPLE_ASSISTANT_MESSAGE],
    };

    const firstResponse = await PATCH(
      createMockRequest({
        url: "http://localhost:3002/generic-chats",
        method: "PATCH",
        body: patchBody,
      }),
      {} as any
    );

    expect(firstResponse.status).toBe(200);
    const firstJson = await firstResponse.json();
    expect(firstJson.data.chat?.messages).toHaveLength(2);
    const firstIds = firstJson.data.chat?.messages.map(
      (m: { id: string }) => m.id
    );
    expect(firstIds).toContain(SAMPLE_ASSISTANT_MESSAGE.id);

    // Second PATCH with identical body: service dedupes and returns unchanged row
    vi.mocked(genericChatsService.appendMessages).mockResolvedValueOnce({
      chat: existingRow,
    } as any);

    const secondResponse = await PATCH(
      createMockRequest({
        url: "http://localhost:3002/generic-chats",
        method: "PATCH",
        body: patchBody,
      }),
      {} as any
    );

    expect(secondResponse.status).toBe(200);
    const secondJson = await secondResponse.json();
    // The id still appears exactly once — service deduped
    const secondMessages = secondJson.data.chat?.messages as Array<{
      id: string;
    }>;
    const matchingIds = secondMessages.filter(
      (m) => m.id === SAMPLE_ASSISTANT_MESSAGE.id
    );
    expect(matchingIds).toHaveLength(1);

    // Service called twice total (once per PATCH)
    expect(genericChatsService.appendMessages).toHaveBeenCalledTimes(2);
  });
});

describe("DELETE /generic-chats", () => {
  it("returns 400 when chatKey is missing", async () => {
    const response = await DELETE(
      createMockRequest({
        url: "http://localhost:3002/generic-chats",
        method: "DELETE",
      }),
      {} as any
    );
    expect(response.status).toBe(400);
    expect(genericChatsService.deleteChat).not.toHaveBeenCalled();
  });

  it("returns deleted: true when service deletes a row", async () => {
    vi.mocked(genericChatsService.deleteChat).mockResolvedValue(true);

    const response = await DELETE(
      createMockRequest({
        url: `http://localhost:3002/generic-chats?chatKey=${encodeURIComponent(CHAT_KEY)}`,
        method: "DELETE",
      }),
      {} as any
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.deleted).toBe(true);
    expect(genericChatsService.deleteChat).toHaveBeenCalledWith(
      USER_ID,
      CHAT_KEY
    );
  });

  it("returns deleted: false when no matching row exists", async () => {
    vi.mocked(genericChatsService.deleteChat).mockResolvedValue(false);

    const response = await DELETE(
      createMockRequest({
        url: `http://localhost:3002/generic-chats?chatKey=${encodeURIComponent(CHAT_KEY)}`,
        method: "DELETE",
      }),
      {} as any
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.deleted).toBe(false);
  });
});
