import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createWrapper } from "@/hooks/queries/__tests__/test-utils";
import { fetchRepoPath, repoPathOptions, useRepoPath } from "../repo-path";

const originalFetch = globalThis.fetch;

const mockUseElectronDetection = vi.fn();
const mockUseEngineerRoutingSelection = vi.fn();

vi.mock("@/lib/engineer/electron-detection", () => ({
  useElectronDetection: (...args: unknown[]) =>
    mockUseElectronDetection(...args),
}));

vi.mock("@/lib/engineer/routing-store", () => ({
  useEngineerRoutingSelection: () => mockUseEngineerRoutingSelection(),
}));

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchRepoPath", () => {
  test("returns resolved path when endpoint responds with valid JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ path: "/Users/alice/src/acme/web" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const result = await fetchRepoPath("acme/web");
    expect(result).toEqual({ path: "/Users/alice/src/acme/web" });
  });

  test("returns { path: null } on 404 (endpoint missing on older Electron)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("Not Found", { status: 404 }));
    const result = await fetchRepoPath("acme/web");
    expect(result).toEqual({ path: null });
  });

  test("throws on non-404 errors (500, 502, etc.) so React Query can retry", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(fetchRepoPath("acme/web")).rejects.toThrow(
      "repo-path request failed: 500"
    );
  });

  test("throws when fetch itself throws (network error)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(fetchRepoPath("acme/web")).rejects.toThrow("Failed to fetch");
  });

  test("returns { path: null } when response body is not valid JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("<html>oops</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })
    );
    await expect(fetchRepoPath("acme/web")).rejects.toThrow();
  });

  test("returns { path: null } when response is JSON but path is not a string", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ path: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const result = await fetchRepoPath("acme/web");
    expect(result).toEqual({ path: null });
  });

  test("returns { path: null } when the response body is JSON null (not an object)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("null", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const result = await fetchRepoPath("acme/web");
    expect(result).toEqual({ path: null });
  });
});

describe("repoPathOptions", () => {
  test("disables the query when repoFullName is null", () => {
    const options = repoPathOptions(null, "cloud-relay:abc");
    expect(options.enabled).toBe(false);
  });

  test("disables the query when repoFullName is empty", () => {
    const options = repoPathOptions("", "cloud-relay:abc");
    expect(options.enabled).toBe(false);
  });

  test("enables the query when repoFullName is present", () => {
    const options = repoPathOptions("acme/web", "cloud-relay:abc");
    expect(options.enabled).toBe(true);
  });

  test("disables retries so a missing endpoint is not hammered", () => {
    const options = repoPathOptions("acme/web", "cloud-relay:abc");
    expect(options.retry).toBe(false);
  });
});

describe("useRepoPath", () => {
  beforeEach(() => {
    mockUseElectronDetection.mockReturnValue({ detected: false });
    mockUseEngineerRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.LocalElectron,
      computeTargetId: null,
      source: "manual",
      updatedAt: 0,
    });
  });

  test("does not fetch and reports no path when LocalElectron is not detected", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() => useRepoPath("acme/web"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.repoPath).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.showNotice).toBe(false);
  });

  test("fetches and returns the resolved path once LocalElectron is detected", async () => {
    mockUseElectronDetection.mockReturnValue({ detected: true });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ path: "/Users/alice/src/acme/web" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const { result } = renderHook(() => useRepoPath("acme/web"), {
      wrapper: createWrapper(),
    });

    await waitFor(() =>
      expect(result.current.repoPath).toBe("/Users/alice/src/acme/web")
    );
    expect(result.current.showNotice).toBe(false);
  });

  test("does not fetch when CloudRelay routing has no selected compute target", async () => {
    mockUseEngineerRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.CloudRelay,
      computeTargetId: null,
      source: "manual",
      updatedAt: 0,
    });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() => useRepoPath("acme/web"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.repoPath).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("shows the unresolved-repo notice when the routed CloudRelay target cannot resolve the repo", async () => {
    mockUseEngineerRoutingSelection.mockReturnValue({
      mode: EngineerRoutingMode.CloudRelay,
      computeTargetId: "target-1",
      source: "manual",
      updatedAt: 0,
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("Not Found", { status: 404 }));

    const { result } = renderHook(() => useRepoPath("acme/web"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.showNotice).toBe(true));
    expect(result.current.repoPath).toBeNull();
  });

  test("does not fetch when no target repo is given even though routing is routeable", async () => {
    mockUseElectronDetection.mockReturnValue({ detected: true });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() => useRepoPath(null), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.repoPath).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.showNotice).toBe(false);
  });
});
