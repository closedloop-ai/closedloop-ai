import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BRANCH_LIST_MAX_FILTER_VALUES,
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListLastActiveRange,
  BranchListSortDirection,
  BranchListSortKey,
  type BranchServerPageQuery,
} from "@repo/api/src/types/branch-list-contract";
import { branchServerPageQuerySchema } from "@repo/api/src/types/branch-list-contract-schema";
import {
  DEFAULT_BRANCH_STATUS_ORDERING,
  ROOT_FIRST_BRANCH_STATUS_ORDERING,
} from "@repo/api/src/types/branch-status-order";
import { Priority } from "@repo/api/src/types/common";
import { PRIORITY_UNSET_VALUE } from "@repo/api/src/types/search-query";
import { describe, expect, it } from "vitest";
import {
  buildBranchServerPage,
  buildBranchServerPageSnapshot,
} from "./branch-list-page";
import {
  branchServerPageQuery as query,
  branchRow as row,
} from "./branch-list-page.test-fixtures";

const NOW = "2026-08-18T18:00:00.000Z";

describe("Branch server page contract", () => {
  it("repairs an out-of-range page after deterministic unavailable-last sort", () => {
    const rows = Array.from({ length: 47 }, (_, index) =>
      row({
        id: `branch-${index}`,
        branchName: `branch-${String(index).padStart(2, "0")}`,
        lastActivityAt:
          index === 0
            ? ""
            : new Date(Date.parse(NOW) - index * 60_000).toISOString(),
      })
    );

    const result = buildBranchServerPage(rows, query({ offset: 60 }), NOW);

    expect(result.pageInfo).toMatchObject({
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      requestedOffset: 60,
      offset: 40,
      now: NOW,
    });
    expect(result.items).toHaveLength(7);
    expect(result.total).toBe(47);
    expect(result.items.at(-1)?.id).toBe("branch-0");
  });

  it("returns the exact producer cohort with the repaired page", () => {
    const rows = [
      row({ id: "b", branchName: "b" }),
      row({ id: "a", branchName: "a" }),
      row({ id: "merged", status: BranchStatus.Merged }),
    ];

    const snapshot = buildBranchServerPageSnapshot(
      rows,
      query({ statuses: [BranchStatus.Open] }),
      NOW
    );

    expect(snapshot.cohortRows.map((item) => item.id)).toEqual(["a", "b"]);
    expect(snapshot.page.items).toEqual(snapshot.cohortRows);
    expect(snapshot.page.total).toBe(2);
  });

  it("returns zero-aware self-excluding counts and full repository identities", () => {
    const rows = [
      row({ id: "a", owner: "Alice", status: BranchStatus.Open }),
      row({ id: "b", owner: "Alice", status: BranchStatus.Merged }),
      row({
        id: "c",
        owner: "Bob",
        repoFullName: "other/web",
        status: BranchStatus.Open,
      }),
    ];

    const result = buildBranchServerPage(
      rows,
      query({ owners: ["Alice"], statuses: [BranchStatus.Open] }),
      NOW
    );

    expect(result.items.map((item) => item.id)).toEqual(["a"]);
    expect(facetCounts(result.facets.statuses.options)).toEqual({
      [BranchStatus.Open]: 1,
      [BranchStatus.Review]: 0,
      [BranchStatus.Merged]: 1,
      [BranchStatus.Draft]: 0,
      [BranchStatus.Blocked]: 0,
      [BranchStatus.Closed]: 0,
    });
    expect(facetCounts(result.facets.owners.options)).toEqual({
      Alice: 1,
      Bob: 1,
    });
    expect(
      result.facets.repositories.options.map(({ id, label }) => ({ id, label }))
    ).toEqual([
      { id: "acme/web", label: "acme/web" },
      { id: "other/web", label: "other/web" },
    ]);
  });

  it("uses one request instant for half-open Last-active facet buckets", () => {
    const rows = [
      row({ id: "recent", lastActivityAt: "2026-08-18T17:30:00.000Z" }),
      row({ id: "older", lastActivityAt: "2026-08-18T10:00:00.000Z" }),
    ];
    const result = buildBranchServerPage(
      rows,
      query({
        lastActiveRanges: [BranchListLastActiveRange.WithinLastHour],
      }),
      NOW
    );

    expect(result.items.map((item) => item.id)).toEqual(["recent"]);
    expect(facetCounts(result.facets.lastActiveRanges.options)).toEqual({
      [BranchListLastActiveRange.WithinLastHour]: 1,
      [BranchListLastActiveRange.OneToSixHours]: 0,
      [BranchListLastActiveRange.SevenToTwentyFourHours]: 1,
      [BranchListLastActiveRange.OneDayOrMore]: 0,
    });
  });
});

