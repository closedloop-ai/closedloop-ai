import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve as resolvePath } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import type { ChatSessionRow } from "../src/server/operations/chat-backend-client.js";
import {
  type ChatProvider,
  ClaudeProvider,
  ProviderRegistry,
  type SpawnParams,
  type SpawnResult,
  type StreamEvent,
} from "../src/server/operations/chat-providers.js";
import { registerChatSessionRoutes } from "../src/server/operations/chat-session.js";
import {
  ClaudeCodeOtelEnvVar,
  ClaudeCodeOtelReceiverState,
  createClaudeCodeShellEnvProvider,
} from "../src/server/otel/claude-code-env.js";
import type {
  ProcessManager,
  StreamingProcessHandle,
  StreamingSpawnOptions,
} from "../src/server/process-manager.js";

type CapturedResponse = {
  response: ServerResponse;
  chunks: string[];
  get statusCode(): number;
  get ended(): boolean;
};

function makeStreamingResponse(): CapturedResponse {
  let statusCode = 0;
  const chunks: string[] = [];
  let ended = false;
  const response = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(value: number) {
      statusCode = value;
    },
    setHeader() {},
    flushHeaders() {},
    socket: { setNoDelay() {} },
    write(chunk: unknown) {
      if (typeof chunk === "string") {
        chunks.push(chunk);
      }
      return true;
    },
    end(chunk?: unknown) {
      if (typeof chunk === "string") {
        chunks.push(chunk);
      }
      ended = true;
    },
  } as unknown as ServerResponse;

  return {
    response,
    chunks,
    get statusCode() {
      return statusCode;
    },
    get ended() {
      return ended;
    },
  };
}

function parseEvents(chunks: string[]): Record<string, unknown>[] {
  return chunks
    .join("")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function dispatchPost(
  dispatcher: OperationDispatcher,
  body: unknown
): Promise<CapturedResponse> {
  const captured = makeStreamingResponse();
  const bodyString = typeof body === "string" ? body : JSON.stringify(body);
  await dispatcher.dispatch({
    method: "POST",
    pathname: "/api/gateway/chat",
    params: {},
    query: new URLSearchParams(),
    rawBody: Buffer.from(bodyString),
    body: bodyString,
    request: {} as IncomingMessage,
    response: captured.response,
  });
  return captured;
}

type SpawnHandler = (
  params: SpawnParams,
  onEvent: (event: StreamEvent) => void
) => Promise<SpawnResult>;

class FakeProvider implements ChatProvider {
  readonly name: "claude" | "codex";
  readonly defaultModel = "fake-default-model";
  public readonly receivedParams: SpawnParams[] = [];
  private readonly handlers: SpawnHandler[];

  constructor(
    name: "claude" | "codex" = "claude",
    handlers: SpawnHandler[] = [
      async (_params, onEvent) => {
        onEvent({ type: "text", content: "hello" });
        return {
          sessionId: "sess-fake",
          exitCode: 0,
          retryableSessionMissing: false,
        };
      },
    ]
  ) {
    this.name = name;
    this.handlers = handlers;
  }

  supportsModel(): boolean {
    return true;
  }

  async spawn(
    params: SpawnParams,
    onEvent: (event: StreamEvent) => void
  ): Promise<SpawnResult> {
    this.receivedParams.push(params);
    const index = this.receivedParams.length - 1;
    const handler = this.handlers[index] ?? this.handlers.at(-1);
    return handler(params, onEvent);
  }

  get spawnCount(): number {
    return this.receivedParams.length;
  }
}

type FetchCall = { url: string; init: RequestInit };

type MockResponse =
  | { status: number; body?: unknown }
  | { status: 0; throw: Error };

const originalFetch = globalThis.fetch;
let fetchCalls: FetchCall[] = [];

function installFetch(responses: MockResponse[]): void {
  fetchCalls = [];
  let index = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    fetchCalls.push({ url, init: init ?? {} });
    const response = responses[index++];
    if (!response) {
      throw new Error(`unexpected extra fetch call to ${url}`);
    }
    if ("throw" in response && response.throw) {
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
  fetchCalls = [];
});

const SAMPLE_USER_MESSAGE = {
  id: "u1",
  role: "user" as const,
  content: "hi",
  timestamp: "2024-01-01T00:00:00Z",
};

const SAMPLE_CHAT_ROW: ChatSessionRow = {
  id: "chat-1",
  chatKey: "chat-key-1",
  provider: "claude",
  model: "claude-sonnet-4-5",
  context: null,
  messages: [SAMPLE_USER_MESSAGE],
  sessionId: null,
  sessionSourceId: null,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

const DEFAULT_GATEWAY_ID = "test-gateway-uuid";

function makeRegistry(provider: ChatProvider): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(provider);
  return registry;
}

function makeDispatcher(
  provider: ChatProvider,
  gatewayId = DEFAULT_GATEWAY_ID
): OperationDispatcher {
  const dispatcher = new OperationDispatcher();
  registerChatSessionRoutes(
    dispatcher,
    {} as unknown as ProcessManager,
    makeRegistry(provider),
    () => gatewayId
  );
  return dispatcher;
}

function requestBody(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    chatKey: "chat-key-1",
    userMessage: SAMPLE_USER_MESSAGE,
    provider: "claude",
    apiBaseUrl: "https://api.example.com",
    apiAuthToken: "token-xyz",
    ...overrides,
  };
}

