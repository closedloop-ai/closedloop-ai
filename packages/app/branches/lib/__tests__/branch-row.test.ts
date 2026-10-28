import { BranchSessionPresence } from "@repo/api/src/types/branch";
import {
  BranchListFilterFacet,
  BranchListLastActiveRange,
  BranchListPullRequestPresence,
} from "@repo/api/src/types/branch-list-contract";
import { TagColor } from "@repo/api/src/types/tag";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRANCH_STATUS_CONFIG,
  BranchFilterFacet,
  type BranchFilters,
  BranchLastActiveRange,
  BranchPullRequestPresence,
  type BranchRow,
  BranchRowStatus,
  branchOwnerFilterOptions,
  branchRepoFilterOptions,
  branchSessionPresenceFilterOptions,
  branchStatusFilterOptions,
  clampBranchLocRange,
  DEFAULT_BRANCH_FILTERS,
  filterBranchRows,
  lastActiveRange,
  RENDER_MISSING,
  RENDER_UNATTRIBUTED,
  rowHasLinkedSession,
  rowLocChange,
  shortRepoName,
} from "../branch-row";

function makeRow(overrides: Partial<BranchRow> = {}): BranchRow {
  return {
    id: "br_1",
    branchName: "agent/work",
    baseBranch: "main",
    repo: "acme/web",
    owner: "Avery",
    status: BranchRowStatus.Open,
    prNumber: null,
    prTitle: null,
    prUrl: null,
    prState: null,
    checksPassed: null,
    checksTotal: null,
    checksStatus: null,
    behind: 0,
    ahead: 1,
    additions: 1,
    deletions: 0,
    sessionCount: 0,
    commentCount: null,
    lastActivityLabel: "1h ago",
    ...overrides,
  };
}

const NONE: BranchFilters = { ...DEFAULT_BRANCH_FILTERS };

describe("shortRepoName", () => {
  it("returns the final path segment", () => {
    expect(shortRepoName("acme/web")).toBe("web");
  });

  it("returns the whole value when there is no slash", () => {
    expect(shortRepoName("web")).toBe("web");
  });

  it("ignores a trailing slash", () => {
    expect(shortRepoName("acme/web/")).toBe("web");
  });

  it("falls back to the raw repo when every segment is empty", () => {
    expect(shortRepoName("")).toBe("");
  });
});

describe("branchStatusFilterOptions", () => {
  it("lists canonical statuses, including zero-count statuses", () => {
    const options = branchStatusFilterOptions([
      makeRow({ status: BranchRowStatus.Open }),
      makeRow({ status: BranchRowStatus.Open }),
      makeRow({ status: BranchRowStatus.Merged }),
    ]);
    expect(options.map((option) => option.id)).toEqual([
      BranchRowStatus.Open,
      BranchRowStatus.Review,
      BranchRowStatus.Merged,
      BranchRowStatus.Draft,
      BranchRowStatus.Blocked,
      BranchRowStatus.Closed,
    ]);
    expect(options.find((o) => o.id === BranchRowStatus.Open)?.count).toBe(2);
    expect(options.find((o) => o.id === BranchRowStatus.Merged)?.count).toBe(1);
    expect(options.find((o) => o.id === BranchRowStatus.Blocked)?.count).toBe(
      0
    );
  });
});

describe("branchRepoFilterOptions", () => {
  it("dedupes by short repo name, sorted, with counts", () => {
    const options = branchRepoFilterOptions([
      makeRow({ repo: "acme/web" }),
      makeRow({ repo: "other/web" }),
      makeRow({ repo: "acme/api" }),
    ]);
    expect(options.map((o) => o.id)).toEqual(["api", "web"]);
    expect(options.find((o) => o.id === "web")?.count).toBe(2);
    expect(options.find((o) => o.id === "api")?.count).toBe(1);
  });
});

describe("branchSessionPresenceFilterOptions", () => {
  it("buckets rows by whether they have a linked session", () => {
    const options = branchSessionPresenceFilterOptions([
      makeRow({ sessionCount: 2 }),
      makeRow({ sessionCount: 0 }),
      makeRow({ sessionCount: 0 }),
    ]);
    expect(options.find((o) => o.id === BranchSessionPresence.Has)?.count).toBe(
      1
    );
    expect(
      options.find((o) => o.id === BranchSessionPresence.None)?.count
    ).toBe(2);
  });
});

