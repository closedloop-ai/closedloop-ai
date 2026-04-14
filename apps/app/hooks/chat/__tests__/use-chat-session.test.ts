import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createWrapper } from "@/hooks/queries/__tests__/test-utils";

// --- Mocks (must precede hook import) ---

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@/hooks/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const mockEnsureFresh = vi.fn();
vi.mock("@/hooks/chat/use-chat-runner-token", () => ({
  useChatRunnerToken: () => ({
    data: null,
    isLoading: false,
    ensureFresh: mockEnsureFresh,
  }),
}));

const mockChatStreamSend = vi.fn();
vi.mock("@/hooks/chat/use-chat-stream", () => ({
  useChatStream: () => ({
    streamingContent: "",
    streamingBlocks: [],
    isStreaming: false,
    error: null,
    pendingUserMessage: null,
    setPendingUserMessage: vi.fn(),
    sendMessage: mockChatStreamSend,
    stopStreaming: vi.fn(),
    streamStartedAt: "",
    contextPercent: null,
  }),
}));

const mockElectronDetection = {
  detected: false,
  loading: false,
  port: null,
  version: null,
  machineName: null,
  capabilities: null,
  checkedAt: null,
};
vi.mock("@/lib/engineer/electron-detection", () => ({
  useElectronDetection: () => mockElectronDetection,
}));

const mockRoutingSelection = {
  mode: EngineerRoutingMode.CloudRelay as
    | typeof EngineerRoutingMode.CloudRelay
    | typeof EngineerRoutingMode.LocalElectron,
  computeTargetId: "ct-1" as string | null,
  source: "default",
  updatedAt: "2026-04-12T00:00:00.000Z",
};
vi.mock("@/lib/engineer/routing-store", () => ({
  useEngineerRoutingSelection: () => mockRoutingSelection,
}));

// --- Imports (after mocks) ---

import type { StreamErrorEvent } from "@/lib/chat/chat-utils";
import { useChatSession } from "../use-chat-session";

const CHAT_KEY = "artifact:plan-1";
const PROVIDER = "claude" as const;

const SAMPLE_CHAT = {
  id: "chat-uuid",
  chatKey: CHAT_KEY,
  userId: "user-1",
  organizationId: "org-1",
  provider: "claude" as const,
  model: "claude-sonnet-4-5",
  messages: [
    {
      id: "user-1",
      role: "user" as const,
      content: "earlier message",
      timestamp: "2026-04-12T00:00:00.000Z",
    },
  ],
  sessionId: null,
  context: null,
  createdAt: "2026-04-12T00:00:00.000Z",
  updatedAt: "2026-04-12T00:00:00.000Z",
};

const DEFAULT_CREDENTIALS = {
  token: "runner-token-abc",
  apiBaseUrl: "http://localhost:3002",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockElectronDetection.detected = false;
  mockRoutingSelection.mode = EngineerRoutingMode.CloudRelay;
  mockRoutingSelection.computeTargetId = "ct-1";
  mockChatStreamSend.mockResolvedValue(undefined);
  mockEnsureFresh.mockResolvedValue(DEFAULT_CREDENTIALS);
  mockApiClient.get.mockResolvedValue({ chat: null });
  mockApiClient.delete.mockResolvedValue({ deleted: true });
});