/**
 * ISS-9666 — the server page ordered branches by `BRANCH_STATUS_LABELS[status]`
 * with `localeCompare`, so a rename or translation of a label silently reordered
 * every server page. The label map is presentation and still names the FACET
 * OPTIONS; it no longer decides row order.
 */
describe("Branch server page status ordering", () => {
  it("orders by the canonical rank, not the label alphabet", () => {
    const rows = [
      row({ id: "closed", status: BranchStatus.Closed }),
      row({ id: "open", status: BranchStatus.Open }),
      row({ id: "draft", status: BranchStatus.Draft }),
      row({ id: "merged", status: BranchStatus.Merged }),
      row({ id: "blocked", status: BranchStatus.Blocked }),
      row({ id: "review", status: BranchStatus.Review }),
    ];

    const result = buildBranchServerPage(
      rows,
      query({
        sortKey: BranchListSortKey.Status,
        sortDir: BranchListSortDirection.Asc,
      }),
      NOW
    );

    // Spelled out as literals, not read back off BRANCH_STATUS_SORT_ORDER. The
    // label alphabet would have produced blocked ("Changes requested"), closed,
    // draft, review ("In review"), merged, open.
    expect(result.items.map((item) => item.id)).toEqual([
      "open",
      "review",
      "merged",
      "draft",
      "blocked",
      "closed",
    ]);
  });

  it("sorts in the same order the Status facet menu already lists", () => {
    const rows = [row({ id: "only", status: BranchStatus.Open })];

    const result = buildBranchServerPage(rows, query(), NOW);

    // The claim ISS-9666 rests on: the sort rank is not a new ranking invented
    // for this change, it is the order readers already see in the Status filter.
    //
    // ISS-9437 changed this expectation from `[...BRANCH_STATUS_SORT_ORDER]` to
    // a LITERAL, and the reason is the point of the change: reading the derived
    // constant back made this assertion true by construction, so it stayed green
    // for whatever order the constant happened to hold. A literal is the only
    // form that fails when the default order moves.
    expect(result.facets.statuses.options.map(({ id }) => id)).toEqual([
      "open",
      "review",
      "merged",
      "draft",
      "blocked",
      "closed",
    ]);
  });
});

describe("Branch server page priority (ISS-10332)", () => {
  const rows = [
    row({ id: "low", priority: Priority.Low }),
    row({ id: "unset", priority: null }),
    row({ id: "urgent", priority: Priority.Urgent }),
    // An older or local producer: the key is OMITTED, not null.
    row({ id: "unknown-producer" }),
    row({ id: "high", priority: Priority.High }),
    row({ id: "medium", priority: Priority.Medium }),
  ];
  const idsFor = (overrides: Partial<BranchServerPageQuery>) =>
    buildBranchServerPage(rows, query(overrides), NOW).items.map(
      (item) => item.id
    );

  it("orders by the wire ordinal, not the enum spelling, with no-priority rows last in BOTH directions", () => {
    // String order would be HIGH, LOW, MEDIUM, URGENT.
    expect(
      idsFor({
        sortKey: BranchListSortKey.Priority,
        sortDir: BranchListSortDirection.Asc,
      })
    ).toEqual(["low", "medium", "high", "urgent", "unknown-producer", "unset"]);
    expect(
      idsFor({
        sortKey: BranchListSortKey.Priority,
        sortDir: BranchListSortDirection.Desc,
      })
    ).toEqual(["urgent", "high", "medium", "low", "unknown-producer", "unset"]);
  });

  it("filters by member, by the unset arm, and by both; an empty selection admits every row", () => {
    expect(
      idsFor({ priorities: [Priority.High, Priority.Low] }).sort()
    ).toEqual(["high", "low"]);
    // The omitted row is "unknown to this producer", not "unset": it joins no
    // arm of an active selection.
    expect(idsFor({ priorities: [PRIORITY_UNSET_VALUE] })).toEqual(["unset"]);
    expect(
      idsFor({ priorities: [Priority.Urgent, PRIORITY_UNSET_VALUE] }).sort()
    ).toEqual(["unset", "urgent"]);
    expect(idsFor({ priorities: [] })).toHaveLength(rows.length);
  });

  it("drops the priority predicate from no other facet's counted population", () => {
    const page = buildBranchServerPage(
      rows,
      query({ priorities: [Priority.Urgent] }),
      NOW
    );
    // Every row shares one status, and only the URGENT row survives the
    // priority filter — so the Status facet, which keeps every OTHER filter,
    // counts exactly one.
    expect(
      page.facets.statuses.options.find(
        (option) => option.id === BranchStatus.Open
      )?.count
    ).toBe(1);
  });

  it("rejects an off-vocabulary priority at the strict boundary", () => {
    expect(
      branchServerPageQuerySchema.safeParse(
        query({ priorities: ["CRITICAL" as Priority] })
      ).success
    ).toBe(false);
    expect(
      branchServerPageQuerySchema.safeParse(
        query({ priorities: [Priority.Low, PRIORITY_UNSET_VALUE] })
      ).success
    ).toBe(true);
  });
});

