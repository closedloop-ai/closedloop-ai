import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  type ChatSessionRow,
  completeTurnViaBackend,
  upsertTurnViaBackend,
} from "../src/server/operations/chat-backend-client.js";
import type { ChatMessage } from "../src/server/operations/chat-providers.js";

type FetchCall = {
  url: string;
  init: RequestInit;
};

type MockResponse = {
  status: number;
  body?: unknown;
  throw?: Error;
};

const originalFetch = globalThis.fetch;
const calls: FetchCall[] = [];

function installMockFetch(responses: MockResponse[]): void {
  let index = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : String(input),
      init: init ?? {},
    });
    const response = responses[index++];
    if (!response) {
      throw new Error("unexpected extra fetch call");
    }
    if (response.throw) {
      throw response.throw;
    }
    const bodyText =
      response.body === undefined ? "" : JSON.stringify(response.body);
    return new Response(bodyText, {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  calls.length = 0;
});

const SAMPLE_USER_MESSAGE: ChatMessage = {
  id: "user-1",
  role: "user",
  content: "hello",
  timestamp: "2026-01-01T00:00:00.000Z",
};

const SAMPLE_ASSISTANT_MESSAGE: ChatMessage = {
  id: "assistant-1",
  role: "assistant",
  content: "hi there",
  timestamp: "2026-01-01T00:00:01.000Z",
};

