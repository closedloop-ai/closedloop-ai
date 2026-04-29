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

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

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

  test("transitions to running on dispatch", () => {
    mockFetch.mockReturnValueOnce(new Promise(() => {}));

    const { result } = renderHook(() => useBootstrapAgents(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.dispatch([{ fullName: "org/repo" }]);
    });

    expect(result.current.state.status).toBe(BootstrapStatus.Running);
  });

  test("handles gateway error response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "Gateway unavailable" }),
    });

    const { result } = renderHook(() => useBootstrapAgents(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.dispatch([{ fullName: "org/repo" }]);
    });

    expect(result.current.state.status).toBe(BootstrapStatus.Error);
    if (result.current.state.status === BootstrapStatus.Error) {
      expect(result.current.state.error).toBe("Gateway unavailable");
    }
  });

  test("ingests results from successful bootstrap", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          type: "bootstrap:result",
          success: true,
          repos: [
            {
              fullName: "org/repo",
              success: true,
              agents: [
                {
                  name: "Test Agent",
                  slug: "test-agent",
                  role: "test-agent",
                  description: "Test description",
                  prompt: "---\nname: test-agent\n---\nPrompt body",
                },
              ],
              criticGates: null,
              metadata: null,
              duration: 1000,
            },
          ],
          totalDuration: 1000,
        }),
    });

    mockApiClient.post.mockResolvedValueOnce({
      created: 1,
      updated: 0,
      agents: [{ id: "1", name: "Test Agent", slug: "test-agent" }],
    });

    const { result } = renderHook(() => useBootstrapAgents(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.dispatch([{ fullName: "org/repo" }]);
    });

    expect(result.current.state.status).toBe(BootstrapStatus.Completed);
    if (result.current.state.status === BootstrapStatus.Completed) {
      expect(result.current.state.result.totalCreated).toBe(1);
      expect(result.current.state.result.totalUpdated).toBe(0);
      expect(result.current.state.result.repoSummaries).toHaveLength(1);
      expect(result.current.state.result.repoSummaries[0].success).toBe(true);
      expect(result.current.state.result.repoSummaries[0].agentCount).toBe(1);
    }

    expect(mockApiClient.post).toHaveBeenCalledWith(
      "/agents/bulk-ingest",
      expect.objectContaining({
        sourceRepo: "org/repo",
        agents: [
          expect.objectContaining({
            name: "Test Agent",
            role: "test-agent",
          }),
        ],
      })
    );
  });

  test("handles partial repo failures", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          type: "bootstrap:result",
          success: true,
          repos: [
            {
              fullName: "org/good-repo",
              success: true,
              agents: [
                {
                  name: "Agent",
                  slug: "agent",
                  role: "agent",
                  description: "desc",
                  prompt: "prompt",
                },
              ],
              criticGates: null,
              metadata: null,
              duration: 500,
            },
            {
              fullName: "org/bad-repo",
              success: false,
              error: "Clone failed",
              agents: [],
              criticGates: null,
              metadata: null,
              duration: 100,
            },
          ],
          totalDuration: 600,
        }),
    });

    mockApiClient.post.mockResolvedValueOnce({
      created: 1,
      updated: 0,
      agents: [{ id: "1", name: "Agent", slug: "agent" }],
    });

    const { result } = renderHook(() => useBootstrapAgents(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.dispatch([
        { fullName: "org/good-repo" },
        { fullName: "org/bad-repo" },
      ]);
    });

    expect(result.current.state.status).toBe(BootstrapStatus.Completed);
    if (result.current.state.status === BootstrapStatus.Completed) {
      const { repoSummaries } = result.current.state.result;
      expect(repoSummaries).toHaveLength(2);
      expect(repoSummaries[0].success).toBe(true);
      expect(repoSummaries[1].success).toBe(false);
      expect(repoSummaries[1].error).toBe("Clone failed");
    }
  });

  test("reset returns to idle and aborts in-flight request", async () => {
    mockFetch.mockReturnValueOnce(new Promise(() => {}));

    const { result } = renderHook(() => useBootstrapAgents(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.dispatch([{ fullName: "org/repo" }]);
    });

    expect(result.current.state.status).toBe(BootstrapStatus.Running);

    act(() => {
      result.current.reset();
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe(BootstrapStatus.Idle);
    });
  });

  test("sends correct gateway request payload", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ error: "Not connected" }),
    });

    const { result } = renderHook(() => useBootstrapAgents(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.dispatch([
        { fullName: "org/repo-a" },
        { fullName: "org/repo-b" },
      ]);
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/gateway/bootstrap",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "bootstrap",
          repos: [{ fullName: "org/repo-a" }, { fullName: "org/repo-b" }],
          options: { depth: "medium" },
        }),
      })
    );
  });
});
