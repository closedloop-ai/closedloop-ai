import { type BranchRow, BranchStatus } from "@repo/api/src/types/branch.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  filterBranchItemsByWindow,
  sortBranchItemsByLastActive,
} from "../src/main/branch/shared-branches-window.js";

/**
 * ISS-9585 — the desktop main-process half of the query-ordering ruling.
 *
 * This module windows and orders the SAME Branch corpus the cloud compiler
 * answers over, so a bound read against this machine's clock, or a tie-break
 * ranked by its locale, makes one saved query select or page differently here
 * than it does there. Driven through the real exported entry points.
 */
const NOW = new Date("2026-09-26T00:00:00.000Z");

/** 00:00Z anchored absolutely, 05:00Z anchored to Chicago. */
const ZONELESS_START = "2026-09-25T00:00:00";
const BETWEEN_THE_TWO_READINGS = "2026-09-25T02:00:00.000Z";

describe("Desktop shared-branches window anchoring (ISS-9585)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("selects the same population for a zone-less bound on every host", () => {
    const rows = [
      row({ id: "between", lastActivityAt: BETWEEN_THE_TWO_READINGS }),
    ];
    const unanchored: number[] = [];

    const kept = ["UTC", "America/Chicago", "Asia/Tokyo"].map((zone) => {
      vi.stubEnv("TZ", zone);
      unanchored.push(Date.parse(ZONELESS_START));
      return filterBranchItemsByWindow(rows, { startDate: ZONELESS_START }, NOW)
        .length;
    });

    // The premise, asserted rather than assumed: the stub really moves the
    // clock, so an unanchored bound WOULD name three instants and Chicago
    // would drop this row. Without it the agreement below passes vacuously.
    expect(new Set(unanchored).size).toBe(3);
    expect(kept).toEqual([1, 1, 1]);
  });

  it("still drops a row that falls before the anchored bound", () => {
    vi.stubEnv("TZ", "Asia/Tokyo");

    expect(
      filterBranchItemsByWindow(
        [row({ id: "before", lastActivityAt: "2026-09-24T23:00:00.000Z" })],
        { startDate: ZONELESS_START },
        NOW
      )
    ).toEqual([]);
  });
});

/**
 * Rows sharing one Last-active instant, so the repo/branch/id tie-break is the
 * only thing that orders them. Their collated order is the reverse of their
 * UTF-16 order, because every uppercase letter precedes every lowercase one by
 * code unit — a same-case ASCII fixture agrees under both and could not fail.
 */
const TIED_AT = "2026-09-25T12:00:00.000Z";

describe("Desktop shared-branches identity ordering (ISS-9585)", () => {
  it("collates the branch-name tie-break rather than ranking code units", () => {
    const rows = [
      row({ id: "z", branchName: "Zeta", lastActivityAt: TIED_AT }),
      row({ id: "a", branchName: "alpha", lastActivityAt: TIED_AT }),
      row({ id: "b", branchName: "Beta", lastActivityAt: TIED_AT }),
    ];

    // Written out, not derived: by code unit this is Beta, Zeta, alpha.
    expect(
      sortBranchItemsByLastActive(rows, {}, NOW).map((item) => item.id)
    ).toEqual(["a", "b", "z"]);
  });
});

function row(over: Partial<BranchRow>): BranchRow {
  return {
    id: "branch-1",
    branchName: "feature/cohort",
    baseBranch: "main",
    repoFullName: "acme/web",
    owner: null,
    status: BranchStatus.Open,
    prNumber: null,
    prTitle: null,
    prState: null,
    prUrl: null,
    multiPrWarning: false,
    checksStatus: null,
    checksPassed: null,
    checksTotal: null,
    reviewDecision: null,
    ahead: null,
    behind: null,
    additions: null,
    deletions: null,
    filesChanged: null,
    estimatedCostUsd: null,
    lastActivityAt: "",
    sessionIds: [],
    ...over,
  };
}
