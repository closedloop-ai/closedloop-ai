import type { BranchViewFileDiff } from "@repo/api/src/types/branch-view";
import type { QueryFunctionContext } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { livePrFileDiffOptions } from "../live-pr-file-diff";
import { LivePrOverlayError } from "../live-pr-overlay-error";
import { branchesOverlayKeys } from "../overlay-keys";

const IDENTITY = {
  owner: "octo",
  repo: "repo",
  prNumber: 7,
  branchId: "octo%2Frepo::feature%2Fx",
  path: "src/new.ts",
  previousPath: "src/old.ts",
};

function runQueryFn(options: ReturnType<typeof livePrFileDiffOptions>) {
  const fn = options.queryFn as (
    ctx: QueryFunctionContext
  ) => Promise<BranchViewFileDiff>;
  return fn({
    queryKey: options.queryKey,
    signal: new AbortController().signal,
    meta: undefined,
  } as unknown as QueryFunctionContext);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("livePrFileDiffOptions", () => {
  it("keys by owner/repo/PR/current path/previous path under the overlay namespace", () => {
    const options = livePrFileDiffOptions(IDENTITY);
    expect(options.queryKey).toEqual(
      branchesOverlayKeys.fileDiff(
        "octo",
        "repo",
        7,
        "octo%2Frepo::feature%2Fx",
        "src/new.ts",
        "src/old.ts"
      )
    );
    expect(options.queryKey).toEqual([
      "branches",
      "overlay",
      "fileDiff",
      "octo",
      "repo",
      7,
      "octo%2Frepo::feature%2Fx",
      "src/new.ts",
      "src/old.ts",
    ]);
  });

  it("omits previousPath from the request when absent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          path: "src/a.ts",
          oldContent: "old",
          newContent: "new",
          isNew: false,
          isDeleted: false,
          isBinary: false,
        }),
    } as Response);

    await runQueryFn(
      livePrFileDiffOptions({
        owner: "octo",
        repo: "repo",
        prNumber: 42,
        branchId: "octo%2Frepo::main",
        path: "src/a.ts",
      })
    );

    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain("/api/gateway/git/pr/file-diff?");
    expect(url).toContain("owner=octo");
    expect(url).toContain("repo=repo");
    expect(url).toContain("number=42");
    expect(url).toContain("branchId=octo%252Frepo%3A%3Amain");
    expect(url).toContain("path=src%2Fa.ts");
    expect(url).not.toContain("previousPath=");
  });

  it("passes previousPath for renamed files", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          path: "src/new.ts",
          oldContent: "old",
          newContent: "new",
          isNew: false,
          isDeleted: false,
          isBinary: false,
        }),
    } as Response);

    await runQueryFn(livePrFileDiffOptions(IDENTITY));

    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain("path=src%2Fnew.ts");
    expect(url).toContain("previousPath=src%2Fold.ts");
  });

  it("throws LivePrOverlayError with the response error code on failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () =>
        Promise.resolve({ error: "File is not part of this pull request" }),
    } as Response);

    const error = await runQueryFn(livePrFileDiffOptions(IDENTITY)).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(LivePrOverlayError);
    expect((error as LivePrOverlayError).status).toBe(404);
    expect((error as LivePrOverlayError).code).toBe(
      "File is not part of this pull request"
    );
  });
});