describe("rowHasLinkedSession", () => {
  it("is false for zero sessions", () => {
    expect(rowHasLinkedSession(makeRow({ sessionCount: 0 }))).toBe(false);
  });

  it("is true for one or more sessions", () => {
    expect(rowHasLinkedSession(makeRow({ sessionCount: 1 }))).toBe(true);
  });
});

describe("branchOwnerFilterOptions", () => {
  it("derives sorted owner options with counts", () => {
    const options = branchOwnerFilterOptions([
      makeRow({ owner: "Sam" }),
      makeRow({ owner: "Avery" }),
      makeRow({ owner: "Sam" }),
    ]);
    expect(options.map((o) => o.id)).toEqual(["Avery", "Sam"]);
    expect(options.find((o) => o.id === "Sam")?.count).toBe(2);
  });
});

describe("rowLocChange", () => {
  it("is null when both additions and deletions are unavailable", () => {
    expect(rowLocChange(makeRow({ additions: null, deletions: null }))).toBe(
      null
    );
  });

  it("treats a single available count as present (the other contributes 0)", () => {
    expect(rowLocChange(makeRow({ additions: 5, deletions: null }))).toBe(5);
    expect(rowLocChange(makeRow({ additions: null, deletions: 7 }))).toBe(7);
  });

  it("sums both counts when both are available", () => {
    expect(rowLocChange(makeRow({ additions: 3, deletions: 2 }))).toBe(5);
  });
});

describe("clampBranchLocRange", () => {
  it("passes through undefined bounds untouched", () => {
    expect(clampBranchLocRange({})).toEqual({
      min: undefined,
      max: undefined,
    });
  });

  it("floors a negative min at 0", () => {
    expect(clampBranchLocRange({ min: -5 })).toEqual({
      min: 0,
      max: undefined,
    });
  });

  it("drops a non-finite bound to undefined", () => {
    expect(clampBranchLocRange({ min: Number.POSITIVE_INFINITY })).toEqual({
      min: undefined,
      max: undefined,
    });
  });

  it("clamps an inverted range so min never exceeds max", () => {
    expect(clampBranchLocRange({ min: 100, max: 10 })).toEqual({
      min: 10,
      max: 10,
    });
  });
});

describe("lastActiveRange", () => {
  const NOW = Date.parse("2026-06-10T12:00:00.000Z");

  it("is null when the value is missing", () => {
    expect(lastActiveRange(undefined, NOW)).toBeNull();
  });

  it("is null for an unparsable timestamp", () => {
    expect(lastActiveRange("not-a-date", NOW)).toBeNull();
  });

  it("is null for a timestamp in the future", () => {
    expect(lastActiveRange("2026-06-10T12:00:01.000Z", NOW)).toBeNull();
  });

  it("buckets under an hour as WithinLastHour", () => {
    expect(
      lastActiveRange(new Date(NOW - 30 * 60 * 1000).toISOString(), NOW)
    ).toBe(BranchLastActiveRange.WithinLastHour);
  });

  it("treats exactly one hour old as no longer WithinLastHour", () => {
    expect(
      lastActiveRange(new Date(NOW - 60 * 60 * 1000).toISOString(), NOW)
    ).toBe(BranchLastActiveRange.OneToSixHours);
  });

  it("buckets under seven hours as OneToSixHours", () => {
    expect(
      lastActiveRange(new Date(NOW - 6 * 60 * 60 * 1000).toISOString(), NOW)
    ).toBe(BranchLastActiveRange.OneToSixHours);
  });

  it("treats exactly seven hours old as SevenToTwentyFourHours", () => {
    expect(
      lastActiveRange(new Date(NOW - 7 * 60 * 60 * 1000).toISOString(), NOW)
    ).toBe(BranchLastActiveRange.SevenToTwentyFourHours);
  });

  it("buckets under twenty-four hours as SevenToTwentyFourHours", () => {
    expect(
      lastActiveRange(new Date(NOW - 23 * 60 * 60 * 1000).toISOString(), NOW)
    ).toBe(BranchLastActiveRange.SevenToTwentyFourHours);
  });

  it("treats exactly twenty-four hours old as OneDayOrMore", () => {
    expect(
      lastActiveRange(new Date(NOW - 24 * 60 * 60 * 1000).toISOString(), NOW)
    ).toBe(BranchLastActiveRange.OneDayOrMore);
  });
});

