import { ReviewDecision } from "@repo/api/src/types/branch-checks";
import type { QueryFunctionContext } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LivePrOverlayError,
  OverlayUnavailableReason,
  resolveOverlayUnavailableReason,
} from "../live-pr-overlay-error";
import {
  type LivePrStatusResult,
  livePrStatusOptions,
} from "../live-pr-status";
import { branchesOverlayKeys } from "../overlay-keys";

function runQueryFn(options: ReturnType<typeof livePrStatusOptions>) {
  const fn = options.queryFn as (
    ctx: QueryFunctionContext
  ) => Promise<LivePrStatusResult>;
  return fn({
    queryKey: options.queryKey,
    signal: new AbortController().signal,
    meta: undefined,
  } as unknown as QueryFunctionContext);
}

function mockReviews(init: { ok: boolean; status: number; body: unknown }) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
    ok: init.ok,
    status: init.status,
    json: () => Promise.resolve(init.body),
  } as Response);
}

const IDENTITY = { owner: "octo", repo: "repo", prNumber: 42 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("livePrStatusOptions", () => {
  it("keys by owner/repo/pr under the overlay namespace and is disabled without identity", () => {
    expect(livePrStatusOptions(null).enabled).toBe(false);
    const options = livePrStatusOptions(IDENTITY);
    expect(options.enabled).toBe(true);
    expect(options.queryKey).toEqual(
      branchesOverlayKeys.status("octo", "repo", 42)
    );
  });

  it("fetches /pr/reviews with owner/repo/number and passes through approval counts", async () => {
    const fetchSpy = mockReviews({
      ok: true,
      status: 200,
      body: {
        reviewDecision: "APPROVED",
        approvalCount: 2,
        changesRequestedCount: 0,
      },
    });

    const result = await runQueryFn(livePrStatusOptions(IDENTITY));

    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain("/api/gateway/git/pr/reviews?");
    expect(url).toContain("owner=octo");
    expect(url).toContain("repo=repo");
    expect(url).toContain("number=42");
    expect(result.reviewDecision).toBe(ReviewDecision.Approved);
    expect(result.approvalCount).toBe(2);
    expect(result.changesRequestedCount).toBe(0);
    expect(result.connected).toBe(true);
  });

  it("maps REVIEW_REQUIRED (not a ReviewDecision member) to null, never casting it", async () => {
    mockReviews({
      ok: true,
      status: 200,
      body: { reviewDecision: "REVIEW_REQUIRED", approvalCount: 0 },
    });
    const result = await runQueryFn(livePrStatusOptions(IDENTITY));
    expect(result.reviewDecision).toBeNull();
  });

  it("maps CHANGES_REQUESTED onto the enum", async () => {
    mockReviews({
      ok: true,
      status: 200,
      body: { reviewDecision: "CHANGES_REQUESTED", changesRequestedCount: 1 },
    });
    const result = await runQueryFn(livePrStatusOptions(IDENTITY));
    expect(result.reviewDecision).toBe(ReviewDecision.ChangesRequested);
    expect(result.changesRequestedCount).toBe(1);
  });

  it("carries checks/rollup/mergeStateStatus as null today (no gateway producer)", async () => {
    mockReviews({
      ok: true,
      status: 200,
      body: { reviewDecision: null, approvalCount: 0 },
    });
    const result = await runQueryFn(livePrStatusOptions(IDENTITY));
    expect(result.checksStatus).toBeNull();
    expect(result.checksPassed).toBeNull();
    expect(result.checksTotal).toBeNull();
    expect(result.mergeStateStatus).toBeNull();
    expect(result.statusCheckRollup).toBeNull();
  });

  it("throws LivePrOverlayError on a 403 → not-connected", async () => {
    mockReviews({ ok: false, status: 403, body: { error: "nope" } });
    const error = await runQueryFn(livePrStatusOptions(IDENTITY)).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(LivePrOverlayError);
    expect(resolveOverlayUnavailableReason(error)).toBe(
      OverlayUnavailableReason.NotConnected
    );
  });
});
