import { render } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mockUseQuery = vi.fn();
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query"
  );
  return {
    ...actual,
    useQuery: (...args: unknown[]) => mockUseQuery(...args),
  };
});

const capturedUseChatSessionOptions: {
  value:
    | {
        chatKey: string;
        provider: string;
        context: string;
        cwd?: string;
      }
    | undefined;
} = { value: undefined };

vi.mock("@/hooks/chat/use-chat-session", () => ({
  useChatSession: (opts: {
    chatKey: string;
    provider: string;
    context: string;
    cwd?: string;
  }) => {
    capturedUseChatSessionOptions.value = opts;
    return {
      messages: [],
      isLoading: false,
      isStreaming: false,
      streamingContent: "",
      streamingBlocks: [],
      streamStartedAt: "",
      contextPercent: null,
      error: null,
      inputValue: "",
      setInputValue: vi.fn(),
      sendMessage: vi.fn(),
      stopStreaming: vi.fn(),
      clearHistory: vi.fn(),
      currentProvider: null,
      currentModel: null,
    };
  },
}));

const capturedChatPanelProps: { value: { welcomeMessage?: string } | null } = {
  value: null,
};

vi.mock("@/components/chat/ChatPanel", () => ({
  ChatPanel: (props: { welcomeMessage?: string }) => {
    capturedChatPanelProps.value = props;
    return null;
  },
}));

vi.mock("@/lib/engineer/queries/health-check", () => ({
  getHealthCheckTargetKey: (routing: {
    mode: string;
    computeTargetId: string | null;
  }) => `${routing.mode}:${routing.computeTargetId ?? "none"}`,
  healthCheckOptions: () => ({ queryKey: ["health"], queryFn: vi.fn() }),
}));

const mockUseRepoPath = vi.fn();
vi.mock("@/lib/engineer/queries/repo-path", () => ({
  useRepoPath: (...args: unknown[]) => mockUseRepoPath(...args),
}));

import { DocumentChatDrawer } from "../DocumentChatDrawer";

const ARTIFACT_PROPS = {
  documentId: "art-1",
  documentSlug: "PLN-123",
  documentTitle: "Test Plan",
  documentType: "plan",
};

beforeEach(() => {
  capturedUseChatSessionOptions.value = undefined;
  capturedChatPanelProps.value = null;
  vi.clearAllMocks();
  mockUseRepoPath.mockReturnValue({ repoPath: null, showNotice: false });
});

describe("DocumentChatDrawer", () => {
  test("passes chatKey derived from documentId to useChatSession", () => {
    mockUseQuery.mockReturnValue({ data: undefined });
    render(<DocumentChatDrawer {...ARTIFACT_PROPS} />);
    expect(capturedUseChatSessionOptions.value?.chatKey).toBe("artifact:art-1");
  });

  test("passes provider 'claude' and non-empty context to useChatSession", () => {
    mockUseQuery.mockReturnValue({ data: undefined });
    render(<DocumentChatDrawer {...ARTIFACT_PROPS} />);
    expect(capturedUseChatSessionOptions.value?.provider).toBe("claude");
    expect(capturedUseChatSessionOptions.value?.context).toBeDefined();
    expect(capturedUseChatSessionOptions.value?.context.length).toBeGreaterThan(
      0
    );
    expect(capturedUseChatSessionOptions.value?.context).toContain(
      "Document type: plan"
    );
    expect(capturedUseChatSessionOptions.value?.context).toContain(
      "Slug: PLN-123"
    );
  });

  test("does not pass a cwd when targetRepo is not provided", () => {
    mockUseQuery.mockReturnValue({ data: undefined });
    render(<DocumentChatDrawer {...ARTIFACT_PROPS} />);
    expect(capturedUseChatSessionOptions.value?.cwd).toBeUndefined();
  });

  test("passes resolved repo path as cwd when targetRepo is provided", () => {
    mockUseRepoPath.mockReturnValue({
      repoPath: "/Users/alice/src/acme/web",
      showNotice: false,
    });
    mockUseQuery.mockReturnValue({ data: undefined });
    render(<DocumentChatDrawer {...ARTIFACT_PROPS} targetRepo="acme/web" />);
    expect(mockUseRepoPath).toHaveBeenCalledWith("acme/web");
    expect(capturedUseChatSessionOptions.value?.cwd).toBe(
      "/Users/alice/src/acme/web"
    );
  });

  test("does not pass a cwd when repo path resolves to null", () => {
    mockUseRepoPath.mockReturnValue({ repoPath: null, showNotice: false });
    mockUseQuery.mockReturnValue({ data: undefined });
    render(<DocumentChatDrawer {...ARTIFACT_PROPS} targetRepo="acme/web" />);
    expect(capturedUseChatSessionOptions.value?.cwd).toBeUndefined();
  });

  test("renders ChatPanel with welcomeMessage matching the artifact type label", () => {
    mockUseQuery.mockReturnValue({ data: undefined });
    render(<DocumentChatDrawer {...ARTIFACT_PROPS} />);
    expect(capturedChatPanelProps.value?.welcomeMessage).toBe(
      "Ask me anything about this plan."
    );
  });
});
