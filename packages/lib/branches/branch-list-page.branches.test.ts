import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchCollaboratorSource,
  BranchIdentityAvailability,
  type BranchPerson,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity";
import {
  BranchListFacetAvailability,
  BranchListPullRequestPresence,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { Priority } from "@repo/api/src/types/common";
import { describe, expect, it } from "vitest";
import {
  BRANCH_OWNER_UNATTRIBUTED_LABEL,
  BRANCH_REPOSITORY_UNKNOWN_LABEL,
  branchListFacetAvailabilityFromCounts,
  branchListRepositoryDisplayLabels,
  branchListStatusLabel,
  buildBranchServerPage,
  buildBranchServerPageSnapshot,
  countImpossibleBranchLastActiveInstants,
  countRetainedUnavailableBranchRows,
  selectBranchServerRows,
} from "./branch-list-page";
import {
  branchServerPageQuery as query,
  branchRow as row,
} from "./branch-list-page.test-fixtures";

const NOW = "2026-08-18T18:00:00.000Z";
const INVALID_NOW = "not-a-timestamp";
const INVALID_NOW_MESSAGE = /ISO timestamp/;
const FUTURE_PEER_PRIORITY = "future-peer-priority" as Priority;

const NO_COLLABORATOR_SOURCES = {
  [BranchCollaboratorSource.PullRequestAuthors]:
    BranchIdentityAvailability.Complete,
  [BranchCollaboratorSource.Pushes]: BranchIdentityAvailability.Complete,
  [BranchCollaboratorSource.PullRequestComments]:
    BranchIdentityAvailability.Complete,
  [BranchCollaboratorSource.BranchComments]:
    BranchIdentityAvailability.Complete,
  [BranchCollaboratorSource.SessionComments]:
    BranchIdentityAvailability.Complete,
} as const;

function ids(rows: readonly { id: string }[]): string[] {
  return rows.map((item) => item.id);
}

function person(overrides: Partial<BranchPerson>): BranchPerson {
  return { provider: BranchPersonProvider.GitHub, id: "gh-1", ...overrides };
}

describe("Branch list page: invalid evaluation clock", () => {
  it("rejects a non-ISO now in every exported entry point", () => {
    const rows = [row({})];
    expect(() =>
      buildBranchServerPageSnapshot(rows, query(), INVALID_NOW)
    ).toThrow(TypeError);
    expect(() => selectBranchServerRows(rows, query(), INVALID_NOW)).toThrow(
      INVALID_NOW_MESSAGE
    );
    expect(() => countRetainedUnavailableBranchRows(rows, INVALID_NOW)).toThrow(
      INVALID_NOW_MESSAGE
    );
    expect(() =>
      countImpossibleBranchLastActiveInstants(rows, INVALID_NOW)
    ).toThrow(INVALID_NOW_MESSAGE);
  });
});

describe("selectBranchServerRows", () => {
  it("sorts by the default status ordering when none is passed", () => {
    const rows = [
      row({ id: "merged", status: BranchStatus.Merged }),
      row({ id: "open", status: BranchStatus.Open }),
    ];
    const asc = selectBranchServerRows(
      rows,
      query({
        sortKey: BranchListSortKey.Status,
        sortDir: BranchListSortDirection.Asc,
      }),
      NOW
    );
    const desc = selectBranchServerRows(
      rows,
      query({
        sortKey: BranchListSortKey.Status,
        sortDir: BranchListSortDirection.Desc,
      }),
      NOW
    );
    expect(ids(asc)).toEqual(["open", "merged"]);
    expect(ids(desc)).toEqual(["merged", "open"]);
  });
});

describe("Branch list page: sort keys", () => {
  it("sorts by owner label ascending", () => {
    const rows = [
      row({ id: "zed", owner: "Zed" }),
      row({ id: "amy", owner: "Amy" }),
    ];
    const result = selectBranchServerRows(
      rows,
      query({
        sortKey: BranchListSortKey.Owner,
        sortDir: BranchListSortDirection.Asc,
      }),
      NOW
    );
    expect(ids(result)).toEqual(["amy", "zed"]);
  });

  it("sorts by session count descending", () => {
    const rows = [
      row({ id: "one", sessionIds: ["s1"] }),
      row({ id: "three", sessionIds: ["s1", "s2", "s3"] }),
    ];
    const result = selectBranchServerRows(
      rows,
      query({ sortKey: BranchListSortKey.Sessions }),
      NOW
    );
    expect(ids(result)).toEqual(["three", "one"]);
  });

  it("sorts pull requests by repository then number, rows without one last in both directions", () => {
    const rows = [
      row({ id: "none", prNumber: null }),
      row({ id: "web-9", repoFullName: "acme/web", prNumber: 9 }),
      row({ id: "api-50", repoFullName: "acme/api", prNumber: 50 }),
      row({ id: "web-2", repoFullName: "acme/web", prNumber: 2 }),
    ];
    const asc = selectBranchServerRows(
      rows,
      query({
        sortKey: BranchListSortKey.PullRequest,
        sortDir: BranchListSortDirection.Asc,
      }),
      NOW
    );
    const desc = selectBranchServerRows(
      rows,
      query({
        sortKey: BranchListSortKey.PullRequest,
        sortDir: BranchListSortDirection.Desc,
      }),
      NOW
    );
    expect(ids(asc)).toEqual(["api-50", "web-2", "web-9", "none"]);
    expect(ids(desc)).toEqual(["web-9", "web-2", "api-50", "none"]);
  });

  it("sorts by repository full name ascending", () => {
    const rows = [
      row({ id: "web", repoFullName: "acme/web" }),
      row({ id: "api", repoFullName: "acme/api" }),
    ];
    const result = selectBranchServerRows(
      rows,
      query({
        sortKey: BranchListSortKey.Repo,
        sortDir: BranchListSortDirection.Asc,
      }),
      NOW
    );
    expect(ids(result)).toEqual(["api", "web"]);
  });

  it("ranks a priority only a newer peer knows as unavailable, last", () => {
    const rows = [
      row({ id: "future", priority: FUTURE_PEER_PRIORITY }),
      row({ id: "high", priority: Priority.High }),
    ];
    const asc = selectBranchServerRows(
      rows,
      query({
        sortKey: BranchListSortKey.Priority,
        sortDir: BranchListSortDirection.Asc,
      }),
      NOW
    );
    expect(ids(asc)).toEqual(["high", "future"]);
  });
});

describe("Branch list page: changes arithmetic", () => {
  it("treats one null side of additions/deletions as zero", () => {
    const rows = [
      row({ id: "adds-only", additions: 3, deletions: null }),
      row({ id: "dels-only", additions: null, deletions: 7 }),
    ];
    const result = selectBranchServerRows(
      rows,
      query({ locMin: 5, locMax: 10 }),
      NOW
    );
    expect(ids(result)).toEqual(["dels-only"]);
    const small = selectBranchServerRows(rows, query({ locMax: 3 }), NOW);
    expect(ids(small)).toEqual(["adds-only"]);
  });
});

describe("Branch list page: date window", () => {
  it("applies an end-only window with no lower bound", () => {
    const rows = [
      row({ id: "early", lastActivityAt: "2026-08-10T00:00:00.000Z" }),
      row({ id: "late", lastActivityAt: "2026-08-18T17:50:00.000Z" }),
    ];
    const result = selectBranchServerRows(
      rows,
      query({ endDate: "2026-08-18T17:30:00.000Z" }),
      NOW
    );
    expect(ids(result)).toEqual(["early"]);
  });
});

describe("Branch list page: canonical last-active", () => {
  it("reads a complete canonical instant over a blank legacy timestamp", () => {
    const rows = [
      row({
        id: "canonical",
        lastActivityAt: "",
        canonicalLastActiveAt: {
          state: BranchMetricAvailability.Complete,
          value: "2026-08-18T17:30:00.000Z",
        },
      }),
      row({ id: "blank", lastActivityAt: "" }),
    ];
    expect(countRetainedUnavailableBranchRows(rows, NOW)).toBe(1);
    const sorted = selectBranchServerRows(rows, query(), NOW);
    expect(ids(sorted)).toEqual(["canonical", "blank"]);
  });
});

describe("Branch list page: people facets", () => {
  it("keys and labels owners from identity, falling back through displayName, login, id, and unattributed", () => {
    const rows = [
      row({
        id: "linked",
        ownerIdentity: {
          availability: BranchIdentityAvailability.Complete,
          person: person({ userId: "u-1", displayName: "Linked Person" }),
        },
      }),
      row({
        id: "login",
        ownerIdentity: {
          availability: BranchIdentityAvailability.Complete,
          person: person({ id: "gh-2", login: "octo" }),
        },
      }),
      row({
        id: "bare",
        ownerIdentity: {
          availability: BranchIdentityAvailability.Complete,
          person: person({ id: "gh-3" }),
        },
      }),
      row({ id: "nobody", owner: null }),
    ];
    const page = buildBranchServerPage(rows, query(), NOW);
    expect(page.facets.owners.options).toEqual(
      expect.arrayContaining([
        {
          id: `${BranchPersonProvider.ClosedLoop}:u-1`,
          label: "Linked Person",
          count: 1,
        },
        { id: `${BranchPersonProvider.GitHub}:gh-2`, label: "octo", count: 1 },
        { id: `${BranchPersonProvider.GitHub}:gh-3`, label: "gh-3", count: 1 },
        {
          id: BRANCH_OWNER_UNATTRIBUTED_LABEL,
          label: BRANCH_OWNER_UNATTRIBUTED_LABEL,
          count: 1,
        },
      ])
    );
    expect(page.facets.owners.options).toHaveLength(4);
  });

  it("filters by collaborator key and passes an empty selection through", () => {
    const rows = [
      row({
        id: "with",
        collaborators: {
          availability: BranchIdentityAvailability.Complete,
          people: [person({ id: "gh-9", login: "reviewer" })],
          sources: NO_COLLABORATOR_SOURCES,
        },
      }),
      row({ id: "without" }),
    ];
    const selected = selectBranchServerRows(
      rows,
      query({ collaborators: [`${BranchPersonProvider.GitHub}:gh-9`] }),
      NOW
    );
    expect(ids(selected)).toEqual(["with"]);
    const empty = selectBranchServerRows(
      rows,
      query({ collaborators: [] }),
      NOW
    );
    expect(ids(empty).sort()).toEqual(["with", "without"]);
  });
});

describe("Branch list page: pull request facet", () => {
  it("counts linked and unlinked rows", () => {
    const rows = [
      row({ id: "a", prNumber: 12 }),
      row({ id: "b", prNumber: null }),
      row({ id: "c", prNumber: null }),
    ];
    const page = buildBranchServerPage(rows, query(), NOW);
    expect(page.facets.pullRequests.options).toEqual([
      {
        id: BranchListPullRequestPresence.Linked,
        label: "Linked pull request",
        count: 1,
      },
      {
        id: BranchListPullRequestPresence.None,
        label: "No pull request",
        count: 2,
      },
    ]);
  });
});

describe("Branch list page: exported helpers", () => {
  it("renders an unlabelled status as its raw value", () => {
    expect(branchListStatusLabel("future-status")).toBe("future-status");
  });

  it("reports Incomplete when some but not all members are non-complete", () => {
    expect(branchListFacetAvailabilityFromCounts(3, 1, 0)).toBe(
      BranchListFacetAvailability.Incomplete
    );
  });

  it("buckets a row with no repository under the unknown-repository id", () => {
    const page = buildBranchServerPage(
      [row({ id: "orphan", repoFullName: null })],
      query(),
      NOW
    );
    expect(page.facets.repositories.options).toEqual([
      {
        id: BRANCH_REPOSITORY_UNKNOWN_LABEL,
        label: BRANCH_REPOSITORY_UNKNOWN_LABEL,
        count: 1,
      },
    ]);
  });

  it("keeps the raw repository value when it has no path segment", () => {
    expect(branchListRepositoryDisplayLabels(["/"]).get("/")).toBe("/");
  });
});