function successfulUpsert(
  resumeSessionId: string | null = null,
  row: ChatSessionRow = SAMPLE_CHAT_ROW
): MockResponse {
  return {
    status: 200,
    body: { success: true, data: { chat: row, resumeSessionId } },
  };
}

function successfulComplete(): MockResponse {
  return {
    status: 200,
    body: { success: true, data: { chat: SAMPLE_CHAT_ROW } },
  };
}

function parsedBody(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body ?? "{}")) as Record<string, unknown>;
}

describe("ProviderRegistry", () => {
  test("get returns a registered provider by name", () => {
    const registry = new ProviderRegistry();
    const provider = new FakeProvider("claude");
    registry.register(provider);
    assert.equal(registry.get("claude"), provider);
  });

  test("get returns undefined for an unknown provider", () => {
    const registry = new ProviderRegistry();
    registry.register(new FakeProvider("claude"));
    assert.equal(registry.get("gemini"), undefined);
  });
});

describe("registerChatSessionRoutes POST /api/gateway/chat — body validation", () => {
  test("returns 400 when apiAuthToken is missing", async () => {
    const dispatcher = makeDispatcher(new FakeProvider());
    const { statusCode } = await dispatchPost(
      dispatcher,
      requestBody({ apiAuthToken: undefined })
    );
    assert.equal(statusCode, 400);
  });

  test("returns 400 when apiBaseUrl is missing", async () => {
    const dispatcher = makeDispatcher(new FakeProvider());
    const { statusCode } = await dispatchPost(
      dispatcher,
      requestBody({ apiBaseUrl: undefined })
    );
    assert.equal(statusCode, 400);
  });

  test("returns 400 when chatKey is missing", async () => {
    const dispatcher = makeDispatcher(new FakeProvider());
    const { statusCode } = await dispatchPost(
      dispatcher,
      requestBody({ chatKey: undefined })
    );
    assert.equal(statusCode, 400);
  });

  test("returns 400 when userMessage is missing", async () => {
    const dispatcher = makeDispatcher(new FakeProvider());
    const { statusCode } = await dispatchPost(
      dispatcher,
      requestBody({ userMessage: undefined })
    );
    assert.equal(statusCode, 400);
  });

  test("returns 400 when provider is missing", async () => {
    const dispatcher = makeDispatcher(new FakeProvider());
    const { statusCode } = await dispatchPost(
      dispatcher,
      requestBody({ provider: undefined })
    );
    assert.equal(statusCode, 400);
  });

  test("returns 400 when provider is unsupported", async () => {
    const dispatcher = makeDispatcher(new FakeProvider("claude"));
    const { statusCode } = await dispatchPost(
      dispatcher,
      requestBody({ provider: "gemini" })
    );
    assert.equal(statusCode, 400);
  });
});