/**
 * ISS-9437 — the resolved status ordering decides the Status sort AND the Status
 * facet, and the DEFAULT shape must reproduce today's page exactly.
 *
 * The unranked-status cases are not hypothetical: `BranchRow.status` is typed
 * `BranchStatus`, but rows arrive over a wire from a producer that may be a
 * build ahead of this one, so a value this vocabulary does not name is reachable
 * at runtime and the cast below is how the test reaches it.
 */
describe("Branch server page status ordering shapes", () => {
  const UNRANKED = "not-a-branch-status" as BranchStatus;

  const statusRows = () => [
    row({ id: "closed", status: BranchStatus.Closed }),
    row({ id: "open", status: BranchStatus.Open }),
    row({ id: "draft", status: BranchStatus.Draft }),
    row({ id: "merged", status: BranchStatus.Merged }),
    row({ id: "blocked", status: BranchStatus.Blocked }),
    row({ id: "review", status: BranchStatus.Review }),
    row({ id: "unranked", status: UNRANKED }),
  ];

  it("leaves the default page byte-identical, quirk included", () => {
    const asc = buildBranchServerPage(
      statusRows(),
      query({
        sortKey: BranchListSortKey.Status,
        sortDir: BranchListSortDirection.Asc,
      }),
      NOW,
      DEFAULT_BRANCH_STATUS_ORDERING
    );
    const desc = buildBranchServerPage(
      statusRows(),
      query({
        sortKey: BranchListSortKey.Status,
        sortDir: BranchListSortDirection.Desc,
      }),
      NOW,
      DEFAULT_BRANCH_STATUS_ORDERING
    );

    expect(asc.items.map((item) => item.id)).toEqual([
      "open",
      "review",
      "merged",
      "draft",
      "blocked",
      "closed",
      "unranked",
    ]);
    // The PRE-EXISTING quirk, pinned deliberately: the default rank parks an
    // unranked status at `BRANCH_STATUS_SORT_ORDER.length`, which is a REAL
    // number, so descending negates it to the TOP. ISS-9437 corrects that only
    // under the root-first shape; the flag-off path must not move a single row,
    // and a test that let this drift would hide exactly that.
    expect(desc.items.map((item) => item.id)).toEqual([
      "unranked",
      "closed",
      "blocked",
      "draft",
      "merged",
      "review",
      "open",
    ]);
    expect(asc.facets.statuses.options.map(({ id }) => id)).toEqual([
      "open",
      "review",
      "merged",
      "draft",
      "blocked",
      "closed",
    ]);
  });

  it("orders root-first and parks an unranked status last in BOTH directions", () => {
    const asc = buildBranchServerPage(
      statusRows(),
      query({
        sortKey: BranchListSortKey.Status,
        sortDir: BranchListSortDirection.Asc,
      }),
      NOW,
      ROOT_FIRST_BRANCH_STATUS_ORDERING
    );
    const desc = buildBranchServerPage(
      statusRows(),
      query({
        sortKey: BranchListSortKey.Status,
        sortDir: BranchListSortDirection.Desc,
      }),
      NOW,
      ROOT_FIRST_BRANCH_STATUS_ORDERING
    );

    // `draft` moves to the front: a draft PR is in progress, and every other
    // artifact surface bands in-progress work before anything in review.
    expect(asc.items.map((item) => item.id)).toEqual([
      "draft",
      "open",
      "review",
      "blocked",
      "merged",
      "closed",
      "unranked",
    ]);
    // Reversed, EXCEPT the unranked row, which stays last. `rank` reports null
    // for it, and null resolves through `compareMissing` before the direction
    // sign is applied.
    expect(desc.items.map((item) => item.id)).toEqual([
      "closed",
      "merged",
      "blocked",
      "review",
      "open",
      "draft",
      "unranked",
    ]);
  });

  it("moves the Status facet menu with the sort, not independently", () => {
    const result = buildBranchServerPage(
      statusRows(),
      query(),
      NOW,
      ROOT_FIRST_BRANCH_STATUS_ORDERING
    );

    // The facet used to be built inline from `Object.values(BranchStatus)` while
    // the sort called `branchStatusRank` — two derivations agreeing by
    // coincidence. Reordering the sort alone would leave this list unchanged.
    expect(result.facets.statuses.options.map(({ id }) => id)).toEqual([
      "draft",
      "open",
      "review",
      "blocked",
      "merged",
      "closed",
    ]);
    // Only the ORDER moves. The option SET and its LABELS are unchanged, which
    // ISS-9437 puts explicitly out of scope.
    expect(result.facets.statuses.options.map(({ label }) => label)).toEqual([
      "Draft",
      "Open",
      "In review",
      "Changes requested",
      "Merged",
      "Closed",
    ]);
  });

  it("partitions the same corpus with no drop and no duplicate under either ordering", () => {
    const corpus = Array.from({ length: 47 }, (_, index) =>
      row({
        id: `branch-${String(index).padStart(2, "0")}`,
        branchName: `feature/${String(index).padStart(2, "0")}`,
        status: PARTITION_STATUSES[index % PARTITION_STATUSES.length],
      })
    );

    for (const ordering of [
      DEFAULT_BRANCH_STATUS_ORDERING,
      ROOT_FIRST_BRANCH_STATUS_ORDERING,
    ]) {
      const whole = buildBranchServerPageSnapshot(
        corpus,
        query({
          sortKey: BranchListSortKey.Status,
          sortDir: BranchListSortDirection.Asc,
        }),
        NOW,
        ordering
      ).cohortRows.map((item) => item.id);
      const paged: string[] = [];
      for (
        let offset = 0;
        offset < corpus.length;
        offset += BRANCH_LIST_SERVER_PAGE_SIZE
      ) {
        paged.push(
          ...buildBranchServerPage(
            corpus,
            query({
              offset,
              sortKey: BranchListSortKey.Status,
              sortDir: BranchListSortDirection.Asc,
            }),
            NOW,
            ordering
          ).items.map((item) => item.id)
        );
      }

      // Concatenating every page reproduces the ordered cohort exactly — same
      // rows, same order, nothing dropped between page boundaries and nothing
      // served twice. The corpus is FIXED across the reads, so a row that moved
      // could only have moved because the paging is wrong.
      expect(paged).toEqual(whole);
      expect(new Set(paged).size).toBe(corpus.length);
    }
  });
});

