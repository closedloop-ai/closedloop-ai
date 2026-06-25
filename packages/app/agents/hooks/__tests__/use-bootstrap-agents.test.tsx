import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { BootstrapStatus, useBootstrapAgents } from "../use-bootstrap-agents";

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
};

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

let mockStoredLoopId: string | null = null;
const mockSetStoredLoopId = vi.fn((value: string | null) => {
  mockStoredLoopId = value;
});

vi.mock("../../../shared/hooks/use-local-storage-state", () => ({
  useLocalStorageState: () => [mockStoredLoopId, mockSetStoredLoopId],
}));

vi.mock("../../../shared/auth/use-auth-snapshot", () => ({
  useAuthSnapshot: () => ({
    isLoaded: true,
    userId: "user-test-123",
    orgId: "org-test-123",
    getToken: () => Promise.resolve("test-token"),
  }),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useBootstrapAgents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStoredLoopId = null;
    // Default: loop polling returns a pending promise (doesn't resolve)
    mockApiClient.get.mockReturnValue(new Promise(() => {}));
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

  test("stores loopId via setter on dispatch", async () => {
    mockApiClient.post.mockResolvedValueOnce({ loopId: "loop-persist" });

    const { result } = renderHook(() => useBootstrapAgents(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.dispatch([{ fullName: "org/repo" }]);
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe(BootstrapStatus.Dispatched);
    });

    expect(mockSetStoredLoopId).toHaveBeenCalledWith("loop-persist");
  });

  test("clears stored loopId on reset", () => {
    const { result } = renderHook(() => useBootstrapAgents(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.reset();
    });

    expect(result.current.state.status).toBe(BootstrapStatus.Idle);
    expect(mockSetStoredLoopId).toHaveBeenCalledWith(null);
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

  test("reset returns to idle from creating", () => {
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

    expect(result.current.state.status).toBe(BootstrapStatus.Idle);
  });

  test("recovers active bootstrap from stored loopId on mount", async () => {
    mockStoredLoopId = "loop-recover";

    const { result } = renderHook(() => useBootstrapAgents(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe(BootstrapStatus.Running);
    });

    if (result.current.state.status === BootstrapStatus.Running) {
      expect(result.current.state.loopId).toBe("loop-recover");
    }
  });
});
