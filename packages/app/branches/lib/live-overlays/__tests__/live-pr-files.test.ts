import type { QueryFunctionContext } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type LivePrFilesResult, livePrFilesOptions } from "../live-pr-files";
import {
  LivePrOverlayError,
  OverlayUnavailableReason,
  resolveOverlayUnavailableReason,
} from "../live-pr-overlay-error";
import { branchesOverlayKeys } from "../overlay-keys";

const IDENTITY = { owner: "octo", repo: "repo", prNumber: 7 };

function runQueryFn(options: ReturnType<typeof livePrFilesOptions>) {
  const fn = options.queryFn as (
    ctx: QueryFunctionContext
  ) => Promise<LivePrFilesResult>;
  return fn({
    queryKey: options.queryKey,
    signal: new AbortController().signal,
    meta: undefined,
  } as unknown as QueryFunctionContext);
}

function mockFetchOnce(init: {
  ok: boolean;
  status: number;
  body: unknown;
}): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
    ok: init.ok,
    status: init.status,
    json: () => Promise.resolve(init.body),
  } as Response);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("livePrFilesOptions", () => {
  it("keys by the owner/repo slug + PR number, under the overlay namespace", () => {
    const options = livePrFilesOptions(IDENTITY);
    expect(options.queryKey).toEqual(
      branchesOverlayKeys.files("octo", "repo", 7)
    );
    expect(options.queryKey).toEqual([
      "branches",
      "overlay",
      "files",
      "octo",
      "repo",
      7,
    ]);
  });

  it("is disabled when there is no identity", () => {
    expect(livePrFilesOptions(null).enabled).toBe(false);
  });

  it("is enabled with a complete identity", () => {
    expect(livePrFilesOptions(IDENTITY).enabled).toBe(true);
  });

  it("fetches the slug route (owner/repo/number) and maps files → per-file + total LOC + github source", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          files: [
            { filename: "a.ts", additions: 7, deletions: 1 },
            { filename: "b.ts", additions: 0, deletions: 5 },
          ],
        }),
    } as Response);

    const result = await runQueryFn(
      livePrFilesOptions({ owner: "octo", repo: "repo", prNumber: 42 })
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain("/api/gateway/git/pr/files?");
    expect(url).toContain("owner=octo");
    expect(url).toContain("repo=repo");
    expect(url).toContain("number=42");
    // Slug mode — no local-path `pr=` param.
    expect(url).not.toContain("pr=");
    expect(result).toEqual({
      files: [
        { path: "a.ts", additions: 7, deletions: 1 },
        { path: "b.ts", additions: 0, deletions: 5 },
      ],
      filesChanged: 2,
      additions: 7,
      deletions: 6,
      source: "github",
    });
  });

  it("treats an empty changed-file set as count 0 with zero totals (distinct from unavailable)", async () => {
    mockFetchOnce({ ok: true, status: 200, body: { files: [] } });
    const result = await runQueryFn(livePrFilesOptions(IDENTITY));
    expect(result.filesChanged).toBe(0);
    expect(result.additions).toBe(0);
    expect(result.deletions).toBe(0);
    expect(result.source).toBe("github");
  });

  it("throws LivePrOverlayError carrying the sanitized body.error code on a 403 → not-connected", async () => {
    mockFetchOnce({
      ok: false,
      status: 403,
      body: { error: "directory not allowed" },
    });

    const error = await runQueryFn(livePrFilesOptions(IDENTITY)).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(LivePrOverlayError);
    const overlayError = error as LivePrOverlayError;
    expect(overlayError.status).toBe(403);
    expect(overlayError.code).toBe("directory not allowed");
    expect(resolveOverlayUnavailableReason(overlayError)).toBe(
      OverlayUnavailableReason.NotConnected
    );
  });

  it("maps a 500 failure to the generic error reason", async () => {
    mockFetchOnce({ ok: false, status: 500, body: { error: "gh boom" } });

    const error = await runQueryFn(livePrFilesOptions(IDENTITY)).catch(
      (e: unknown) => e
    );

    expect(resolveOverlayUnavailableReason(error)).toBe(
      OverlayUnavailableReason.Error
    );
  });
});

describe("resolveOverlayUnavailableReason", () => {
  it("maps a null identity sentinel to no-repo-identity", () => {
    expect(resolveOverlayUnavailableReason(null)).toBe(
      OverlayUnavailableReason.NoRepoIdentity
    );
  });

  it("maps an unknown (non-overlay) error to the generic error reason", () => {
    expect(resolveOverlayUnavailableReason(new Error("nope"))).toBe(
      OverlayUnavailableReason.Error
    );
  });
});