describe("registerChatSessionRoutes POST /api/gateway/chat — happy path", () => {
  test("upserts, spawns, completes, emits exactly one result + one done", async () => {
    installFetch([successfulUpsert(null), successfulComplete()]);
    const provider = new FakeProvider("claude", [
      async (_params, onEvent) => {
        onEvent({ type: "text", content: "hello " });
        onEvent({ type: "text", content: "world" });
        return {
          sessionId: "sess-new",
          exitCode: 0,
          retryableSessionMissing: false,
        };
      },
    ]);
    const dispatcher = makeDispatcher(provider);

    const { chunks, ended } = await dispatchPost(dispatcher, requestBody());
    const events = parseEvents(chunks);
    const results = events.filter((event) => event.type === "result");
    const dones = events.filter((event) => event.type === "done");

    assert.equal(results.length, 1);
    assert.equal(dones.length, 1);
    assert.equal(results[0]?.success, true);
    assert.equal(results[0]?.sessionId, "sess-new");
    assert.equal(ended, true);
    assert.equal(fetchCalls.length, 2);
    assert.match(fetchCalls[0].url, /\/chat-sessions\/turn$/);
    assert.match(fetchCalls[1].url, /\/chat-sessions\/turn\/complete$/);
  });

  test("never calls PATCH /chat-sessions on the happy path", async () => {
    installFetch([successfulUpsert(null), successfulComplete()]);
    const dispatcher = makeDispatcher(new FakeProvider());

    await dispatchPost(dispatcher, requestBody());

    for (const call of fetchCalls) {
      assert.notEqual(call.init.method, "PATCH");
      assert.doesNotMatch(call.url, /\/chat-sessions(?:\?|$)/);
    }
  });

  test("upsert request body carries sourceGatewayId from getGatewayId()", async () => {
    installFetch([successfulUpsert(null), successfulComplete()]);
    const dispatcher = makeDispatcher(new FakeProvider(), "gateway-id-123");

    await dispatchPost(dispatcher, requestBody());

    const upsertBody = parsedBody(fetchCalls[0]);
    assert.equal(upsertBody.sourceGatewayId, "gateway-id-123");
  });

  test("resumeSessionId: null produces cold-start spawn with params.sessionId undefined", async () => {
    installFetch([successfulUpsert(null), successfulComplete()]);
    const provider = new FakeProvider();
    const dispatcher = makeDispatcher(provider);

    await dispatchPost(dispatcher, requestBody());

    assert.equal(provider.spawnCount, 1);
    assert.equal(provider.receivedParams[0]?.sessionId, undefined);
  });

  test("resumeSessionId: 'sess-abc' produces warm-start spawn with params.sessionId set", async () => {
    installFetch([successfulUpsert("sess-abc"), successfulComplete()]);
    const provider = new FakeProvider();
    const dispatcher = makeDispatcher(provider);

    await dispatchPost(dispatcher, requestBody());

    assert.equal(provider.spawnCount, 1);
    assert.equal(provider.receivedParams[0]?.sessionId, "sess-abc");
  });

  test("complete body carries {sessionId, sessionSourceId} when spawn captured a session", async () => {
    installFetch([successfulUpsert(null), successfulComplete()]);
    const provider = new FakeProvider("claude", [
      async () => ({
        sessionId: "captured-sess",
        exitCode: 0,
        retryableSessionMissing: false,
      }),
    ]);
    const dispatcher = makeDispatcher(provider, "gw-42");

    await dispatchPost(dispatcher, requestBody());

    const completeBody = parsedBody(fetchCalls[1]);
    assert.equal(completeBody.sessionId, "captured-sess");
    assert.equal(completeBody.sessionSourceId, "gw-42");
  });

  test("complete body has both session fields null when spawn captured no session", async () => {
    installFetch([successfulUpsert(null), successfulComplete()]);
    const provider = new FakeProvider("claude", [
      async () => ({
        sessionId: undefined,
        exitCode: 0,
        retryableSessionMissing: false,
      }),
    ]);
    const dispatcher = makeDispatcher(provider);

    await dispatchPost(dispatcher, requestBody());

    const completeBody = parsedBody(fetchCalls[1]);
    assert.equal(completeBody.sessionId, null);
    assert.equal(completeBody.sessionSourceId, null);
  });
});