describe("BRANCH_STATUS_CONFIG", () => {
  it("covers every defined status", () => {
    for (const status of Object.values(BranchRowStatus)) {
      expect(BRANCH_STATUS_CONFIG[status]).toBeDefined();
    }
  });

  it("marks Blocked destructive with the Changes requested label", () => {
    expect(BRANCH_STATUS_CONFIG[BranchRowStatus.Blocked]).toEqual({
      label: "Changes requested",
      variant: "destructive",
    });
  });
});

describe("DEFAULT_BRANCH_FILTERS", () => {
  it("starts every facet empty and leaves the LOC bounds open", () => {
    expect(DEFAULT_BRANCH_FILTERS).toEqual({
      names: [],
      statuses: [],
      owners: [],
      collaborators: [],
      repos: [],
      pullRequests: [],
      lastActiveRanges: [],
      tags: [],
      priorities: [],
      sessionPresence: [],
    });
    expect(DEFAULT_BRANCH_FILTERS.locMin).toBeUndefined();
    expect(DEFAULT_BRANCH_FILTERS.locMax).toBeUndefined();
  });
});

describe("re-exported list-contract enums", () => {
  it("BranchFilterFacet is the canonical BranchListFilterFacet", () => {
    expect(BranchFilterFacet).toBe(BranchListFilterFacet);
  });

  it("BranchPullRequestPresence is the canonical BranchListPullRequestPresence", () => {
    expect(BranchPullRequestPresence).toBe(BranchListPullRequestPresence);
  });

  it("BranchLastActiveRange is the canonical BranchListLastActiveRange", () => {
    expect(BranchLastActiveRange).toBe(BranchListLastActiveRange);
  });
});

describe("render placeholders", () => {
  it("RENDER_MISSING is an em dash", () => {
    expect(RENDER_MISSING).toBe("—");
  });

  it("RENDER_UNATTRIBUTED labels an unattributed owner", () => {
    expect(RENDER_UNATTRIBUTED).toBe("unattributed");
  });
});

describe("filterBranchRows — name facet", () => {
  it("keeps only rows whose branchName is selected", () => {
    const rows = [
      makeRow({ id: "a", branchName: "agent/work" }),
      makeRow({ id: "b", branchName: "human/fix" }),
    ];
    const result = filterBranchRows(rows, {
      ...NONE,
      names: ["agent/work"],
    });
    expect(result.map((r) => r.id)).toEqual(["a"]);
  });
});

describe("filterBranchRows — owner facet and approved mode", () => {
  it("non-approved mode matches by display name, ignoring ownerKey", () => {
    const row = makeRow({ owner: "Avery Human", ownerKey: "user_123" });
    const byName = filterBranchRows([row], {
      ...NONE,
      owners: ["Avery Human"],
    });
    const byKey = filterBranchRows([row], {
      ...NONE,
      owners: ["user_123"],
    });
    expect(byName).toHaveLength(1);
    expect(byKey).toHaveLength(0);
  });

  it("approved mode matches by ownerKey when present, ignoring the display name", () => {
    const row = makeRow({ owner: "Avery Human", ownerKey: "user_123" });
    const byKey = filterBranchRows(
      [row],
      { ...NONE, owners: ["user_123"] },
      { approved: true }
    );
    const byName = filterBranchRows(
      [row],
      { ...NONE, owners: ["Avery Human"] },
      { approved: true }
    );
    expect(byKey).toHaveLength(1);
    expect(byName).toHaveLength(0);
  });

  it("approved mode falls back to the display name when ownerKey is absent", () => {
    const row = makeRow({ owner: "Avery Human", ownerKey: undefined });
    const result = filterBranchRows(
      [row],
      { ...NONE, owners: ["Avery Human"] },
      { approved: true }
    );
    expect(result).toHaveLength(1);
  });
});

describe("filterBranchRows — collaborators facet", () => {
  it("matches a row with any selected collaborator key", () => {
    const rows = [
      makeRow({
        id: "a",
        collaborators: [{ key: "c1", name: "Cara" }],
      }),
      makeRow({ id: "b", collaborators: [{ key: "c2", name: "Cosimo" }] }),
      makeRow({ id: "c" }),
    ];
    const result = filterBranchRows(rows, {
      ...NONE,
      collaborators: ["c1"],
    });
    expect(result.map((r) => r.id)).toEqual(["a"]);
  });
});

