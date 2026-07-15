import type { TokenTrendResponse } from "@repo/api/src/types/agent-component-analytics";
import { createWrapper } from "@repo/app/shared/test-utils";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentComponentTokenTrendKeys,
  useAgentComponentTokenTrend,
} from "../use-agent-component-token-trend";

// Mock useApiClient — the token-trend hook calls it directly (no data-source).
const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const response: TokenTrendResponse = {
  slug: "skill::rtk",
  models: ["claude-opus-4-5"],
  points: [
    {
      sessionId: "sess-1",
      sessionStartedAt: "2026-06-01T10:00:00.000Z",
      model: "claude-opus-4-5",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0.12,
      runtimeMs: 5000,
      componentInvocations: 3,
      componentErrorCount: 0,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("agentComponentTokenTrendKeys", () => {
  it("detail() is scoped per slug + user and distinct from the ranking slice", () => {
    expect(agentComponentTokenTrendKeys.detail("skill::rtk")).toEqual([
      "agent-component-token-trend",
      "skill::rtk",
      "all",
    ]);
    expect(agentComponentTokenTrendKeys.detail("skill::rtk", "user-1")).toEqual(
      ["agent-component-token-trend", "skill::rtk", "user-1"]
    );
    expect(agentComponentTokenTrendKeys.detail("a")).not.toEqual(
      agentComponentTokenTrendKeys.detail("b")
    );
  });
});

describe("useAgentComponentTokenTrend", () => {
  it("GETs the URL-encoded slug token-trend endpoint (success state)", async () => {
    mockApiClient.get.mockResolvedValueOnce(response);

    const { result } = renderHook(
      () => useAgentComponentTokenTrend("skill::rtk"),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(response);
    // "skill::rtk" must be percent-encoded on the wire (":" -> "%3A").
    expect(mockApiClient.get).toHaveBeenCalledWith(
      "/agent-components/skill%3A%3Artk/token-trend"
    );
  });

  it("appends the userId query param when provided", async () => {
    mockApiClient.get.mockResolvedValueOnce(response);

    const { result } = renderHook(
      () => useAgentComponentTokenTrend("skill::rtk", "user-1"),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockApiClient.get).toHaveBeenCalledWith(
      "/agent-components/skill%3A%3Artk/token-trend?userId=user-1"
    );
  });

  it("is disabled for an empty slug — never calls the API", () => {
    renderHook(() => useAgentComponentTokenTrend(""), {
      wrapper: createWrapper(),
    });
    expect(mockApiClient.get).not.toHaveBeenCalled();
  });

  it("surfaces isError when the request fails", async () => {
    mockApiClient.get.mockRejectedValueOnce(new Error("500"));

    const { result } = renderHook(
      () => useAgentComponentTokenTrend("skill::rtk"),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