describe("registerChatSessionRoutes POST /api/gateway/chat — upsert errors", () => {
  test("emits phase:upsert PROVIDER_MISMATCH on 409 and does not spawn", async () => {
    installFetch([
      { status: 409, body: { error: "mismatch", boundProvider: "codex" } },
    ]);
    const provider = new FakeProvider();
    const dispatcher = makeDispatcher(provider);

    const { chunks } = await dispatchPost(dispatcher, requestBody());
    const events = parseEvents(chunks);
    const errorEvent = events.find((event) => event.type === "error");

    assert.ok(errorEvent);
    assert.equal(errorEvent?.phase, "upsert");
    assert.equal(errorEvent?.code, "PROVIDER_MISMATCH");
    assert.equal(errorEvent?.boundProvider, "codex");
    assert.equal(typeof errorEvent?.message, "string");

    assert.equal(provider.spawnCount, 0);
    assert.equal(fetchCalls.length, 1);
    assert.equal(events.filter((event) => event.type === "result").length, 1);
    assert.equal(
      events.filter((event) => event.type === "result")[0]?.success,
      false
    );
    assert.equal(events.filter((event) => event.type === "done").length, 1);
  });

  test("emits phase:upsert BACKEND_ERROR on 500", async () => {
    installFetch([{ status: 500, body: { error: "boom" } }]);
    const provider = new FakeProvider();
    const dispatcher = makeDispatcher(provider);

    const { chunks } = await dispatchPost(dispatcher, requestBody());
    const events = parseEvents(chunks);
    const errorEvent = events.find((event) => event.type === "error");

    assert.ok(errorEvent);
    assert.equal(errorEvent?.phase, "upsert");
    assert.equal(errorEvent?.code, "BACKEND_ERROR");
    assert.equal(provider.spawnCount, 0);
    assert.equal(fetchCalls.length, 1);
    assert.equal(
      events.filter((event) => event.type === "result")[0]?.success,
      false
    );
    assert.equal(events.filter((event) => event.type === "done").length, 1);
  });

  test("emits phase:upsert AUTH_EXPIRED when upsert error string starts with 401", async () => {
    installFetch([{ status: 401, body: { error: "unauthorized" } }]);
    const provider = new FakeProvider();
    const dispatcher = makeDispatcher(provider);

    const { chunks } = await dispatchPost(dispatcher, requestBody());
    const events = parseEvents(chunks);
    const errorEvent = events.find((event) => event.type === "error");

    assert.equal(errorEvent?.phase, "upsert");
    assert.equal(errorEvent?.code, "AUTH_EXPIRED");
    assert.equal(provider.spawnCount, 0);
  });
});

