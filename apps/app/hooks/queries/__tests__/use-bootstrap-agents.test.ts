import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { BootstrapStatus, useBootstrapAgents } from "../use-bootstrap-agents";
import { createWrapper } from "./test-utils";

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@/hooks/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

vi.mock("../use-agents", () => ({
  agentKeys: {
    all: ["agents"] as const,
    lists: () => ["agents", "list"] as const,
    list: (filters: Record<string, unknown>) =>
      ["agents", "list", filters] as const,
    details: () => ["agents", "detail"] as const,
    detail: (id: string) => ["agents", "detail", id] as const,
  },
}));

vi.mock("../use-loops", () => ({
  loopKeys: {
    all: ["loops"] as const,
    lists: () => ["loops", "list"] as const,
    list: (filters: Record<string, unknown>) =>
      ["loops", "list", filters] as const,
    details: () => ["loops", "detail"] as const,
    detail: (id: string) => ["loops", "detail", id] as const,
    events: (id: string) => ["loops", "detail", id, "events"] as const,
  },
}));

describe("useBootstrapAgents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("starts in idle state", () => {
    const { result } = renderHook(() => useBootstrapAgents(), {
      wrapper: createWrapper(),
    });

    expect(result.current.state.status).toBe(BootstrapStatus.Idle);
  });

  test("transitions to creating on dispatch", () => {
    mockApiClient.post.mockReturnValueOnce(new Promise(() => {}));

    const { result } = renderHook(() => useBootstrapAgents(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.dispatch([{ fullName: "org/repo" }]);
    });

    expect(result.current.state.status).toBe(BootstrapStatus.Creating);
  });

  test("transitions to dispatched after API responds with loopId", async () => {
    mockApiClient.post.mockResolvedValueOnce({ loopId: "loop-123" });

    const { result } = renderHook(() => useBootstrapAgents(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.dispatch([{ fullName: "org/repo" }]);
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe(BootstrapStatus.Dispatched);
    });

    if (result.current.state.status === BootstrapStatus.Dispatched) {
      expect(result.current.state.loopId).toBe("loop-123");
    }
  });

  test("handles bootstrap start error", async () => {
    mockApiClient.post.mockRejectedValueOnce(new Error("Server unavailable"));

    const { result } = renderHook(() => useBootstrapAgents(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.dispatch([{ fullName: "org/repo" }]);
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe(BootstrapStatus.Error);
    });

    if (result.current.state.status === BootstrapStatus.Error) {
      expect(result.current.state.error).toBe("Server unavailable");
    }
  });

  test("sends correct bootstrap start payload", async () => {
    mockApiClient.post.mockResolvedValueOnce({ loopId: "loop-456" });

    const { result } = renderHook(() => useBootstrapAgents(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.dispatch([
        { fullName: "org/repo-a" },
        { fullName: "org/repo-b" },
      ]);
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe(BootstrapStatus.Dispatched);
    });

    expect(mockApiClient.post).toHaveBeenCalledWith("/agents/bootstrap/start", {
      repos: [{ fullName: "org/repo-a" }, { fullName: "org/repo-b" }],
    });
  });

  test("reset returns to idle", async () => {
    mockApiClient.post.mockReturnValueOnce(new Promise(() => {}));

    const { result } = renderHook(() => useBootstrapAgents(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.dispatch([{ fullName: "org/repo" }]);
    });

    expect(result.current.state.status).toBe(BootstrapStatus.Creating);

    act(() => {
      result.current.reset();
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe(BootstrapStatus.Idle);
    });
  });
});