const PARTITION_STATUSES: readonly BranchStatus[] = [
  BranchStatus.Closed,
  BranchStatus.Open,
  BranchStatus.Draft,
  BranchStatus.Merged,
  BranchStatus.Blocked,
  BranchStatus.Review,
];

describe("branchServerPageQuerySchema", () => {
  it("rejects unknown fields, unsupported statuses, inverted LOC, and unaligned pages", () => {
    expect(() =>
      branchServerPageQuerySchema.parse({ ...query(), futureFilter: ["x"] })
    ).toThrow();
    expect(() =>
      branchServerPageQuerySchema.parse({
        ...query(),
        statuses: ["not-a-status"],
      })
    ).toThrow();
    expect(() =>
      branchServerPageQuerySchema.parse({ ...query(), locMin: 10, locMax: 9 })
    ).toThrow();
    expect(() =>
      branchServerPageQuerySchema.parse({ ...query(), offset: 1 })
    ).toThrow();
  });

  it("accepts aligned offsets beyond the former ceiling and the full filter cap", () => {
    expect(() =>
      branchServerPageQuerySchema.parse({
        ...query({ offset: 10_020 }),
        names: Array.from(
          { length: BRANCH_LIST_MAX_FILTER_VALUES },
          (_, index) => `feature/${index}`
        ),
      })
    ).not.toThrow();
  });
});

function facetCounts(
  options: readonly { id: string; count: number }[]
): Record<string, number> {
  return Object.fromEntries(options.map((option) => [option.id, option.count]));
}