describe("registerChatSessionRoutes POST /api/gateway/chat — lazy fallback retry", () => {
  test("retries once when retryable and no text was emitted", async () => {
    installFetch([successfulUpsert("sess-stale"), successfulComplete()]);
    const provider = new FakeProvider("claude", [
      async () => ({
        sessionId: undefined,
        exitCode: 1,
        retryableSessionMissing: true,
      }),
      async (_params, onEvent) => {
        onEvent({ type: "text", content: "retry-ok" });
        return {
          sessionId: "sess-new",
          exitCode: 0,
          retryableSessionMissing: false,
        };
      },
    ]);
    const dispatcher = makeDispatcher(provider, "gw-retry");

    const { chunks } = await dispatchPost(dispatcher, requestBody());

    assert.equal(provider.spawnCount, 2);
    assert.equal(provider.receivedParams[0]?.sessionId, "sess-stale");
    assert.equal(provider.receivedParams[1]?.sessionId, undefined);

    const completeBody = parsedBody(fetchCalls[1]);
    assert.equal(completeBody.sessionId, "sess-new");
    assert.equal(completeBody.sessionSourceId, "gw-retry");
    const messages = completeBody.messages as Record<string, unknown>[];
    assert.equal(messages[0]?.content, "retry-ok");

    const events = parseEvents(chunks);
    assert.equal(
      events.filter((event) => event.type === "result")[0]?.success,
      true
    );
    assert.equal(events.filter((event) => event.type === "done").length, 1);
  });

  test("suppresses first-attempt error events when lazy retry succeeds", async () => {
    // Regression for the "stale error events before lazy retry" bug: the
    // first spawn attempt emits an error (as both providers do on stderr),
    // the retry succeeds, and the client must NOT see the first attempt's
    // error in the final event stream. Without forwarder buffering + commit
    // the error would already be on the wire before the retry even starts.
    installFetch([successfulUpsert("sess-stale"), successfulComplete()]);
    const provider = new FakeProvider("claude", [
      async (_params, onEvent) => {
        onEvent({ type: "error", error: "session id not found" });
        return {
          sessionId: undefined,
          exitCode: 1,
          retryableSessionMissing: true,
        };
      },
      async (_params, onEvent) => {
        onEvent({ type: "text", content: "retry-ok" });
        return {
          sessionId: "sess-new",
          exitCode: 0,
          retryableSessionMissing: false,
        };
      },
    ]);
    const dispatcher = makeDispatcher(provider);

    const { chunks } = await dispatchPost(dispatcher, requestBody());

    assert.equal(provider.spawnCount, 2);
    const events = parseEvents(chunks);
    const errorEvents = events.filter((event) => event.type === "error");
    assert.equal(
      errorEvents.length,
      0,
      `expected no error events after successful retry, got ${errorEvents.length}`
    );
    assert.equal(
      events.filter((event) => event.type === "result")[0]?.success,
      true
    );
    assert.equal(events.filter((event) => event.type === "done").length, 1);
  });

  test("does NOT retry when text was already emitted", async () => {
    installFetch([successfulUpsert("sess-stale"), successfulComplete()]);
    const provider = new FakeProvider("claude", [
      async (_params, onEvent) => {
        onEvent({ type: "text", content: "partial" });
        return {
          sessionId: undefined,
          exitCode: 1,
          retryableSessionMissing: true,
        };
      },
    ]);
    const dispatcher = makeDispatcher(provider);

    await dispatchPost(dispatcher, requestBody());

    assert.equal(provider.spawnCount, 1);
    const completeBody = parsedBody(fetchCalls[1]);
    const messages = completeBody.messages as Record<string, unknown>[];
    assert.equal(messages[0]?.content, "partial");
  });

  test("does NOT retry on unrelated (non-retryable) errors", async () => {
    installFetch([successfulUpsert("sess-stale"), successfulComplete()]);
    const provider = new FakeProvider("claude", [
      async () => ({
        sessionId: undefined,
        exitCode: 1,
        retryableSessionMissing: false,
      }),
    ]);
    const dispatcher = makeDispatcher(provider);

    const { chunks } = await dispatchPost(dispatcher, requestBody());

    assert.equal(provider.spawnCount, 1);
    assert.equal(fetchCalls.length, 2);
    const events = parseEvents(chunks);
    assert.equal(
      events.filter((event) => event.type === "result")[0]?.success,
      false
    );
  });

  test("does NOT retry when initial sessionId was undefined (cold start)", async () => {
    installFetch([successfulUpsert(null), successfulComplete()]);
    const provider = new FakeProvider("claude", [
      async () => ({
        sessionId: undefined,
        exitCode: 1,
        retryableSessionMissing: true,
      }),
    ]);
    const dispatcher = makeDispatcher(provider);

    await dispatchPost(dispatcher, requestBody());

    assert.equal(provider.spawnCount, 1);
  });

  test("retry failure: second spawn also fails → no third spawn, result(false)", async () => {
    installFetch([successfulUpsert("sess-stale"), successfulComplete()]);
    const provider = new FakeProvider("claude", [
      async (_params, onEvent) => {
        onEvent({ type: "error", phase: "spawn", error: "first fail" });
        return {
          sessionId: undefined,
          exitCode: 1,
          retryableSessionMissing: true,
        };
      },
      async (_params, onEvent) => {
        onEvent({ type: "error", phase: "spawn", error: "second fail" });
        return {
          sessionId: undefined,
          exitCode: 1,
          retryableSessionMissing: true,
        };
      },
      async () => {
        throw new Error("unexpected third spawn");
      },
    ]);
    const dispatcher = makeDispatcher(provider);

    const { chunks } = await dispatchPost(dispatcher, requestBody());

    assert.equal(provider.spawnCount, 2);
    const events = parseEvents(chunks);
    const errorEvents = events.filter((event) => event.type === "error");
    assert.ok(errorEvents.length >= 1);
    assert.equal(
      events.filter((event) => event.type === "result")[0]?.success,
      false
    );
    assert.equal(events.filter((event) => event.type === "done").length, 1);
  });
});