const SAMPLE_CHAT_ROW: ChatSessionRow = {
  id: "chat-1",
  chatKey: "chat-key-1",
  provider: "claude",
  model: "sonnet",
  context: null,
  messages: [SAMPLE_USER_MESSAGE],
  sessionId: null,
  sessionSourceId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("upsertTurnViaBackend", () => {
  test("sends POST to /chat-sessions/turn with bearer token and body", async () => {
    installMockFetch([
      {
        status: 200,
        body: {
          success: true,
          data: { chat: SAMPLE_CHAT_ROW, resumeSessionId: "session-abc" },
        },
      },
    ]);

    const result = await upsertTurnViaBackend(
      "https://api.example.com/",
      "token-xyz",
      {
        chatKey: "chat-key-1",
        userMessage: SAMPLE_USER_MESSAGE,
        provider: "claude",
        model: "sonnet",
        context: "ctx",
        sourceGatewayId: "gateway-1",
      }
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.chat, SAMPLE_CHAT_ROW);
      assert.equal(result.resumeSessionId, "session-abc");
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.example.com/chat-sessions/turn");
    assert.equal(calls[0].init.method, "POST");
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer token-xyz");
    assert.equal(headers["content-type"], "application/json");
    const body = JSON.parse(String(calls[0].init.body)) as Record<
      string,
      unknown
    >;
    assert.equal(body.chatKey, "chat-key-1");
    assert.equal(body.provider, "claude");
    assert.equal(body.model, "sonnet");
    assert.equal(body.context, "ctx");
    assert.equal(body.sourceGatewayId, "gateway-1");
    assert.deepEqual(body.userMessage, SAMPLE_USER_MESSAGE);
  });

  test("unwraps apps/api success envelope { success, data }", async () => {
    installMockFetch([
      {
        status: 200,
        body: {
          success: true,
          data: { chat: SAMPLE_CHAT_ROW, resumeSessionId: null },
        },
      },
    ]);

    const result = await upsertTurnViaBackend(
      "https://api.example.com",
      "token",
      {
        chatKey: "chat-key-1",
        userMessage: SAMPLE_USER_MESSAGE,
        provider: "claude",
        model: "sonnet",
        sourceGatewayId: "gateway-1",
      }
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.chat, SAMPLE_CHAT_ROW);
      assert.equal(result.resumeSessionId, null);
    }
  });

  test("returns error when 200 response uses flat shape without envelope", async () => {
    // Regression: the old client accepted {chat, resumeSessionId} at top level,
    // which left chat=undefined when apps/api wrapped in {success, data}.
    // Now the client must refuse that shape.
    installMockFetch([
      {
        status: 200,
        body: { chat: SAMPLE_CHAT_ROW, resumeSessionId: "session-abc" },
      },
    ]);

    const result = await upsertTurnViaBackend(
      "https://api.example.com",
      "token",
      {
        chatKey: "chat-key-1",
        userMessage: SAMPLE_USER_MESSAGE,
        provider: "claude",
        model: "sonnet",
        sourceGatewayId: "gateway-1",
      }
    );

    assert.equal(result.ok, false);
    if (!result.ok && "error" in result) {
      assert.match(result.error, /malformed success envelope/);
    } else {
      assert.fail("expected error result");
    }
  });

  test("returns error when 200 response has success: false", async () => {
    installMockFetch([
      {
        status: 200,
        body: { success: false, error: "something broke" },
      },
    ]);

    const result = await upsertTurnViaBackend(
      "https://api.example.com",
      "token",
      {
        chatKey: "chat-key-1",
        userMessage: SAMPLE_USER_MESSAGE,
        provider: "claude",
        model: "sonnet",
        sourceGatewayId: "gateway-1",
      }
    );

    assert.equal(result.ok, false);
    if (!result.ok && "error" in result) {
      assert.match(result.error, /malformed success envelope/);
    } else {
      assert.fail("expected error result");
    }
  });

  test("returns conflict on 409 response", async () => {
    installMockFetch([
      {
        status: 409,
        body: { error: "provider mismatch", boundProvider: "codex" },
      },
    ]);

    const result = await upsertTurnViaBackend(
      "https://api.example.com",
      "token",
      {
        chatKey: "chat-key-1",
        userMessage: SAMPLE_USER_MESSAGE,
        provider: "claude",
        model: "sonnet",
        sourceGatewayId: "gateway-1",
      }
    );

    assert.equal(result.ok, false);
    if (!result.ok && "conflict" in result) {
      assert.equal(result.conflict, true);
      assert.equal(result.boundProvider, "codex");
    } else {
      assert.fail("expected conflict result");
    }
  });

  test("returns error string on 500 response", async () => {
    installMockFetch([{ status: 500, body: { error: "boom" } }]);

    const result = await upsertTurnViaBackend(
      "https://api.example.com",
      "token",
      {
        chatKey: "chat-key-1",
        userMessage: SAMPLE_USER_MESSAGE,
        provider: "claude",
        model: "sonnet",
        sourceGatewayId: "gateway-1",
      }
    );

    assert.equal(result.ok, false);
    if (!result.ok && "error" in result) {
      assert.match(result.error, /500/);
    } else {
      assert.fail("expected error result");
    }
  });

  test("returns error string on network failure", async () => {
    installMockFetch([{ status: 0, throw: new Error("network down") }]);

    const result = await upsertTurnViaBackend(
      "https://api.example.com",
      "token",
      {
        chatKey: "chat-key-1",
        userMessage: SAMPLE_USER_MESSAGE,
        provider: "claude",
        model: "sonnet",
        sourceGatewayId: "gateway-1",
      }
    );

    assert.equal(result.ok, false);
    if (!result.ok && "error" in result) {
      assert.match(result.error, /network down/);
    } else {
      assert.fail("expected error result");
    }
  });
});

