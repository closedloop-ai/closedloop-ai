/**
 * Unit tests for chatSessionsService.
 *
 * Covers access-control (userId scoping), id-based message reconciliation
 * (create + appendMessages), provider lock enforcement, idempotent delete,
 * and the no-op branches that avoid bumping `updatedAt`.
 */
import { type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

import type { ChatMessage } from "@repo/api/src/types/chat-session";
import type { Result } from "@repo/api/src/types/result";
import type { ChatSession } from "@repo/database";
import { withDb } from "@repo/database";
import { type CreateChatSessionInput, chatSessionsService } from "../service";

/**
 * Asserts `result.ok === true` and returns the value. Keeps test
 * assertions terse without losing type safety.
 */
function unwrapOk<T, E>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`Expected ok, got error: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

/**
 * Unwraps `chatSessionsService.create()` for tests that assume the happy
 * path. Throws if the service reports a provider conflict, letting tests
 * keep their existing assertions on `.id`, `.updatedAt`, etc. Tests that
 * intentionally exercise the conflict branch call `chatSessionsService.create`
 * directly.
 */
async function createChat(input: CreateChatSessionInput): Promise<ChatSession> {
  const result = await chatSessionsService.create(input);
  return unwrapOk(result).chat;
}

type Row = {
  id: string;
  chatKey: string;
  userId: string;
  organizationId: string;
  provider: string;
  model: string;
  messages: ChatMessage[];
  sessionId: string | null;
  sessionSourceId: string | null;
  context: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const mockWithDb = withDb as unknown as Mock;

/** Cast `messages` (typed as `JsonValue` by Prisma) to the ChatMessage[] shape. */
function msgs(chat: { messages: unknown }): ChatMessage[] {
  return chat.messages as ChatMessage[];
}

const ORG_A = "org-a";
const ORG_B = "org-b";
const USER_A = "user-a";
const USER_B = "user-b";

const store = new Map<string, Row>();
let idCounter = 0;
let nowCounter = 0;

let mockCreate: Mock;
let mockUpdate: Mock;
let mockFindUnique: Mock;
let mockDeleteMany: Mock;

const keyOf = (userId: string, chatKey: string) => `${userId}::${chatKey}`;

/** Monotonically-increasing clock so that `updatedAt` comparisons are stable. */
function nextDate(): Date {
  nowCounter += 1;
  return new Date(2020, 0, 1, 0, 0, 0, nowCounter);
}

function buildMockDb() {
  mockFindUnique = vi.fn(
    (args: {
      where: { userId_chatKey: { userId: string; chatKey: string } };
    }) => {
      const { userId, chatKey } = args.where.userId_chatKey;
      const row = store.get(keyOf(userId, chatKey));
      return row ? { ...row, messages: [...row.messages] } : null;
    }
  );

  mockCreate = vi.fn((args: { data: Record<string, unknown> }) => {
    const data = args.data;
    idCounter += 1;
    const now = nextDate();
    const row: Row = {
      id: `chat-${idCounter}`,
      chatKey: data.chatKey as string,
      userId: data.userId as string,
      organizationId: data.organizationId as string,
      provider: data.provider as string,
      model: data.model as string,
      messages: ((data.messages ?? []) as ChatMessage[]).slice(),
      sessionId: (data.sessionId as string | null) ?? null,
      sessionSourceId: (data.sessionSourceId as string | null) ?? null,
      context: (data.context as string | null) ?? null,
      createdAt: now,
      updatedAt: now,
    };
    store.set(keyOf(row.userId, row.chatKey), row);
    return { ...row, messages: [...row.messages] };
  });

  mockUpdate = vi.fn(
    (args: {
      where: { userId_chatKey: { userId: string; chatKey: string } };
      data: Record<string, unknown>;
    }) => {
      const { userId, chatKey } = args.where.userId_chatKey;
      const existing = store.get(keyOf(userId, chatKey));
      if (!existing) {
        throw new Error(`Row not found: ${userId}/${chatKey}`);
      }
      const updated: Row = {
        ...existing,
        messages:
          args.data.messages === undefined
            ? existing.messages
            : ([...(args.data.messages as ChatMessage[])] as ChatMessage[]),
        sessionId:
          args.data.sessionId === undefined
            ? existing.sessionId
            : (args.data.sessionId as string | null),
        sessionSourceId:
          args.data.sessionSourceId === undefined
            ? existing.sessionSourceId
            : (args.data.sessionSourceId as string | null),
        updatedAt: nextDate(),
      };
      store.set(keyOf(userId, chatKey), updated);
      return { ...updated, messages: [...updated.messages] };
    }
  );

  mockDeleteMany = vi.fn(
    (args: { where: { userId: string; chatKey: string } }) => {
      const { userId, chatKey } = args.where;
      const k = keyOf(userId, chatKey);
      if (store.has(k)) {
        store.delete(k);
        return { count: 1 };
      }
      return { count: 0 };
    }
  );

  return {
    chatSession: {
      findUnique: mockFindUnique,
      create: mockCreate,
      update: mockUpdate,
      deleteMany: mockDeleteMany,
    },
  };
}

beforeEach(() => {
  store.clear();
  idCounter = 0;
  nowCounter = 0;
  const db = buildMockDb();
  mockWithDb.mockImplementation((callback: (database: unknown) => unknown) =>
    callback(db)
  );
  (withDb as unknown as { tx: Mock }).tx = vi.fn(
    (callback: (tx: unknown) => unknown) => callback(db)
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// findByKey
// ---------------------------------------------------------------------------

describe("chatSessionsService.findByKey", () => {
  it("returns each user's own row when two users share a chatKey", async () => {
    await createChat({
      userId: USER_A,
      organizationId: ORG_A,
      chatKey: "artifact:pln-1",
      provider: "claude",
      model: "claude-sonnet-4-5",
      messages: [
        { id: "m-a", role: "user", content: "hi from A", timestamp: "t1" },
      ],
    });
    await createChat({
      userId: USER_B,
      organizationId: ORG_B,
      chatKey: "artifact:pln-1",
      provider: "codex",
      model: "gpt-5.3-codex",
      messages: [
        { id: "m-b", role: "user", content: "hi from B", timestamp: "t1" },
      ],
    });

    const rowA = await chatSessionsService.findByKey(USER_A, "artifact:pln-1");
    const rowB = await chatSessionsService.findByKey(USER_B, "artifact:pln-1");

    expect(rowA?.userId).toBe(USER_A);
    expect(rowA?.provider).toBe("claude");
    expect(rowB?.userId).toBe(USER_B);
    expect(rowB?.provider).toBe("codex");
  });

  it("returns null for a chatKey that does not exist", async () => {
    const row = await chatSessionsService.findByKey(USER_A, "missing");
    expect(row).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe("chatSessionsService.create", () => {
  const CHAT_KEY = "artifact:pln-1";

  it("stores the initial user message on first create", async () => {
    const row = await createChat({
      userId: USER_A,
      organizationId: ORG_A,
      chatKey: CHAT_KEY,
      provider: "claude",
      model: "claude-sonnet-4-5",
      messages: [{ id: "u1", role: "user", content: "hello", timestamp: "t1" }],
    });

    expect(msgs(row)).toEqual([
      { id: "u1", role: "user", content: "hello", timestamp: "t1" },
    ]);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("returns the existing row unchanged when called twice with identical messages", async () => {
    const first = await createChat({
      userId: USER_A,
      organizationId: ORG_A,
      chatKey: CHAT_KEY,
      provider: "claude",
      model: "claude-sonnet-4-5",
      messages: [{ id: "u1", role: "user", content: "hello", timestamp: "t1" }],
    });

    const second = await createChat({
      userId: USER_A,
      organizationId: ORG_A,
      chatKey: CHAT_KEY,
      provider: "claude",
      model: "claude-sonnet-4-5",
      messages: [{ id: "u1", role: "user", content: "hello", timestamp: "t1" }],
    });

    expect(second.id).toBe(first.id);
    expect(msgs(second)).toEqual(msgs(first));
    expect(second.updatedAt).toEqual(first.updatedAt);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("reconciles by id when called again with a stale-read message list", async () => {
    await createChat({
      userId: USER_A,
      organizationId: ORG_A,
      chatKey: CHAT_KEY,
      provider: "claude",
      model: "claude-sonnet-4-5",
      messages: [{ id: "u1", role: "user", content: "msg A", timestamp: "t1" }],
    });

    const second = await createChat({
      userId: USER_A,
      organizationId: ORG_A,
      chatKey: CHAT_KEY,
      provider: "claude",
      model: "claude-sonnet-4-5",
      messages: [
        { id: "u1", role: "user", content: "msg A", timestamp: "t1" },
        { id: "u2", role: "user", content: "msg B", timestamp: "t2" },
      ],
    });

    expect(msgs(second).map((m) => m.id)).toEqual(["u1", "u2"]);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it("appends only the new message ids when the existing row has a subset", async () => {
    await createChat({
      userId: USER_A,
      organizationId: ORG_A,
      chatKey: CHAT_KEY,
      provider: "claude",
      model: "claude-sonnet-4-5",
      messages: [{ id: "u1", role: "user", content: "first", timestamp: "t1" }],
    });

    const second = await createChat({
      userId: USER_A,
      organizationId: ORG_A,
      chatKey: CHAT_KEY,
      provider: "claude",
      model: "claude-sonnet-4-5",
      messages: [
        { id: "u2", role: "user", content: "second", timestamp: "t2" },
        { id: "u3", role: "user", content: "third", timestamp: "t3" },
      ],
    });

    expect(msgs(second).map((m) => m.id)).toEqual(["u1", "u2", "u3"]);
  });

  it("returns the existing row unchanged when caller supplies only already-present ids", async () => {
    const first = await createChat({
      userId: USER_A,
      organizationId: ORG_A,
      chatKey: CHAT_KEY,
      provider: "claude",
      model: "claude-sonnet-4-5",
      messages: [
        { id: "u1", role: "user", content: "a", timestamp: "t1" },
        { id: "u2", role: "user", content: "b", timestamp: "t2" },
      ],
    });

    mockUpdate.mockClear();

    const second = await createChat({
      userId: USER_A,
      organizationId: ORG_A,
      chatKey: CHAT_KEY,
      provider: "claude",
      model: "claude-sonnet-4-5",
      messages: [{ id: "u2", role: "user", content: "b", timestamp: "t2" }],
    });

    expect(msgs(second)).toEqual(msgs(first));
    expect(second.updatedAt).toEqual(first.updatedAt);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("creates a row with an empty messages array when the messages parameter is omitted", async () => {
    const row = await createChat({
      userId: USER_A,
      organizationId: ORG_A,
      chatKey: CHAT_KEY,
      provider: "claude",
      model: "claude-sonnet-4-5",
    });

    expect(msgs(row)).toEqual([]);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("stores an explicit context string on the created row", async () => {
    const row = await createChat({
      userId: USER_A,
      organizationId: ORG_A,
      chatKey: CHAT_KEY,
      provider: "claude",
      model: "claude-sonnet-4-5",
      context: "You are a helpful assistant working on feature PLN-1.",
    });

    expect(row.context).toBe(
      "You are a helpful assistant working on feature PLN-1."
    );
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("returns { conflict, boundProvider } when an existing chat was bound to a different provider", async () => {
    await createChat({
      userId: USER_A,
      organizationId: ORG_A,
      chatKey: CHAT_KEY,
      provider: "claude",
      model: "claude-sonnet-4-5",
      messages: [{ id: "u1", role: "user", content: "hi", timestamp: "t1" }],
    });

    mockUpdate.mockClear();

    const result = await chatSessionsService.create({
      userId: USER_A,
      organizationId: ORG_A,
      chatKey: CHAT_KEY,
      provider: "codex",
      model: "gpt-5.3-codex",
      messages: [
        { id: "u2", role: "user", content: "new provider", timestamp: "t2" },
      ],
    });

    expect(result).toEqual({
      ok: false,
      error: { kind: "providerConflict", boundProvider: "claude" },
    });
    expect(mockUpdate).not.toHaveBeenCalled();
    const unchanged = await chatSessionsService.findByKey(USER_A, CHAT_KEY);
    expect(unchanged?.provider).toBe("claude");
    expect(msgs(unchanged as { messages: unknown }).map((m) => m.id)).toEqual([
      "u1",
    ]);
  });
});

// ---------------------------------------------------------------------------
// appendMessages
// ---------------------------------------------------------------------------

describe("chatSessionsService.appendMessages", () => {
  const CHAT_KEY = "artifact:pln-1";

  async function seedClaudeChat(): Promise<void> {
    await createChat({
      userId: USER_A,
      organizationId: ORG_A,
      chatKey: CHAT_KEY,
      provider: "claude",
      model: "claude-sonnet-4-5",
      messages: [{ id: "u1", role: "user", content: "hello", timestamp: "t1" }],
    });
  }

  it("returns { notFound } error for an unknown chatKey", async () => {
    const result = await chatSessionsService.appendMessages(
      USER_A,
      "missing",
      "claude",
      [{ id: "u1", role: "user", content: "x", timestamp: "t1" }]
    );
    expect(result).toEqual({ ok: false, error: { kind: "notFound" } });
  });

  it("returns a provider conflict with boundProvider when request provider differs", async () => {
    await seedClaudeChat();

    const result = await chatSessionsService.appendMessages(
      USER_A,
      CHAT_KEY,
      "codex",
      [{ id: "u2", role: "user", content: "x", timestamp: "t2" }]
    );

    expect(result).toEqual({
      ok: false,
      error: { kind: "providerConflict", boundProvider: "claude" },
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("appends a brand-new message and persists it exactly once", async () => {
    await seedClaudeChat();

    const result = await chatSessionsService.appendMessages(
      USER_A,
      CHAT_KEY,
      "claude",
      [{ id: "a1", role: "assistant", content: "hi back", timestamp: "t2" }]
    );
    const value = unwrapOk(result);
    expect(msgs(value.chat).map((m) => m.id)).toEqual(["u1", "a1"]);

    const reread = await chatSessionsService.findByKey(USER_A, CHAT_KEY);
    expect(reread ? msgs(reread).map((m) => m.id) : []).toEqual(["u1", "a1"]);
  });

  it("is a no-op (no updatedAt bump) when the appended id already exists", async () => {
    await seedClaudeChat();
    const before = await chatSessionsService.findByKey(USER_A, CHAT_KEY);
    mockUpdate.mockClear();

    const result = await chatSessionsService.appendMessages(
      USER_A,
      CHAT_KEY,
      "claude",
      [{ id: "u1", role: "user", content: "hello", timestamp: "t1" }]
    );

    const value = unwrapOk(result);
    expect(msgs(value.chat).map((m) => m.id)).toEqual(["u1"]);
    expect(value.chat.updatedAt).toEqual(before?.updatedAt);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("only appends new ids from a partially overlapping batch", async () => {
    await seedClaudeChat();

    const result = await chatSessionsService.appendMessages(
      USER_A,
      CHAT_KEY,
      "claude",
      [
        { id: "u1", role: "user", content: "hello", timestamp: "t1" },
        { id: "u2", role: "user", content: "second", timestamp: "t2" },
      ]
    );
    const value = unwrapOk(result);
    expect(msgs(value.chat).map((m) => m.id)).toEqual(["u1", "u2"]);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it("preserves id-dedup across two sequential writers supplying the same message", async () => {
    await seedClaudeChat();

    const [first, second] = await Promise.all([
      chatSessionsService.appendMessages(USER_A, CHAT_KEY, "claude", [
        { id: "a1", role: "assistant", content: "answer", timestamp: "t2" },
      ]),
      chatSessionsService.appendMessages(USER_A, CHAT_KEY, "claude", [
        { id: "a1", role: "assistant", content: "answer", timestamp: "t2" },
      ]),
    ]);

    expect(first.ok && second.ok).toBe(true);
    const final = await chatSessionsService.findByKey(USER_A, CHAT_KEY);
    const ids = final ? msgs(final).map((m) => m.id) : [];
    expect(ids).toEqual(["u1", "a1"]);
    expect(ids.filter((id: string) => id === "a1")).toHaveLength(1);
  });

  it("updates sessionId when provided and different from stored value", async () => {
    await seedClaudeChat();

    const result = await chatSessionsService.appendMessages(
      USER_A,
      CHAT_KEY,
      "claude",
      [{ id: "a1", role: "assistant", content: "answer", timestamp: "t2" }],
      "sess-xyz"
    );
    const value = unwrapOk(result);
    expect(value.chat.sessionId).toBe("sess-xyz");
  });
});

// ---------------------------------------------------------------------------
// deleteChat
// ---------------------------------------------------------------------------

describe("chatSessionsService.deleteChat", () => {
  const CHAT_KEY = "artifact:pln-1";

  it("returns true when a row is deleted", async () => {
    await createChat({
      userId: USER_A,
      organizationId: ORG_A,
      chatKey: CHAT_KEY,
      provider: "claude",
      model: "claude-sonnet-4-5",
    });

    const deleted = await chatSessionsService.deleteChat(USER_A, CHAT_KEY);
    expect(deleted).toBe(true);

    const reread = await chatSessionsService.findByKey(USER_A, CHAT_KEY);
    expect(reread).toBeNull();
  });

  it("returns false (idempotent) when no row exists", async () => {
    const deleted = await chatSessionsService.deleteChat(USER_A, "nonexistent");
    expect(deleted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// upsertTurn
// ---------------------------------------------------------------------------

describe("chatSessionsService.upsertTurn", () => {
  const CHAT_KEY = "artifact:pln-1";
  const GATEWAY_A = "gateway-a";
  const GATEWAY_B = "gateway-b";

  const u1: ChatMessage = {
    id: "u1",
    role: "user",
    content: "hello",
    timestamp: "t1",
  };

  function seedClaudeChat(overrides: Partial<Row> = {}): string {
    const row: Row = {
      id: "chat-seed",
      chatKey: CHAT_KEY,
      userId: USER_A,
      organizationId: ORG_A,
      provider: "claude",
      model: "claude-sonnet-4-5",
      messages: [u1],
      sessionId: null,
      sessionSourceId: null,
      context: null,
      createdAt: nextDate(),
      updatedAt: nextDate(),
      ...overrides,
    };
    store.set(keyOf(USER_A, CHAT_KEY), row);
    return row.id;
  }

  it("creates a new row when (userId, chatKey) is absent", async () => {
    const result = await chatSessionsService.upsertTurn(USER_A, ORG_A, {
      chatKey: CHAT_KEY,
      userMessage: u1,
      provider: "claude",
      model: "claude-sonnet-4-5",
      sourceGatewayId: GATEWAY_A,
    });

    const value = unwrapOk(result);
    expect(msgs(value.chat).map((m) => m.id)).toEqual(["u1"]);
    expect(value.chat.sessionId).toBeNull();
    expect(value.chat.sessionSourceId).toBeNull();
    expect(value.resumeSessionId).toBeNull();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("appends the user message to an existing matching-provider row", async () => {
    await seedClaudeChat();
    mockUpdate.mockClear();

    const u2: ChatMessage = {
      id: "u2",
      role: "user",
      content: "second",
      timestamp: "t2",
    };
    const result = await chatSessionsService.upsertTurn(USER_A, ORG_A, {
      chatKey: CHAT_KEY,
      userMessage: u2,
      provider: "claude",
      model: "claude-sonnet-4-5",
      sourceGatewayId: GATEWAY_A,
    });

    const value = unwrapOk(result);
    expect(msgs(value.chat).map((m) => m.id)).toEqual(["u1", "u2"]);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it("returns providerConflict error with boundProvider on provider mismatch", async () => {
    await seedClaudeChat();
    mockUpdate.mockClear();

    const result = await chatSessionsService.upsertTurn(USER_A, ORG_A, {
      chatKey: CHAT_KEY,
      userMessage: u1,
      provider: "codex",
      model: "gpt-5.3-codex",
      sourceGatewayId: GATEWAY_A,
    });

    expect(result).toEqual({
      ok: false,
      error: { kind: "providerConflict", boundProvider: "claude" },
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("is a no-op when the userMessage id already exists", async () => {
    await seedClaudeChat();
    const before = await chatSessionsService.findByKey(USER_A, CHAT_KEY);
    mockUpdate.mockClear();

    const result = await chatSessionsService.upsertTurn(USER_A, ORG_A, {
      chatKey: CHAT_KEY,
      userMessage: u1,
      provider: "claude",
      model: "claude-sonnet-4-5",
      sourceGatewayId: GATEWAY_A,
    });

    const value = unwrapOk(result);
    expect(msgs(value.chat).map((m) => m.id)).toEqual(["u1"]);
    expect(value.chat.updatedAt).toEqual(before?.updatedAt);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("returns resumeSessionId when gateway matches and session is present", async () => {
    await seedClaudeChat({
      sessionId: "sess-xyz",
      sessionSourceId: GATEWAY_A,
    });

    const result = await chatSessionsService.upsertTurn(USER_A, ORG_A, {
      chatKey: CHAT_KEY,
      userMessage: u1,
      provider: "claude",
      model: "claude-sonnet-4-5",
      sourceGatewayId: GATEWAY_A,
    });

    expect(unwrapOk(result).resumeSessionId).toBe("sess-xyz");
  });

  it("returns resumeSessionId: null when gateway matches but session is absent", async () => {
    await seedClaudeChat({
      sessionId: null,
      sessionSourceId: GATEWAY_A,
    });

    const result = await chatSessionsService.upsertTurn(USER_A, ORG_A, {
      chatKey: CHAT_KEY,
      userMessage: u1,
      provider: "claude",
      model: "claude-sonnet-4-5",
      sourceGatewayId: GATEWAY_A,
    });

    expect(unwrapOk(result).resumeSessionId).toBeNull();
  });

  it("returns resumeSessionId: null when gateway mismatches but session is present", async () => {
    await seedClaudeChat({
      sessionId: "sess-xyz",
      sessionSourceId: GATEWAY_B,
    });

    const result = await chatSessionsService.upsertTurn(USER_A, ORG_A, {
      chatKey: CHAT_KEY,
      userMessage: u1,
      provider: "claude",
      model: "claude-sonnet-4-5",
      sourceGatewayId: GATEWAY_A,
    });

    expect(unwrapOk(result).resumeSessionId).toBeNull();
  });

  it("returns resumeSessionId: null when both gateway mismatches and session is absent", async () => {
    await seedClaudeChat({
      sessionId: null,
      sessionSourceId: GATEWAY_B,
    });

    const result = await chatSessionsService.upsertTurn(USER_A, ORG_A, {
      chatKey: CHAT_KEY,
      userMessage: u1,
      provider: "claude",
      model: "claude-sonnet-4-5",
      sourceGatewayId: GATEWAY_A,
    });

    expect(unwrapOk(result).resumeSessionId).toBeNull();
  });

  it("never writes sessionId or sessionSourceId", async () => {
    await seedClaudeChat({
      sessionId: "sess-old",
      sessionSourceId: GATEWAY_B,
    });
    mockUpdate.mockClear();

    const u2: ChatMessage = {
      id: "u2",
      role: "user",
      content: "second",
      timestamp: "t2",
    };
    await chatSessionsService.upsertTurn(USER_A, ORG_A, {
      chatKey: CHAT_KEY,
      userMessage: u2,
      provider: "claude",
      model: "claude-sonnet-4-5",
      sourceGatewayId: GATEWAY_A,
    });

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const updateCall = mockUpdate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(updateCall.data.sessionId).toBeUndefined();
    expect(updateCall.data.sessionSourceId).toBeUndefined();

    const reread = await chatSessionsService.findByKey(USER_A, CHAT_KEY);
    expect(reread?.sessionId).toBe("sess-old");
    expect(reread?.sessionSourceId).toBe(GATEWAY_B);
  });

  it("passes context through to the created row when supplied on a new chat", async () => {
    const result = await chatSessionsService.upsertTurn(USER_A, ORG_A, {
      chatKey: CHAT_KEY,
      userMessage: u1,
      provider: "claude",
      model: "claude-sonnet-4-5",
      sourceGatewayId: GATEWAY_A,
      context: "You are a helpful assistant working on feature PLN-438.",
    });

    const value = unwrapOk(result);
    expect(value.chat.context).toBe(
      "You are a helpful assistant working on feature PLN-438."
    );
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const createCall = mockCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(createCall.data.context).toBe(
      "You are a helpful assistant working on feature PLN-438."
    );
  });
});

// ---------------------------------------------------------------------------
// appendAssistantTurn
// ---------------------------------------------------------------------------

describe("chatSessionsService.appendAssistantTurn", () => {
  const CHAT_KEY = "artifact:pln-1";
  const GATEWAY_A = "gateway-a";

  const u1: ChatMessage = {
    id: "u1",
    role: "user",
    content: "hello",
    timestamp: "t1",
  };
  const a1: ChatMessage = {
    id: "a1",
    role: "assistant",
    content: "hi",
    timestamp: "t2",
  };

  function seedClaudeChat(): void {
    const row: Row = {
      id: "chat-seed",
      chatKey: CHAT_KEY,
      userId: USER_A,
      organizationId: ORG_A,
      provider: "claude",
      model: "claude-sonnet-4-5",
      messages: [u1],
      sessionId: null,
      sessionSourceId: null,
      context: null,
      createdAt: nextDate(),
      updatedAt: nextDate(),
    };
    store.set(keyOf(USER_A, CHAT_KEY), row);
  }

  it("appends the assistant message and writes both session fields atomically", async () => {
    await seedClaudeChat();

    const result = await chatSessionsService.appendAssistantTurn(USER_A, {
      chatKey: CHAT_KEY,
      provider: "claude",
      messages: [a1],
      sessionId: "sess-xyz",
      sessionSourceId: GATEWAY_A,
    });

    const value = unwrapOk(result);
    expect(msgs(value.chat).map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(value.chat.sessionId).toBe("sess-xyz");
    expect(value.chat.sessionSourceId).toBe(GATEWAY_A);
  });

  it("returns { notFound } error when the row does not exist", async () => {
    const result = await chatSessionsService.appendAssistantTurn(USER_A, {
      chatKey: "missing",
      provider: "claude",
      messages: [a1],
      sessionId: null,
      sessionSourceId: null,
    });
    expect(result).toEqual({ ok: false, error: { kind: "notFound" } });
  });

  it("returns providerConflict error with boundProvider on provider mismatch", async () => {
    await seedClaudeChat();
    mockUpdate.mockClear();

    const result = await chatSessionsService.appendAssistantTurn(USER_A, {
      chatKey: CHAT_KEY,
      provider: "codex",
      messages: [a1],
      sessionId: null,
      sessionSourceId: null,
    });

    expect(result).toEqual({
      ok: false,
      error: { kind: "providerConflict", boundProvider: "claude" },
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("is id-idempotent on duplicate assistant message ids", async () => {
    await seedClaudeChat();

    const first = await chatSessionsService.appendAssistantTurn(USER_A, {
      chatKey: CHAT_KEY,
      provider: "claude",
      messages: [a1],
      sessionId: "sess-xyz",
      sessionSourceId: GATEWAY_A,
    });
    const second = await chatSessionsService.appendAssistantTurn(USER_A, {
      chatKey: CHAT_KEY,
      provider: "claude",
      messages: [a1],
      sessionId: "sess-xyz",
      sessionSourceId: GATEWAY_A,
    });

    expect(first.ok && second.ok).toBe(true);
    const reread = await chatSessionsService.findByKey(USER_A, CHAT_KEY);
    const ids = reread ? msgs(reread).map((m) => m.id) : [];
    expect(ids).toEqual(["u1", "a1"]);
    expect(ids.filter((id: string) => id === "a1")).toHaveLength(1);
  });

  it("short-circuits without a DB write when sessionId, sessionSourceId, and messages are all unchanged", async () => {
    // Seed a row that already has sessionId and sessionSourceId set plus the
    // assistant message stored.
    const storedUpdatedAt = nextDate();
    const row: Row = {
      id: "chat-seed",
      chatKey: CHAT_KEY,
      userId: USER_A,
      organizationId: ORG_A,
      provider: "claude",
      model: "claude-sonnet-4-5",
      messages: [u1, a1],
      sessionId: "sess-xyz",
      sessionSourceId: GATEWAY_A,
      context: null,
      createdAt: storedUpdatedAt,
      updatedAt: storedUpdatedAt,
    };
    store.set(keyOf(USER_A, CHAT_KEY), row);
    mockUpdate.mockClear();

    const result = await chatSessionsService.appendAssistantTurn(USER_A, {
      chatKey: CHAT_KEY,
      provider: "claude",
      messages: [a1],
      sessionId: "sess-xyz",
      sessionSourceId: GATEWAY_A,
    });

    const value = unwrapOk(result);
    // No new messages and identical session fields — no DB write must occur.
    expect(mockUpdate).not.toHaveBeenCalled();
    // updatedAt must be exactly the value that was stored before the call.
    expect(value.chat.updatedAt).toEqual(storedUpdatedAt);
    // The returned messages should be identical to what was already stored.
    expect(msgs(value.chat).map((m) => m.id)).toEqual(["u1", "a1"]);
  });
});