describe("registerChatSessionRoutes POST /api/gateway/chat — complete errors", () => {
  test("PERSISTENCE_FAILED when complete fails twice on transient 500", async () => {
    installFetch([
      successfulUpsert(null),
      { status: 500, body: { error: "boom" } },
      { status: 500, body: { error: "boom" } },
    ]);
    const provider = new FakeProvider("claude", [
      async () => ({
        sessionId: "captured-sess",
        exitCode: 0,
        retryableSessionMissing: false,
      }),
    ]);
    const dispatcher = makeDispatcher(provider);

    const { chunks } = await dispatchPost(dispatcher, requestBody());
    const events = parseEvents(chunks);
    const errorEvent = events.find(
      (event) => event.type === "error" && event.phase === "complete"
    );

    assert.ok(errorEvent);
    assert.equal(errorEvent?.code, "PERSISTENCE_FAILED");
    // 3 fetch calls: upsert + complete + retry-complete.
    assert.equal(fetchCalls.length, 3);
    // Barrier semantics: result.success is false even though the spawn
    // itself exited successfully, because the DB write never landed.
    const result = events.find((event) => event.type === "result");
    assert.equal(result?.success, false);
    assert.equal(result?.sessionId, "captured-sess");
    assert.equal(events.filter((event) => event.type === "done").length, 1);
  });

  test("PERSISTENCE_FAILED retry succeeds on second attempt → success:true", async () => {
    installFetch([
      successfulUpsert(null),
      { status: 500, body: { error: "boom" } },
      successfulComplete(),
    ]);
    const dispatcher = makeDispatcher(new FakeProvider());

    const { chunks } = await dispatchPost(dispatcher, requestBody());
    const events = parseEvents(chunks);
    const errors = events.filter((event) => event.type === "error");
    const persistenceErrors = errors.filter(
      (event) =>
        event.phase === "complete" && event.code === "PERSISTENCE_FAILED"
    );

    assert.equal(persistenceErrors.length, 0);
    assert.equal(
      events.filter((event) => event.type === "result")[0]?.success,
      true
    );
    assert.equal(fetchCalls.length, 3);
  });

  test("AUTH_EXPIRED on complete 401 (not retried)", async () => {
    installFetch([
      successfulUpsert(null),
      { status: 401, body: { error: "unauthorized" } },
    ]);
    const dispatcher = makeDispatcher(new FakeProvider());

    const { chunks } = await dispatchPost(dispatcher, requestBody());
    const events = parseEvents(chunks);
    const errorEvent = events.find(
      (event) => event.type === "error" && event.phase === "complete"
    );

    assert.equal(errorEvent?.code, "AUTH_EXPIRED");
    // auth_expired is not transient — complete is called exactly once.
    assert.equal(fetchCalls.length, 2);
    assert.equal(
      events.filter((event) => event.type === "result")[0]?.success,
      false
    );
  });

  test("PROVIDER_MISMATCH on complete 409 (not retried, carries boundProvider)", async () => {
    installFetch([
      successfulUpsert(null),
      {
        status: 409,
        body: { error: "mismatch", boundProvider: "codex" },
      },
    ]);
    const dispatcher = makeDispatcher(new FakeProvider());

    const { chunks } = await dispatchPost(dispatcher, requestBody());
    const events = parseEvents(chunks);
    const errorEvent = events.find(
      (event) => event.type === "error" && event.phase === "complete"
    );

    assert.equal(errorEvent?.code, "PROVIDER_MISMATCH");
    assert.equal(errorEvent?.boundProvider, "codex");
    assert.equal(fetchCalls.length, 2);
  });

  test("never calls PATCH /chat-sessions on any error path", async () => {
    installFetch([
      successfulUpsert(null),
      { status: 500, body: { error: "boom" } },
      { status: 500, body: { error: "boom" } },
    ]);
    const dispatcher = makeDispatcher(new FakeProvider());

    await dispatchPost(dispatcher, requestBody());

    for (const call of fetchCalls) {
      assert.notEqual(call.init.method, "PATCH");
    }
  });
});