describe("completeTurnViaBackend", () => {
  test("sends POST to /chat-sessions/turn/complete on success", async () => {
    installMockFetch([
      {
        status: 200,
        body: { success: true, data: { chat: SAMPLE_CHAT_ROW } },
      },
    ]);

    const result = await completeTurnViaBackend(
      "https://api.example.com/",
      "token-xyz",
      {
        chatKey: "chat-key-1",
        provider: "claude",
        messages: [SAMPLE_ASSISTANT_MESSAGE],
        sessionId: "session-abc",
        sessionSourceId: "gateway-1",
      }
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.chat, SAMPLE_CHAT_ROW);
    }
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "https://api.example.com/chat-sessions/turn/complete"
    );
    assert.equal(calls[0].init.method, "POST");
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer token-xyz");
    const body = JSON.parse(String(calls[0].init.body)) as Record<
      string,
      unknown
    >;
    assert.equal(body.chatKey, "chat-key-1");
    assert.equal(body.sessionId, "session-abc");
    assert.equal(body.sessionSourceId, "gateway-1");
    assert.deepEqual(body.messages, [SAMPLE_ASSISTANT_MESSAGE]);
  });

  test("unwraps apps/api success envelope { success, data }", async () => {
    installMockFetch([
      {
        status: 200,
        body: { success: true, data: { chat: SAMPLE_CHAT_ROW } },
      },
    ]);

    const result = await completeTurnViaBackend(
      "https://api.example.com",
      "token",
      {
        chatKey: "chat-key-1",
        provider: "claude",
        messages: [SAMPLE_ASSISTANT_MESSAGE],
        sessionId: null,
        sessionSourceId: null,
      }
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.chat, SAMPLE_CHAT_ROW);
    }
  });

  test("classifies 200 with flat shape as permanent (regression)", async () => {
    // Regression: the old client accepted {chat} at top level, which left
    // chat=undefined when apps/api wrapped in {success, data}. Now refuses.
    installMockFetch([{ status: 200, body: { chat: SAMPLE_CHAT_ROW } }]);

    const result = await completeTurnViaBackend(
      "https://api.example.com",
      "token",
      {
        chatKey: "chat-key-1",
        provider: "claude",
        messages: [SAMPLE_ASSISTANT_MESSAGE],
        sessionId: null,
        sessionSourceId: null,
      }
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, "permanent");
      if (result.kind === "permanent") {
        assert.match(result.message, /malformed success envelope/);
      }
    }
  });

  test("classifies 200 with success: false as permanent", async () => {
    installMockFetch([
      {
        status: 200,
        body: { success: false, error: "something broke" },
      },
    ]);

    const result = await completeTurnViaBackend(
      "https://api.example.com",
      "token",
      {
        chatKey: "chat-key-1",
        provider: "claude",
        messages: [SAMPLE_ASSISTANT_MESSAGE],
        sessionId: null,
        sessionSourceId: null,
      }
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, "permanent");
      if (result.kind === "permanent") {
        assert.match(result.message, /malformed success envelope/);
      }
    }
  });

  test("classifies 5xx responses as transient", async () => {
    installMockFetch([{ status: 500, body: { error: "boom" } }]);

    const result = await completeTurnViaBackend(
      "https://api.example.com",
      "token",
      {
        chatKey: "chat-key-1",
        provider: "claude",
        messages: [SAMPLE_ASSISTANT_MESSAGE],
        sessionId: null,
        sessionSourceId: null,
      }
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, "transient");
      if (result.kind === "transient") {
        assert.match(result.message, /500/);
      }
    }
  });

  test("classifies network failure as transient", async () => {
    installMockFetch([{ status: 0, throw: new Error("connection refused") }]);

    const result = await completeTurnViaBackend(
      "https://api.example.com",
      "token",
      {
        chatKey: "chat-key-1",
        provider: "claude",
        messages: [SAMPLE_ASSISTANT_MESSAGE],
        sessionId: null,
        sessionSourceId: null,
      }
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, "transient");
      if (result.kind === "transient") {
        assert.match(result.message, /connection refused/);
      }
    }
  });

  test("classifies 401 as auth_expired", async () => {
    installMockFetch([{ status: 401, body: { error: "token expired" } }]);

    const result = await completeTurnViaBackend(
      "https://api.example.com",
      "token",
      {
        chatKey: "chat-key-1",
        provider: "claude",
        messages: [SAMPLE_ASSISTANT_MESSAGE],
        sessionId: null,
        sessionSourceId: null,
      }
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, "auth_expired");
    }
  });

  test("classifies 409 as conflict with boundProvider", async () => {
    installMockFetch([
      { status: 409, body: { error: "mismatch", boundProvider: "codex" } },
    ]);

    const result = await completeTurnViaBackend(
      "https://api.example.com",
      "token",
      {
        chatKey: "chat-key-1",
        provider: "claude",
        messages: [SAMPLE_ASSISTANT_MESSAGE],
        sessionId: null,
        sessionSourceId: null,
      }
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, "conflict");
      if (result.kind === "conflict") {
        assert.equal(result.boundProvider, "codex");
      }
    }
  });

  test("classifies non-5xx 4xx as permanent", async () => {
    installMockFetch([{ status: 400, body: { error: "bad request" } }]);

    const result = await completeTurnViaBackend(
      "https://api.example.com",
      "token",
      {
        chatKey: "chat-key-1",
        provider: "claude",
        messages: [SAMPLE_ASSISTANT_MESSAGE],
        sessionId: null,
        sessionSourceId: null,
      }
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, "permanent");
    }
  });
});
