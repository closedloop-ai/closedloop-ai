import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeBranchDetail } from "../../../__tests__/branch-fixtures";
import { usePreferredBranchLoc } from "../use-preferred-branch-loc";

/** Factory captures ONE client in a closure so the reference is stable across
 * re-renders (a wrapper that constructs a client in its body would discard the
 * cache each render and can re-fire against an exhausted mock). */
function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function mockFilesOnce(files: unknown): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ files }),
  } as Response);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("usePreferredBranchLoc", () => {
  it("prefers the connected PR's live totals over enrichment (source: github)", async () => {
    mockFilesOnce([
      { filename: "a.ts", additions: 7, deletions: 1 },
      { filename: "b.ts", additions: 3, deletions: 5 },
    ]);
    // Enrichment columns are deliberately DIFFERENT — the PR totals must win.
    const detail = makeBranchDetail({
      repoFullName: "octo/repo",
      prNumber: 42,
      additions: 999,
      deletions: 999,
    });

    const { result } = renderHook(() => usePreferredBranchLoc(detail), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.source).toBe("github"));
    expect(result.current.additions).toBe(10);
    expect(result.current.deletions).toBe(6);
    expect(result.current.netLoc).toBe(16);
  });

  it("uses the linked PR URL for live totals when repo identity is missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          files: [{ filename: "a.ts", additions: 2, deletions: 3 }],
        }),
    } as Response);
    const detail = makeBranchDetail({
      repoFullName: null,
      prUrl: "https://github.com/octo/repo/pull/42",
      prNumber: 42,
    });

    const { result } = renderHook(() => usePreferredBranchLoc(detail), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.source).toBe("github"));
    expect(result.current.netLoc).toBe(5);
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain("owner=octo");
    expect(url).toContain("repo=repo");
  });

  it("falls back to enrichment when there is no connected PR (source: local)", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const detail = makeBranchDetail({
      repoFullName: "octo/repo",
      prNumber: null,
      additions: 12,
      deletions: 4,
    });

    const { result } = renderHook(() => usePreferredBranchLoc(detail), {
      wrapper: createWrapper(),
    });

    expect(result.current.source).toBe("local");
    expect(result.current.netLoc).toBe(16);
    // No PR identity → the overlay query never fires.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is null when neither live PR nor enrichment LOC is available", () => {
    const detail = makeBranchDetail({
      repoFullName: "octo/repo",
      prNumber: null,
      additions: null,
      deletions: null,
    });

    const { result } = renderHook(() => usePreferredBranchLoc(detail), {
      wrapper: createWrapper(),
    });

    expect(result.current.source).toBeNull();
    expect(result.current.netLoc).toBeNull();
  });
});