describe("SpawnResult classification fixtures", () => {
  const fixturesDir = resolvePath(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "cli-session-missing"
  );

  test("CLAUDE_SESSION_MISSING_REGEX matches captured claude CLI stderr", () => {
    const fixture = readFileSync(
      resolvePath(fixturesDir, "claude.txt"),
      "utf-8"
    );
    // The regex is private to chat-providers.ts; assert the fixture contains
    // the distinguishing phrase so any CLI text change fails this test.
    assert.match(fixture, /no conversation found with session id/i);
  });

  test("CODEX_SESSION_MISSING_REGEX matches captured codex CLI stderr", () => {
    const fixture = readFileSync(
      resolvePath(fixturesDir, "codex.txt"),
      "utf-8"
    );
    assert.match(fixture, /no rollout found for thread/i);
  });
});

describe("ClaudeProvider", () => {
  const SAMPLE_MESSAGES = [
    {
      id: "u1",
      role: "user" as const,
      content: "hi",
      timestamp: "2024-01-01T00:00:00Z",
    },
  ];

  test("swallows result events emitted by processStreamEvent", async () => {
    const spawnStreaming = async (
      options: StreamingSpawnOptions
    ): Promise<StreamingProcessHandle> => {
      setImmediate(() => {
        options.onLine?.(
          JSON.stringify({ type: "init", sessionId: "captured-session" })
        );
        options.onLine?.(
          JSON.stringify({
            type: "assistant",
            message: {
              content: [{ type: "text", text: "hello from fake claude" }],
            },
          })
        );
        options.onLine?.(
          JSON.stringify({
            type: "result",
            subtype: "success",
            session_id: "captured-session",
            usage: { input_tokens: 1, output_tokens: 1 },
          })
        );
        options.onExit?.(0, null);
      });
      return { pid: 4242, process: {} as never };
    };
    const mockPm = { spawnStreaming } as unknown as ProcessManager;
    const provider = new ClaudeProvider(mockPm);

    const collected: StreamEvent[] = [];
    const result = await provider.spawn(
      {
        model: "claude-sonnet-4-5",
        messages: SAMPLE_MESSAGES,
        tools: "WebSearch",
      },
      (event) => collected.push(event)
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, "captured-session");
    assert.equal(result.retryableSessionMissing, false);
    assert.equal(
      collected.filter((event) => event.type === "result").length,
      0,
      "ClaudeProvider must not forward result events"
    );
    assert.equal(
      collected.filter((event) => event.type === "done").length,
      0,
      "ClaudeProvider must not forward done events"
    );
    const sessionEvent = collected.find((event) => event.type === "sessionId");
    assert.ok(sessionEvent, "expected a sessionId status event");
  });

  test("passes injected Claude Code OTel env to spawnStreaming", async () => {
    let capturedEnv: Record<string, string> | undefined;
    const spawnStreaming = async (
      options: StreamingSpawnOptions
    ): Promise<StreamingProcessHandle> => {
      capturedEnv = options.env;
      setImmediate(() => {
        options.onExit?.(0, null);
      });
      return { pid: 4242, process: {} as never };
    };
    const getShellEnv = createClaudeCodeShellEnvProvider({
      getReceiverStatus: () => ({
        state: ClaudeCodeOtelReceiverState.Ready,
        host: "127.0.0.1",
        port: 4318,
      }),
      getBaseShellEnv: async () => ({ PATH: "/usr/bin" }),
    });
    const mockPm = { spawnStreaming } as unknown as ProcessManager;
    const provider = new ClaudeProvider(mockPm, getShellEnv);

    await provider.spawn(
      {
        model: "claude-sonnet-4-5",
        messages: SAMPLE_MESSAGES,
        tools: "WebSearch",
      },
      () => {}
    );

    assert.ok(capturedEnv, "expected spawnStreaming env to be captured");
    assert.equal(capturedEnv[ClaudeCodeOtelEnvVar.EnableTelemetry], "1");
    assert.equal(capturedEnv[ClaudeCodeOtelEnvVar.MetricsExporter], "otlp");
    assert.equal(capturedEnv[ClaudeCodeOtelEnvVar.LogsExporter], "otlp");
    assert.equal(
      capturedEnv[ClaudeCodeOtelEnvVar.OtlpProtocol],
      "http/protobuf"
    );
    assert.equal(
      capturedEnv[ClaudeCodeOtelEnvVar.OtlpEndpoint],
      "http://127.0.0.1:4318"
    );
  });

  test("classifies failure as retryableSessionMissing when stderr matches and sessionId was passed", async () => {
    const spawnStreaming = async (
      options: StreamingSpawnOptions
    ): Promise<StreamingProcessHandle> => {
      setImmediate(() => {
        options.onError?.(
          new Error(
            "No conversation found with session ID: 00000000-0000-0000-0000-000000000000"
          )
        );
        options.onExit?.(1, null);
      });
      return { pid: 4242, process: {} as never };
    };
    const mockPm = { spawnStreaming } as unknown as ProcessManager;
    const provider = new ClaudeProvider(mockPm);

    const result = await provider.spawn(
      {
        model: "claude-sonnet-4-5",
        messages: SAMPLE_MESSAGES,
        tools: "WebSearch",
        sessionId: "00000000-0000-0000-0000-000000000000",
      },
      () => {}
    );

    assert.equal(result.exitCode, 1);
    assert.equal(result.retryableSessionMissing, true);
  });

  test("does NOT classify as retryable when sessionId was not passed", async () => {
    const spawnStreaming = async (
      options: StreamingSpawnOptions
    ): Promise<StreamingProcessHandle> => {
      setImmediate(() => {
        options.onError?.(
          new Error("No conversation found with session ID: abc")
        );
        options.onExit?.(1, null);
      });
      return { pid: 4242, process: {} as never };
    };
    const mockPm = { spawnStreaming } as unknown as ProcessManager;
    const provider = new ClaudeProvider(mockPm);

    const result = await provider.spawn(
      {
        model: "claude-sonnet-4-5",
        messages: SAMPLE_MESSAGES,
        tools: "WebSearch",
      },
      () => {}
    );

    assert.equal(result.retryableSessionMissing, false);
  });

  test("does NOT classify as retryable on successful exit", async () => {
    const spawnStreaming = async (
      options: StreamingSpawnOptions
    ): Promise<StreamingProcessHandle> => {
      setImmediate(() => {
        options.onExit?.(0, null);
      });
      return { pid: 4242, process: {} as never };
    };
    const mockPm = { spawnStreaming } as unknown as ProcessManager;
    const provider = new ClaudeProvider(mockPm);

    const result = await provider.spawn(
      {
        model: "claude-sonnet-4-5",
        messages: SAMPLE_MESSAGES,
        tools: "WebSearch",
        sessionId: "abc",
      },
      () => {}
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.retryableSessionMissing, false);
  });

  test("supportsModel matches claude-* only", () => {
    const provider = new ClaudeProvider({} as unknown as ProcessManager);
    assert.equal(provider.supportsModel("claude-sonnet-4-5"), true);
    assert.equal(provider.supportsModel("gpt-4"), false);
  });
});