describe("useChatSession — initial state and history", () => {
  test("does not fetch history when chatKey is empty", () => {
    const { result } = renderHook(
      () =>
        useChatSession({
          chatKey: "",
          context: "ctx",
          provider: PROVIDER,
        }),
      { wrapper: createWrapper() }
    );
    expect(mockApiClient.get).not.toHaveBeenCalled();
    expect(result.current.messages).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  test("loads existing messages via GET /chat-sessions on mount", async () => {
    mockApiClient.get.mockResolvedValue({ chat: SAMPLE_CHAT });

    const { result } = renderHook(
      () =>
        useChatSession({
          chatKey: CHAT_KEY,
          context: "ctx",
          provider: PROVIDER,
        }),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0].content).toBe("earlier message");
    expect(result.current.currentProvider).toBe("claude");
    expect(result.current.currentModel).toBe("claude-sonnet-4-5");
    expect(mockApiClient.get).toHaveBeenCalledWith(
      `/chat-sessions?chatKey=${encodeURIComponent(CHAT_KEY)}`
    );
  });
});

describe("useChatSession — sendMessage guards", () => {
  test("does nothing when input is empty/whitespace", async () => {
    const { result } = renderHook(
      () =>
        useChatSession({
          chatKey: CHAT_KEY,
          context: "ctx",
          provider: PROVIDER,
        }),
      { wrapper: createWrapper() }
    );

    act(() => {
      result.current.setInputValue("   ");
    });
    await act(async () => {
      await result.current.sendMessage();
    });

    expect(mockChatStreamSend).not.toHaveBeenCalled();
    expect(mockEnsureFresh).not.toHaveBeenCalled();
  });

  test("sets local error when CloudRelay has no compute target", async () => {
    mockRoutingSelection.computeTargetId = null;

    const { result } = renderHook(
      () =>
        useChatSession({
          chatKey: CHAT_KEY,
          context: "ctx",
          provider: PROVIDER,
        }),
      { wrapper: createWrapper() }
    );

    act(() => {
      result.current.setInputValue("hi");
    });
    await act(async () => {
      await result.current.sendMessage();
    });

    expect(result.current.error).toContain("compute target");
    expect(mockChatStreamSend).not.toHaveBeenCalled();
    expect(mockEnsureFresh).not.toHaveBeenCalled();
  });

  test("sets local error when LocalElectron gateway is not detected", async () => {
    mockRoutingSelection.mode = EngineerRoutingMode.LocalElectron;
    mockElectronDetection.detected = false;

    const { result } = renderHook(
      () =>
        useChatSession({
          chatKey: CHAT_KEY,
          context: "ctx",
          provider: PROVIDER,
        }),
      { wrapper: createWrapper() }
    );

    act(() => {
      result.current.setInputValue("hi");
    });
    await act(async () => {
      await result.current.sendMessage();
    });

    expect(result.current.error).toContain("Local Electron gateway");
    expect(mockChatStreamSend).not.toHaveBeenCalled();
    expect(mockEnsureFresh).not.toHaveBeenCalled();
  });

  test("sets local error when runner-token mint fails", async () => {
    mockEnsureFresh.mockResolvedValue(null);

    const { result } = renderHook(
      () =>
        useChatSession({
          chatKey: CHAT_KEY,
          context: "ctx",
          provider: PROVIDER,
        }),
      { wrapper: createWrapper() }
    );

    act(() => {
      result.current.setInputValue("hi");
    });
    await act(async () => {
      await result.current.sendMessage();
    });

    expect(result.current.error).toContain("authorize");
    expect(mockChatStreamSend).not.toHaveBeenCalled();
  });
});

describe("useChatSession — sendMessage single flow", () => {
  test("POSTs to /api/engineer/chat exactly once with the minimal body shape", async () => {
    const { result } = renderHook(
      () =>
        useChatSession({
          chatKey: CHAT_KEY,
          context: "doc-ctx",
          provider: PROVIDER,
          model: "claude-sonnet-4-5",
          cwd: "/work/repo",
        }),
      { wrapper: createWrapper() }
    );

    act(() => {
      result.current.setInputValue("hello world");
    });
    await act(async () => {
      await result.current.sendMessage();
    });

    expect(mockChatStreamSend).toHaveBeenCalledTimes(1);
    const [url, body] = mockChatStreamSend.mock.calls[0];
    expect(url).toBe("/api/engineer/chat");
    expect(body.chatKey).toBe(CHAT_KEY);
    expect(body.provider).toBe(PROVIDER);
    expect(body.model).toBe("claude-sonnet-4-5");
    expect(body.context).toBe("doc-ctx");
    expect(body.cwd).toBe("/work/repo");
    expect(body.apiBaseUrl).toBe(DEFAULT_CREDENTIALS.apiBaseUrl);
    expect(body.apiAuthToken).toBe(DEFAULT_CREDENTIALS.token);
    expect(body.userMessage).toMatchObject({
      role: "user",
      content: "hello world",
    });
    expect(typeof body.userMessage.id).toBe("string");
    expect(typeof body.userMessage.timestamp).toBe("string");
  });

  test("resolves model from DEFAULT_CHAT_MODELS when not provided", async () => {
    const { result } = renderHook(
      () =>
        useChatSession({
          chatKey: CHAT_KEY,
          context: "ctx",
          provider: PROVIDER,
        }),
      { wrapper: createWrapper() }
    );

    act(() => {
      result.current.setInputValue("hi");
    });
    await act(async () => {
      await result.current.sendMessage();
    });

    const [, body] = mockChatStreamSend.mock.calls[0];
    expect(body.model).toBe("claude-sonnet-4-5");
  });

  test("clears composer immediately after send resolves without errors", async () => {
    const { result } = renderHook(
      () =>
        useChatSession({
          chatKey: CHAT_KEY,
          context: "ctx",
          provider: PROVIDER,
        }),
      { wrapper: createWrapper() }
    );

    act(() => {
      result.current.setInputValue("draft text");
    });
    await act(async () => {
      await result.current.sendMessage();
    });

    expect(result.current.inputValue).toBe("");
  });
});

describe("useChatSession — onError handling", () => {
  async function runErrorCase(
    err: StreamErrorEvent,
    opts: { draft?: string; onProviderMismatch?: (p: string) => void } = {}
  ) {
    let capturedOnError: ((err: StreamErrorEvent) => void) | undefined;
    mockChatStreamSend.mockImplementation(
      (
        _url: string,
        _body: Record<string, unknown>,
        callbacks?: { onError?: (err: StreamErrorEvent) => void }
      ) => {
        capturedOnError = callbacks?.onError;
        return Promise.resolve();
      }
    );

    const { result } = renderHook(
      () =>
        useChatSession({
          chatKey: CHAT_KEY,
          context: "ctx",
          provider: PROVIDER,
          onProviderMismatch: opts.onProviderMismatch,
        }),
      { wrapper: createWrapper() }
    );

    const draft = opts.draft ?? "hi there";
    act(() => {
      result.current.setInputValue(draft);
    });
    await act(async () => {
      await result.current.sendMessage();
    });

    if (!capturedOnError) {
      throw new Error("chatStream.sendMessage was not invoked with onError");
    }
    const onError = capturedOnError;
    act(() => {
      onError(err);
    });

    return { result, draft };
  }

  test("phase 'upsert' restores the draft to inputValue", async () => {
    const { result, draft } = await runErrorCase({
      phase: "upsert",
      message: "upsert failed",
    });
    expect(result.current.inputValue).toBe(draft);
    expect(result.current.error).toBe("upsert failed");
  });

  test("phase 'spawn' does NOT restore the draft", async () => {
    const { result } = await runErrorCase({
      phase: "spawn",
      message: "gateway spawn failed",
    });
    expect(result.current.inputValue).toBe("");
    expect(result.current.error).toBe("gateway spawn failed");
  });

  test("phase 'complete' does NOT restore the draft", async () => {
    const { result } = await runErrorCase({
      phase: "complete",
      message: "finalize failed",
    });
    expect(result.current.inputValue).toBe("");
    expect(result.current.error).toBe("finalize failed");
  });

  test("legacy string-form error with undefined phase does NOT restore the draft", async () => {
    const { result } = await runErrorCase({
      message: "stream dropped",
    });
    expect(result.current.inputValue).toBe("");
    expect(result.current.error).toBe("stream dropped");
  });

  test("PROVIDER_MISMATCH (phase 'upsert') calls onProviderMismatch AND restores the draft", async () => {
    const onProviderMismatch = vi.fn();
    const { result, draft } = await runErrorCase(
      {
        phase: "upsert",
        code: "PROVIDER_MISMATCH",
        boundProvider: "codex",
        message: "Chat is bound to a different provider",
      },
      { onProviderMismatch }
    );
    expect(onProviderMismatch).toHaveBeenCalledWith("codex");
    expect(result.current.inputValue).toBe(draft);
    expect(result.current.error).toBe("Chat is bound to a different provider");
  });
});

describe("useChatSession — optimistic pending user message", () => {
  test("appends the user message to the transcript while the stream is in flight", async () => {
    // Hold the stream promise open so we can observe the intermediate state.
    let resolveSend: (() => void) | undefined;
    mockChatStreamSend.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        })
    );

    const { result } = renderHook(
      () =>
        useChatSession({
          chatKey: CHAT_KEY,
          context: "ctx",
          provider: PROVIDER,
        }),
      { wrapper: createWrapper() }
    );

    act(() => {
      result.current.setInputValue("first message");
    });

    // Kick off sendMessage without awaiting; it will suspend inside
    // chatStream.sendMessage until we resolve the captured promise.
    let sendPromise: Promise<void> = Promise.resolve();
    await act(async () => {
      sendPromise = result.current.sendMessage();
      // Let the microtasks run so ensureFresh resolves and
      // setPendingUserMessage lands in React state before we assert.
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(1);
    });
    expect(result.current.messages[0].role).toBe("user");
    expect(result.current.messages[0].content).toBe("first message");
    expect(result.current.inputValue).toBe("");

    // Resolve the held stream so the hook can finish.
    act(() => {
      resolveSend?.();
    });
    await act(async () => {
      await sendPromise;
    });
  });

  test("does not duplicate the user message once history refetches with the same id", async () => {
    // Capture the userMessage id used by the hook so the refetched history
    // can include it verbatim.
    let capturedUserMessage: { id: string; content: string } | undefined;
    mockChatStreamSend.mockImplementation((_url, body) => {
      capturedUserMessage = (
        body as { userMessage: typeof capturedUserMessage }
      ).userMessage;
      return Promise.resolve();
    });

    // First get: empty history. Subsequent gets: include the user message
    // (simulates the post-stream invalidate + refetch).
    mockApiClient.get
      .mockResolvedValueOnce({ chat: null })
      .mockImplementation(() =>
        Promise.resolve({
          chat: {
            ...SAMPLE_CHAT,
            messages: capturedUserMessage
              ? [
                  {
                    ...capturedUserMessage,
                    role: "user",
                    timestamp: "2026-04-12T00:00:00.000Z",
                  },
                ]
              : [],
          },
        })
      );

    const { result } = renderHook(
      () =>
        useChatSession({
          chatKey: CHAT_KEY,
          context: "ctx",
          provider: PROVIDER,
        }),
      { wrapper: createWrapper() }
    );

    act(() => {
      result.current.setInputValue("hello world");
    });
    await act(async () => {
      await result.current.sendMessage();
    });

    // Exactly one user message with that content — the pending copy should
    // have been cleared once the persisted copy arrived.
    await waitFor(() => {
      const userMessages = result.current.messages.filter(
        (m) => m.role === "user" && m.content === "hello world"
      );
      expect(userMessages).toHaveLength(1);
    });
  });

  test("upsert-phase error clears the optimistic message (nothing persisted)", async () => {
    let capturedOnError: ((err: StreamErrorEvent) => void) | undefined;
    mockChatStreamSend.mockImplementation(
      (
        _url: string,
        _body: Record<string, unknown>,
        callbacks?: { onError?: (err: StreamErrorEvent) => void }
      ) => {
        capturedOnError = callbacks?.onError;
        return Promise.resolve();
      }
    );

    const { result } = renderHook(
      () =>
        useChatSession({
          chatKey: CHAT_KEY,
          context: "ctx",
          provider: PROVIDER,
        }),
      { wrapper: createWrapper() }
    );

    act(() => {
      result.current.setInputValue("hi");
    });
    await act(async () => {
      await result.current.sendMessage();
    });

    // Simulate the gateway reporting an upsert-phase failure. Since the
    // user message was never persisted, the draft is restored AND the
    // optimistic copy is removed from the transcript.
    act(() => {
      capturedOnError?.({
        phase: "upsert",
        code: "BACKEND_ERROR",
        message: "upstream 500",
      });
    });

    expect(result.current.inputValue).toBe("hi");
    const userMessages = result.current.messages.filter(
      (m) => m.role === "user"
    );
    expect(userMessages).toHaveLength(0);
  });

  test("spawn-phase error keeps the optimistic message (user turn is persisted)", async () => {
    let capturedOnError: ((err: StreamErrorEvent) => void) | undefined;
    mockChatStreamSend.mockImplementation(
      (
        _url: string,
        _body: Record<string, unknown>,
        callbacks?: { onError?: (err: StreamErrorEvent) => void }
      ) => {
        capturedOnError = callbacks?.onError;
        return Promise.resolve();
      }
    );

    const { result } = renderHook(
      () =>
        useChatSession({
          chatKey: CHAT_KEY,
          context: "ctx",
          provider: PROVIDER,
        }),
      { wrapper: createWrapper() }
    );

    act(() => {
      result.current.setInputValue("keep me");
    });
    await act(async () => {
      await result.current.sendMessage();
    });

    // Spawn-phase failure: the user message is already persisted, so the
    // transcript must still show it (either via the optimistic copy or the
    // eventual refetch; both are acceptable).
    act(() => {
      capturedOnError?.({
        phase: "spawn",
        message: "claude crashed",
      });
    });

    expect(result.current.inputValue).toBe("");
    const userMessages = result.current.messages.filter(
      (m) => m.role === "user" && m.content === "keep me"
    );
    expect(userMessages.length).toBeGreaterThanOrEqual(1);
  });
});

describe("useChatSession — clearHistory", () => {
  test("calls apiClient.delete with the exact URL string", async () => {
    const { result } = renderHook(
      () =>
        useChatSession({
          chatKey: CHAT_KEY,
          context: "ctx",
          provider: PROVIDER,
        }),
      { wrapper: createWrapper() }
    );

    await act(async () => {
      await result.current.clearHistory();
    });

    expect(mockApiClient.delete).toHaveBeenCalledTimes(1);
    expect(mockApiClient.delete).toHaveBeenCalledWith(
      `/chat-sessions?chatKey=${encodeURIComponent(CHAT_KEY)}`
    );
  });

  test("does nothing when chatKey is empty", async () => {
    const { result } = renderHook(
      () =>
        useChatSession({
          chatKey: "",
          context: "ctx",
          provider: PROVIDER,
        }),
      { wrapper: createWrapper() }
    );

    await act(async () => {
      await result.current.clearHistory();
    });

    expect(mockApiClient.delete).not.toHaveBeenCalled();
  });
});
