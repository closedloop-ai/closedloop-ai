/**
 * Direct coverage for the Branch View pure projection helpers.
 *
 * These were private to `../service.ts` — a ~2,800-line file on the shrink-only
 * grandfather list whose own `service.test.ts` is grandfathered too, so neither
 * could grow. Extracting them (ISS-5291 slice 3) both shrinks that file and
 * makes this behavior reachable without standing up the whole service.
 */

import {
  BranchViewFileCacheSyncErrorCode,
  BranchViewSyncErrorCode,
  ChecksStatus,
  FileChangeStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-view";
import { GitHubPRState } from "@repo/api/src/types/github";
import { describe, expect, it, vi } from "vitest";
import {
  compareNullableNumbersLast,
  compareNullableStringsLast,
  compareUnifiedThreadRows,
  getBranchViewSyncOutcomeHttpStatus,
  getBranchViewSyncOutcomeMessage,
  isoOrNull,
  mapChecksStatus,
  mapFileStatus,
  mapPrState,
  mapReviewDecision,
  parseBranchViewRepositoryFullName,
  type UnifiedThreadRow,
} from "./projection-helpers";

vi.mock("@repo/observability/log", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("mapFileStatus", () => {
  it("maps each known GitHub status", () => {
    expect(mapFileStatus("added")).toBe(FileChangeStatus.Added);
    expect(mapFileStatus("removed")).toBe(FileChangeStatus.Removed);
    expect(mapFileStatus("renamed")).toBe(FileChangeStatus.Renamed);
    expect(mapFileStatus("copied")).toBe(FileChangeStatus.Copied);
  });

  it("treats an unknown status as Modified rather than throwing", () => {
    // GitHub can add a status; a diff must still render.
    expect(mapFileStatus("changed")).toBe(FileChangeStatus.Modified);
    expect(mapFileStatus("")).toBe(FileChangeStatus.Modified);
  });
});

describe("mapChecksStatus", () => {
  it("maps each stored value", () => {
    expect(mapChecksStatus("UNKNOWN")).toBe(ChecksStatus.Unknown);
    expect(mapChecksStatus("PENDING")).toBe(ChecksStatus.Pending);
    expect(mapChecksStatus("PASSING")).toBe(ChecksStatus.Passing);
    expect(mapChecksStatus("FAILING")).toBe(ChecksStatus.Failing);
  });

  it("returns null for absent or unrecognized values", () => {
    // null means "no checks state to show" — distinct from Unknown, which is a
    // state GitHub actually reported.
    expect(mapChecksStatus(null)).toBeNull();
    expect(mapChecksStatus("")).toBeNull();
    expect(mapChecksStatus("SOMETHING_NEW")).toBeNull();
  });
});

describe("mapReviewDecision", () => {
  it("maps each stored value", () => {
    expect(mapReviewDecision("APPROVED")).toBe(ReviewDecision.Approved);
    expect(mapReviewDecision("CHANGES_REQUESTED")).toBe(
      ReviewDecision.ChangesRequested
    );
    expect(mapReviewDecision("COMMENTED")).toBe(ReviewDecision.Commented);
    expect(mapReviewDecision("DISMISSED")).toBe(ReviewDecision.Dismissed);
  });

  it("returns null for absent or unrecognized values", () => {
    expect(mapReviewDecision(null)).toBeNull();
    expect(mapReviewDecision(undefined)).toBeNull();
    expect(mapReviewDecision("PENDING_REVIEW")).toBeNull();
  });
});

describe("mapPrState", () => {
  it("passes through each valid state", () => {
    expect(mapPrState(GitHubPRState.Open)).toBe(GitHubPRState.Open);
    expect(mapPrState(GitHubPRState.Merged)).toBe(GitHubPRState.Merged);
    expect(mapPrState(GitHubPRState.Closed)).toBe(GitHubPRState.Closed);
  });

  it("defaults an invalid stored state to OPEN so the read still serves", () => {
    expect(mapPrState("BOGUS")).toBe(GitHubPRState.Open);
    expect(mapPrState(null)).toBe(GitHubPRState.Open);
    expect(mapPrState(undefined)).toBe(GitHubPRState.Open);
  });
});

describe("isoOrNull", () => {
  it("serializes a date and preserves null", () => {
    expect(isoOrNull(new Date(Date.UTC(2026, 7, 7, 12, 0, 0)))).toBe(
      "2026-08-07T12:00:00.000Z"
    );
    // null must survive — an epoch would claim a timestamp nobody recorded.
    expect(isoOrNull(null)).toBeNull();
  });
});

describe("parseBranchViewRepositoryFullName", () => {
  it("splits a well-formed owner/repo", () => {
    expect(parseBranchViewRepositoryFullName("acme/web")).toEqual({
      owner: "acme",
      repo: "web",
    });
  });

  it("rejects anything that is not exactly two non-empty segments", () => {
    expect(parseBranchViewRepositoryFullName("acme")).toBeNull();
    expect(parseBranchViewRepositoryFullName("acme/web/extra")).toBeNull();
    expect(parseBranchViewRepositoryFullName("/web")).toBeNull();
    expect(parseBranchViewRepositoryFullName("acme/")).toBeNull();
    expect(parseBranchViewRepositoryFullName("")).toBeNull();
  });
});

describe("compareNullableStringsLast", () => {
  it("sorts nulls last and equal values as ties", () => {
    expect(compareNullableStringsLast("a", "b")).toBeLessThan(0);
    expect(compareNullableStringsLast("b", "a")).toBeGreaterThan(0);
    expect(compareNullableStringsLast("a", "a")).toBe(0);
    expect(compareNullableStringsLast(null, null)).toBe(0);
    expect(compareNullableStringsLast(null, "a")).toBeGreaterThan(0);
    expect(compareNullableStringsLast("a", null)).toBeLessThan(0);
  });

  it("actually places nulls at the end of a sort", () => {
    expect(["b", null, "a", null].sort(compareNullableStringsLast)).toEqual([
      "a",
      "b",
      null,
      null,
    ]);
  });
});

describe("compareNullableNumbersLast", () => {
  it("sorts nulls last and orders numerically, not lexically", () => {
    expect(compareNullableNumbersLast(2, 10)).toBeLessThan(0);
    expect(compareNullableNumbersLast(10, 2)).toBeGreaterThan(0);
    expect(compareNullableNumbersLast(5, 5)).toBe(0);
    expect(compareNullableNumbersLast(null, null)).toBe(0);
    expect(compareNullableNumbersLast(null, 1)).toBeGreaterThan(0);
    expect(compareNullableNumbersLast(1, null)).toBeLessThan(0);
  });

  it("actually places nulls at the end of a sort", () => {
    expect([10, null, 2, null].sort(compareNullableNumbersLast)).toEqual([
      2,
      10,
      null,
      null,
    ]);
  });
});

describe("compareUnifiedThreadRows", () => {
  const row = (
    id: string,
    createdAt: string,
    path: string | null,
    line: number | null
  ): UnifiedThreadRow => ({
    id,
    createdAt: new Date(createdAt),
    githubProjection: path === null && line === null ? null : { path, line },
  });

  it("orders by path first", () => {
    const rows = [
      row("t2", "2026-01-01T00:00:00Z", "src/b.ts", 1),
      row("t1", "2026-01-01T00:00:00Z", "src/a.ts", 1),
    ].sort(compareUnifiedThreadRows);

    expect(rows.map((r) => r.id)).toEqual(["t1", "t2"]);
  });

  it("orders by line within a path, numerically", () => {
    const rows = [
      row("t2", "2026-01-01T00:00:00Z", "src/a.ts", 10),
      row("t1", "2026-01-01T00:00:00Z", "src/a.ts", 2),
    ].sort(compareUnifiedThreadRows);

    expect(rows.map((r) => r.id)).toEqual(["t1", "t2"]);
  });

  it("orders by createdAt when path and line tie", () => {
    const rows = [
      row("t2", "2026-01-02T00:00:00Z", "src/a.ts", 1),
      row("t1", "2026-01-01T00:00:00Z", "src/a.ts", 1),
    ].sort(compareUnifiedThreadRows);

    expect(rows.map((r) => r.id)).toEqual(["t1", "t2"]);
  });

  it("breaks a full tie on id so the ordering is TOTAL", () => {
    // Two threads on the same anchor in the same millisecond must not
    // reshuffle between reads.
    const a = row("aaa", "2026-01-01T00:00:00Z", "src/a.ts", 1);
    const b = row("bbb", "2026-01-01T00:00:00Z", "src/a.ts", 1);

    expect(compareUnifiedThreadRows(a, b)).toBeLessThan(0);
    expect(compareUnifiedThreadRows(b, a)).toBeGreaterThan(0);
    expect(compareUnifiedThreadRows(a, a)).toBe(0);
  });

  it("sorts unanchored threads after anchored ones", () => {
    const rows = [
      row("unanchored", "2026-01-01T00:00:00Z", null, null),
      row("anchored", "2026-01-02T00:00:00Z", "src/a.ts", 1),
    ].sort(compareUnifiedThreadRows);

    // Later createdAt does not promote it — the null anchor sorts last.
    expect(rows.map((r) => r.id)).toEqual(["anchored", "unanchored"]);
  });
});

describe("getBranchViewSyncOutcomeHttpStatus", () => {
  it("maps each code to its status", () => {
    expect(
      getBranchViewSyncOutcomeHttpStatus(BranchViewSyncErrorCode.SyncThrottled)
    ).toBe(429);
    expect(
      getBranchViewSyncOutcomeHttpStatus(
        BranchViewSyncErrorCode.CurrentPullRequestStale
      )
    ).toBe(409);
    expect(
      getBranchViewSyncOutcomeHttpStatus(
        BranchViewSyncErrorCode.PrLifecycleGuardFailed
      )
    ).toBe(409);
    expect(
      getBranchViewSyncOutcomeHttpStatus(
        BranchViewSyncErrorCode.PrLifecycleUnavailable
      )
    ).toBe(502);
    expect(
      getBranchViewSyncOutcomeHttpStatus(
        BranchViewSyncErrorCode.FileCacheRefreshFailed
      )
    ).toBe(500);
    expect(
      getBranchViewSyncOutcomeHttpStatus(
        BranchViewFileCacheSyncErrorCode.CompareFailed
      )
    ).toBe(500);
    expect(
      getBranchViewSyncOutcomeHttpStatus(
        BranchViewFileCacheSyncErrorCode.MissingCompareRefs
      )
    ).toBe(400);
  });

  it("returns null where the read keeps serving last-known data", () => {
    // PrSyncFailed is explicitly statusless: comments failed, the branch view
    // still renders, so it must not become an error response.
    expect(
      getBranchViewSyncOutcomeHttpStatus(BranchViewSyncErrorCode.PrSyncFailed)
    ).toBeNull();
    expect(getBranchViewSyncOutcomeHttpStatus(null)).toBeNull();
    expect(getBranchViewSyncOutcomeHttpStatus("some_unknown_code")).toBeNull();
  });
});

describe("getBranchViewSyncOutcomeMessage", () => {
  it("gives each known code a distinct user-facing message", () => {
    const codes = [
      BranchViewSyncErrorCode.SyncThrottled,
      BranchViewSyncErrorCode.CurrentPullRequestStale,
      BranchViewSyncErrorCode.PrLifecycleUnavailable,
      BranchViewSyncErrorCode.FileCacheRefreshFailed,
      BranchViewSyncErrorCode.PrSyncFailed,
      BranchViewFileCacheSyncErrorCode.MissingCompareRefs,
      BranchViewFileCacheSyncErrorCode.CompareFailed,
    ];
    const messages = codes.map((c) => getBranchViewSyncOutcomeMessage(c));

    expect(messages.every((m) => typeof m === "string" && m.length > 0)).toBe(
      true
    );
    expect(new Set(messages).size).toBe(messages.length);
  });

  it("shares one message between the two guard-failure codes", () => {
    expect(
      getBranchViewSyncOutcomeMessage(
        BranchViewSyncErrorCode.PrLifecycleGuardFailed
      )
    ).toBe(
      getBranchViewSyncOutcomeMessage(
        BranchViewSyncErrorCode.CurrentPullRequestStale
      )
    );
  });

  it("gives an unknown non-null code a generic message, and null nothing", () => {
    // A code from a newer build is version skew, not "nothing went wrong" —
    // it must still tell the user the sync was incomplete.
    expect(getBranchViewSyncOutcomeMessage("code_from_a_newer_build")).toBe(
      "Sync did not complete. Showing last-known data."
    );
    expect(getBranchViewSyncOutcomeMessage(null)).toBeNull();
  });
});