describe("filterBranchRows — repository facet and approved mode", () => {
  it("non-approved mode matches the short repo name only", () => {
    const row = makeRow({ repo: "acme/web" });
    expect(filterBranchRows([row], { ...NONE, repos: ["web"] })).toHaveLength(
      1
    );
    expect(
      filterBranchRows([row], { ...NONE, repos: ["acme/web"] })
    ).toHaveLength(0);
  });

  it("approved mode matches the full repo identity only", () => {
    const row = makeRow({ repo: "acme/web" });
    expect(
      filterBranchRows(
        [row],
        { ...NONE, repos: ["acme/web"] },
        { approved: true }
      )
    ).toHaveLength(1);
    expect(
      filterBranchRows([row], { ...NONE, repos: ["web"] }, { approved: true })
    ).toHaveLength(0);
  });
});

describe("filterBranchRows — pull request facet", () => {
  const linkedByFlag = makeRow({
    id: "flagged",
    hasPullRequest: true,
    prNumber: null,
  });
  const linkedByNumber = makeRow({
    id: "numbered",
    hasPullRequest: undefined,
    prNumber: 5,
  });
  const noneRow = makeRow({
    id: "none",
    hasPullRequest: false,
    prNumber: null,
  });
  const rows = [linkedByFlag, linkedByNumber, noneRow];

  it("Linked matches rows via hasPullRequest OR a non-null prNumber", () => {
    const result = filterBranchRows(rows, {
      ...NONE,
      pullRequests: [BranchListPullRequestPresence.Linked],
    });
    expect(result.map((r) => r.id)).toEqual(["flagged", "numbered"]);
  });

  it("None matches only rows with neither signal", () => {
    const result = filterBranchRows(rows, {
      ...NONE,
      pullRequests: [BranchListPullRequestPresence.None],
    });
    expect(result.map((r) => r.id)).toEqual(["none"]);
  });
});

describe("filterBranchRows — last-active facet", () => {
  const now = Date.parse("2026-06-10T12:00:00.000Z");

  it("excludes a row with no lastActivityAt once a range is selected", () => {
    const row = makeRow({ lastActivityAt: undefined });
    const result = filterBranchRows(
      [row],
      { ...NONE, lastActiveRanges: [BranchLastActiveRange.OneDayOrMore] },
      { now }
    );
    expect(result).toHaveLength(0);
  });

  it("keeps a row matching the selected bucket", () => {
    const row = makeRow({
      lastActivityAt: new Date(now - 30 * 60 * 1000).toISOString(),
    });
    const result = filterBranchRows(
      [row],
      { ...NONE, lastActiveRanges: [BranchLastActiveRange.WithinLastHour] },
      { now }
    );
    expect(result).toHaveLength(1);
  });
});

describe("filterBranchRows — tags facet", () => {
  it("matches a row carrying any selected tag id", () => {
    const rows = [
      makeRow({
        id: "a",
        tags: [{ id: "t1", name: "Bug", color: TagColor.Red }],
      }),
      makeRow({
        id: "b",
        tags: [{ id: "t2", name: "Chore", color: TagColor.Blue }],
      }),
      makeRow({ id: "c" }),
    ];
    const result = filterBranchRows(rows, { ...NONE, tags: ["t1"] });
    expect(result.map((r) => r.id)).toEqual(["a"]);
  });
});

describe("filterBranchRows — session presence bypass in approved mode", () => {
  it("non-approved mode still filters by session presence", () => {
    const row = makeRow({ sessionCount: 0 });
    const result = filterBranchRows([row], {
      ...NONE,
      sessionPresence: [BranchSessionPresence.Has],
    });
    expect(result).toHaveLength(0);
  });

  it("approved mode ignores sessionPresence entirely", () => {
    const row = makeRow({ sessionCount: 0 });
    const result = filterBranchRows(
      [row],
      { ...NONE, sessionPresence: [BranchSessionPresence.Has] },
      { approved: true }
    );
    expect(result).toHaveLength(1);
  });
});

