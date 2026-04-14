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

import { ArtifactChatDrawer } from "../ArtifactChatDrawer";

const ARTIFACT_PROPS = {
  artifactId: "art-1",
  artifactSlug: "PLN-123",
  artifactTitle: "Test Plan",
  artifactType: "plan",
};

beforeEach(() => {
  capturedUseChatSessionOptions.value = undefined;
  capturedChatPanelProps.value = null;
  vi.clearAllMocks();
});

describe("ArtifactChatDrawer", () => {
  test("passes chatKey derived from artifactId to useChatSession", () => {
    mockUseQuery.mockReturnValue({ data: undefined });
    render(<ArtifactChatDrawer {...ARTIFACT_PROPS} />);
    expect(capturedUseChatSessionOptions.value?.chatKey).toBe("artifact:art-1");
  });

  test("passes provider 'claude' and non-empty context to useChatSession", () => {
    mockUseQuery.mockReturnValue({ data: undefined });
    render(<ArtifactChatDrawer {...ARTIFACT_PROPS} />);
    expect(capturedUseChatSessionOptions.value?.provider).toBe("claude");
    expect(capturedUseChatSessionOptions.value?.context).toBeDefined();
    expect(capturedUseChatSessionOptions.value?.context.length).toBeGreaterThan(
      0
    );
    expect(capturedUseChatSessionOptions.value?.context).toContain(
      "Artifact type: plan"
    );
    expect(capturedUseChatSessionOptions.value?.context).toContain(
      "Slug: PLN-123"
    );
  });

  test("does not pass a cwd (artifact mode never sets one)", () => {
    mockUseQuery.mockReturnValue({ data: undefined });
    render(<ArtifactChatDrawer {...ARTIFACT_PROPS} />);
    expect(capturedUseChatSessionOptions.value?.cwd).toBeUndefined();
  });

  test("renders ChatPanel with welcomeMessage matching the artifact type label", () => {
    mockUseQuery.mockReturnValue({ data: undefined });
    render(<ArtifactChatDrawer {...ARTIFACT_PROPS} />);
    expect(capturedChatPanelProps.value?.welcomeMessage).toBe(
      "Ask me anything about this plan."
    );
  });
});
