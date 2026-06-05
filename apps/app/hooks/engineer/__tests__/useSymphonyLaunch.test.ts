import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSymphonyLaunch } from "@/hooks/engineer/useSymphonyLaunch";

// Mock fetch globally
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function makeJsonResponse(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("useSymphonyLaunch", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    // Default: sessions load returns empty
    fetchMock.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/sessions")) {
        return Promise.resolve(makeJsonResponse({ sessions: [] }));
      }
      return Promise.resolve(makeJsonResponse({ error: "not mocked" }, 500));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("double-click guard: second concurrent call returns { launched: false }", async () => {
    // First launch call will hang until we resolve it
    let resolveLaunch!: (value: Response) => void;
    const launchPromise = new Promise<Response>((resolve) => {
      resolveLaunch = resolve;
    });

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (
        typeof url === "string" &&
        url.includes("/sessions") &&
        init?.method !== "POST"
      ) {
        return Promise.resolve(makeJsonResponse({ sessions: [] }));
      }
      if (typeof url === "string" && url.includes("/launch")) {
        return launchPromise;
      }
      if (
        typeof url === "string" &&
        url.includes("/sessions") &&
        init?.method === "POST"
      ) {
        return Promise.resolve(makeJsonResponse({ success: true }));
      }
      return Promise.resolve(makeJsonResponse({ error: "not mocked" }, 500));
    });

    const { result } = renderHook(() => useSymphonyLaunch());

    // Launch both inside a single act to avoid overlapping act scope warnings.
    // The first call enters the guard and blocks on fetch; the second call
    // synchronously sees the guard and returns { launched: false } immediately.
    let result1: { launched: boolean; alreadyRunning: boolean } | undefined;
    let result2: { launched: boolean; alreadyRunning: boolean } | undefined;

    // Kick off the act, then resolve the pending launch inside it
    await act(async () => {
      const promise1 = result.current.launch("AI-100", "/repo");
      // Second call on same tick — guard blocks it synchronously
      result2 = await result.current.launch("AI-100", "/repo");

      // Now resolve the first launch so promise1 settles
      resolveLaunch(
        makeJsonResponse({
          success: true,
          workDir: "/tmp/worktree",
          pid: 123,
          logFile: "/tmp/log",
          baseBranch: "main",
        })
      );

      result1 = await promise1;
    });

    expect(result2).toEqual({ launched: false, alreadyRunning: false });
    expect(result1).toEqual({ launched: true, alreadyRunning: false });
  });

  it("handles 409 polling: retries until 200, returns { launched: true }", async () => {
    let callCount = 0;

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (
        typeof url === "string" &&
        url.includes("/sessions") &&
        init?.method !== "POST"
      ) {
        return Promise.resolve(makeJsonResponse({ sessions: [] }));
      }
      if (typeof url === "string" && url.includes("/launch")) {
        callCount++;
        if (callCount <= 2) {
          return Promise.resolve(
            makeJsonResponse({ error: "Launch already in progress" }, 409)
          );
        }
        return Promise.resolve(
          makeJsonResponse({
            success: true,
            workDir: "/tmp/worktree",
            pid: 456,
            logFile: "/tmp/log",
            baseBranch: "main",
          })
        );
      }
      if (
        typeof url === "string" &&
        url.includes("/sessions") &&
        init?.method === "POST"
      ) {
        return Promise.resolve(makeJsonResponse({ success: true }));
      }
      return Promise.resolve(makeJsonResponse({ error: "not mocked" }, 500));
    });

    const { result } = renderHook(() => useSymphonyLaunch());

    let launchResult: { launched: boolean } | undefined;
    await act(async () => {
      launchResult = await result.current.launch("AI-200", "/repo");
    });

    expect(launchResult).toEqual({ launched: true, alreadyRunning: false });
    // Should have called launch endpoint 3 times (2 x 409, then 200)
    const launchCalls = fetchMock.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" && (call[0] as string).includes("/launch")
    );
    expect(launchCalls.length).toBe(3);
  });

  it("session merge: alreadyRunning with undefined metadata preserves existing local values", async () => {
    // Pre-populate sessions with existing metadata
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (
        typeof url === "string" &&
        url.includes("/sessions") &&
        init?.method !== "POST"
      ) {
        return Promise.resolve(
          makeJsonResponse({
            sessions: [
              {
                ticketId: "AI-300",
                repoPath: "/repo",
                worktreePath: "/tmp/wt",
                pid: 789,
                baseBranch: "develop",
                parentTicketId: "AI-250",
              },
            ],
          })
        );
      }
      if (typeof url === "string" && url.includes("/launch")) {
        // Server returns alreadyRunning with undefined metadata (legacy worktree)
        return Promise.resolve(
          makeJsonResponse({
            success: true,
            workDir: "/tmp/wt",
            pid: 789,
            logFile: "/tmp/log",
            alreadyRunning: true,
            // baseBranch and parentTicketId intentionally omitted (undefined)
          })
        );
      }
      if (
        typeof url === "string" &&
        url.includes("/sessions") &&
        init?.method === "POST"
      ) {
        return Promise.resolve(makeJsonResponse({ success: true }));
      }
      return Promise.resolve(makeJsonResponse({ error: "not mocked" }, 500));
    });

    const { result } = renderHook(() => useSymphonyLaunch());

    // Wait for initial session load
    await waitFor(() => {
      expect(result.current.activeSessions.length).toBe(1);
    });

    let launchResult:
      | { launched: boolean; alreadyRunning: boolean }
      | undefined;
    await act(async () => {
      launchResult = await result.current.launch("AI-300", "/repo");
    });

    // Hook should report alreadyRunning: true
    expect(launchResult).toEqual({ launched: true, alreadyRunning: true });

    // Existing metadata should be preserved via prev.find() fallback
    const session = result.current.activeSessions.find(
      (s) => s.ticketId === "AI-300"
    );
    expect(session?.baseBranch).toBe("develop");
    expect(session?.parentTicketId).toBe("AI-250");
  });
});