describe("filterBranchRows — omitFacet bypasses one facet at a time", () => {
  it("Name", () => {
    const row = makeRow({ branchName: "agent/work" });
    const filters: BranchFilters = { ...NONE, names: ["nothing-matches"] };
    expect(filterBranchRows([row], filters)).toHaveLength(0);
    expect(
      filterBranchRows([row], filters, { omitFacet: BranchFilterFacet.Name })
    ).toHaveLength(1);
  });

  it("Owner", () => {
    const row = makeRow({ owner: "Avery" });
    const filters: BranchFilters = { ...NONE, owners: ["nobody"] };
    expect(filterBranchRows([row], filters)).toHaveLength(0);
    expect(
      filterBranchRows([row], filters, { omitFacet: BranchFilterFacet.Owner })
    ).toHaveLength(1);
  });

  it("Collaborators", () => {
    const row = makeRow({ collaborators: [{ key: "c1", name: "Cara" }] });
    const filters: BranchFilters = { ...NONE, collaborators: ["nobody"] };
    expect(filterBranchRows([row], filters)).toHaveLength(0);
    expect(
      filterBranchRows([row], filters, {
        omitFacet: BranchFilterFacet.Collaborators,
      })
    ).toHaveLength(1);
  });

  it("Status", () => {
    const row = makeRow({ status: BranchRowStatus.Open });
    const filters: BranchFilters = {
      ...NONE,
      statuses: [BranchRowStatus.Merged],
    };
    expect(filterBranchRows([row], filters)).toHaveLength(0);
    expect(
      filterBranchRows([row], filters, { omitFacet: BranchFilterFacet.Status })
    ).toHaveLength(1);
  });

  it("Repository", () => {
    const row = makeRow({ repo: "acme/web" });
    const filters: BranchFilters = { ...NONE, repos: ["other-repo"] };
    expect(filterBranchRows([row], filters)).toHaveLength(0);
    expect(
      filterBranchRows([row], filters, {
        omitFacet: BranchFilterFacet.Repository,
      })
    ).toHaveLength(1);
  });

  it("PullRequest", () => {
    const row = makeRow({ hasPullRequest: true, prNumber: null });
    const filters: BranchFilters = {
      ...NONE,
      pullRequests: [BranchListPullRequestPresence.None],
    };
    expect(filterBranchRows([row], filters)).toHaveLength(0);
    expect(
      filterBranchRows([row], filters, {
        omitFacet: BranchFilterFacet.PullRequest,
      })
    ).toHaveLength(1);
  });

  it("LastActive", () => {
    const now = Date.parse("2026-06-10T12:00:00.000Z");
    const row = makeRow({
      lastActivityAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
    });
    const filters: BranchFilters = {
      ...NONE,
      lastActiveRanges: [BranchLastActiveRange.WithinLastHour],
    };
    expect(filterBranchRows([row], filters, { now })).toHaveLength(0);
    expect(
      filterBranchRows([row], filters, {
        now,
        omitFacet: BranchFilterFacet.LastActive,
      })
    ).toHaveLength(1);
  });

  it("Tags", () => {
    const row = makeRow({
      tags: [{ id: "t1", name: "Bug", color: TagColor.Red }],
    });
    const filters: BranchFilters = { ...NONE, tags: ["nope"] };
    expect(filterBranchRows([row], filters)).toHaveLength(0);
    expect(
      filterBranchRows([row], filters, { omitFacet: BranchFilterFacet.Tags })
    ).toHaveLength(1);
  });

  it("Changes (LOC)", () => {
    const row = makeRow({ additions: 1, deletions: 0 });
    const filters: BranchFilters = { ...NONE, locMin: 1000 };
    expect(filterBranchRows([row], filters)).toHaveLength(0);
    expect(
      filterBranchRows([row], filters, {
        omitFacet: BranchFilterFacet.Changes,
      })
    ).toHaveLength(1);
  });
});

describe("filterBranchRows — AND across facets", () => {
  it("requires every active facet to match", () => {
    const rows = [
      makeRow({ id: "a", owner: "Sam", repo: "acme/web" }),
      makeRow({ id: "b", owner: "Sam", repo: "acme/api" }),
      makeRow({ id: "c", owner: "Avery", repo: "acme/web" }),
    ];
    const result = filterBranchRows(rows, {
      ...NONE,
      owners: ["Sam"],
      repos: ["web"],
    });
    expect(result.map((r) => r.id)).toEqual(["a"]);
  });
});

describe("filterBranchRows — default clock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the real clock when `now` is not provided", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:30:00.000Z"));
    const row = makeRow({
      lastActivityAt: "2026-06-10T12:00:00.000Z",
    });
    const result = filterBranchRows([row], {
      ...NONE,
      lastActiveRanges: [BranchLastActiveRange.WithinLastHour],
    });
    expect(result).toHaveLength(1);
  });
});
