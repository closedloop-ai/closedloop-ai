import {
  DEFAULT_BRANCH_STATUS_ORDERING,
  ROOT_FIRST_BRANCH_STATUS_ORDERING,
} from "@repo/api/src/types/branch-status-order";
import { Priority } from "@repo/api/src/types/common";
import { branchRow as row } from "@repo/app/branches/lib/__tests__/branch-row-fixture";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBranchDisplayRows } from "../branch-page-state";
import { type BranchRow, BranchRowStatus, RENDER_MISSING } from "../branch-row";
import {
  BranchSortDir,
  BranchSortKey,
  sortBranchRows,
} from "../branch-sort-group";

describe("sortBranchRows", () => {
  it("sorts by name ascending and descending", () => {
    const rows = [
      row({ id: "c", branchName: "c" }),
      row({ id: "a", branchName: "a" }),
      row({ id: "b", branchName: "b" }),
    ];
    expect(
      sortBranchRows(rows, BranchSortKey.Name, BranchSortDir.Asc).map(
        (r) => r.id
      )
    ).toEqual(["a", "b", "c"]);
    expect(
      sortBranchRows(rows, BranchSortKey.Name, BranchSortDir.Desc).map(
        (r) => r.id
      )
    ).toEqual(["c", "b", "a"]);
  });

  it("sorts by changes (additions+deletions) and sessions", () => {
    const rows = [
      row({ id: "small", additions: 1, deletions: 1, sessionCount: 5 }),
      row({ id: "big", additions: 100, deletions: 50, sessionCount: 1 }),
    ];
    expect(
      sortBranchRows(rows, BranchSortKey.Changes, BranchSortDir.Desc).map(
        (r) => r.id
      )
    ).toEqual(["big", "small"]);
    expect(
      sortBranchRows(rows, BranchSortKey.Sessions, BranchSortDir.Desc).map(
        (r) => r.id
      )
    ).toEqual(["small", "big"]);
  });

  it("sorts by lastActivity by instant — desc newest-first, asc oldest-first, mixed formats", () => {
    // Mixed separators (space vs `T`) on purpose: a byte-wise compare would
    // misorder the space-separated value, so this proves the sort parses instants.
    const rows = [
      row({ id: "old", lastActivityAt: "2026-06-10 00:00:00" }),
      row({ id: "new", lastActivityAt: "2026-06-18T00:00:00.000Z" }),
      row({ id: "mid", lastActivityAt: "2026-06-14T00:00:00.000Z" }),
    ];
    expect(
      sortBranchRows(rows, BranchSortKey.LastActivity, BranchSortDir.Desc).map(
        (r) => r.id
      )
    ).toEqual(["new", "mid", "old"]);
    expect(
      sortBranchRows(rows, BranchSortKey.LastActivity, BranchSortDir.Asc).map(
        (r) => r.id
      )
    ).toEqual(["old", "mid", "new"]);
  });
});

describe("legacy-path window (resolveBranchDisplayRows)", () => {
  const START = "2026-06-17T00:00:00.000Z";
  const END = "2026-06-17T23:59:59.999Z";

  it("returns all rows when the window is 'All time' (no startDate)", () => {
    const rows = [row({ id: "a" }), row({ id: "b" })];
    expect(windowLegacyRows(rows, undefined)).toBe(rows);
  });

  it("compares by instant, not byte-wise — keeps a recent space-separated timestamp", () => {
    // Same calendar date as START but a space separator (` ` 0x20) sorts before
    // `T` (0x54) in a string compare, so a byte-wise filter would wrongly drop
    // this still-recent row. Its instant is on/after START in every timezone.
    const rows = [
      row({ id: "recent", lastActivityAt: "2026-06-17 23:59:59" }),
      row({ id: "old", lastActivityAt: "2026-06-10 12:00:00" }),
    ];
    expect(windowLegacyRows(rows, START).map((r) => r.id)).toEqual(["recent"]);
  });

  it("keeps rows with a null or unparseable timestamp (never silently drops)", () => {
    const rows = [
      row({ id: "null", lastActivityAt: undefined }),
      row({ id: "junk", lastActivityAt: "not-a-date" }),
    ];
    expect(
      windowLegacyRows(rows, START)
        .map((r) => r.id)
        .sort()
    ).toEqual(["junk", "null"]);
  });

  it("excludes activity after a completed window's upper bound", () => {
    const rows = [
      row({ id: "inside", lastActivityAt: "2026-06-17T12:00:00.000Z" }),
      row({ id: "future", lastActivityAt: "2026-06-18T00:00:00.000Z" }),
    ];
    expect(windowLegacyRows(rows, START, END).map((item) => item.id)).toEqual([
      "inside",
    ]);
  });

  it("retains a row whose Last active is after the evaluation clock, as the server path does", () => {
    const rows = [
      row({ id: "inside", lastActivityAt: "2026-06-17T12:00:00.000Z" }),
      row({ id: "ahead", lastActivityAt: "2026-06-20T00:00:00.000Z" }),
      row({ id: "before", lastActivityAt: "2026-06-16T12:00:00.000Z" }),
    ];
    expect(
      windowLegacyRows(
        rows,
        START,
        END,
        new Date("2026-06-17T18:00:00.000Z")
      ).map((item) => item.id)
    ).toEqual(["inside", "ahead"]);
  });
});

describe("sortBranchRows — complete approved and legacy ordering", () => {
  it("sorts owner, repository, status, and pull-request values", () => {
    const rows = [
      row({
        id: "z",
        owner: "Zed",
        repo: "org/zeta",
        status: BranchRowStatus.Review,
        prRepo: "org/zeta",
        prNumber: 2,
      }),
      row({
        id: "a2",
        owner: "Ada",
        repo: "org/alpha",
        status: BranchRowStatus.Open,
        prRepo: "org/alpha",
        prNumber: 20,
      }),
      row({
        id: "a1",
        owner: "Bob",
        repo: "org/beta",
        status: BranchRowStatus.Merged,
        prRepo: "org/alpha",
        prNumber: 3,
      }),
    ];

    expect(
      ids(sortBranchRows(rows, BranchSortKey.Owner, BranchSortDir.Asc))
    ).toEqual(["a2", "a1", "z"]);
    expect(
      ids(sortBranchRows(rows, BranchSortKey.Repo, BranchSortDir.Desc))
    ).toEqual(["z", "a1", "a2"]);
    // ISS-9666: ranked, not label-alphabetical. Open(0) < Review(1) < Merged(2),
    // so a2 (Open) leads, then z (In review), then a1 (Merged). The old order
    // ["z","a1","a2"] was "In review" < "Merged" < "Open" — the LABELS sorted.
    expect(
      ids(sortBranchRows(rows, BranchSortKey.Status, BranchSortDir.Asc))
    ).toEqual(["a2", "z", "a1"]);
    expect(
      ids(sortBranchRows(rows, BranchSortKey.PullRequest, BranchSortDir.Asc))
    ).toEqual(["a1", "a2", "z"]);
  });

  it("keeps unavailable values last in either direction", () => {
    const missing = row({
      id: "missing",
      repo: RENDER_MISSING,
      additions: null,
      deletions: null,
      prRepo: null,
      prNumber: null,
      lastActivityAt: "not-a-date",
    });
    const available = row({
      id: "available",
      repo: "org/repo",
      additions: 0,
      deletions: null,
      prRepo: "org/repo",
      prNumber: 0,
      lastActivityAt: "2026-08-20T00:00:00Z",
    });
    for (const key of [
      BranchSortKey.Changes,
      BranchSortKey.PullRequest,
      BranchSortKey.LastActivity,
      BranchSortKey.Repo,
    ]) {
      expect(
        ids(sortBranchRows([missing, available], key, BranchSortDir.Asc))
      ).toEqual(["available", "missing"]);
      expect(
        ids(sortBranchRows([missing, available], key, BranchSortDir.Desc))
      ).toEqual(["available", "missing"]);
    }
  });

  /**
   * ISS-10332 review: `BranchRow.priority` is narrower than the wire, so a
   * member only a newer producer knows reaches this sort. Indexing
   * `PRIORITY_ORDINAL` raw handed `compareAvailable` an `undefined` it
   * string-compared ("undefined" against "2"); the sanctioned accessor misses
   * instead, so the row parks with the unset one — last in both directions.
   */
  it("parks a priority this build does not know in the unset row's slot, on both arms", () => {
    const rows = [
      row({ id: "unknown", priority: "CRITICAL" as Priority }),
      row({ id: "high", priority: Priority.High }),
      row({ id: "unset", priority: null }),
      row({ id: "low", priority: Priority.Low }),
    ];
    expect(
      ids(sortBranchRows(rows, BranchSortKey.Priority, BranchSortDir.Asc))
    ).toEqual(["low", "high", "unknown", "unset"]);
    expect(
      ids(sortBranchRows(rows, BranchSortKey.Priority, BranchSortDir.Desc))
    ).toEqual(["high", "low", "unknown", "unset"]);
    // The legacy arm parks it in the same slot rather than comparing NaN — but
    // that slot is the SENTINEL past every ranked value, not `compareMissing`:
    // this arm has no unavailable-value handling and negates its comparison
    // wholesale (ISS-9437), so the sentinel trails ascending and leads
    // descending, exactly as its status arm has always behaved. What is pinned
    // here is that the accessor's miss lands in that slot instead of reaching
    // the comparator as `undefined`.
    const legacyAsc = ids(
      sortBranchRows(rows, BranchSortKey.Priority, BranchSortDir.Asc, false)
    );
    expect(legacyAsc.slice(0, 2)).toEqual(["low", "high"]);
    expect(legacyAsc.slice(2)).toContain("unknown");
    expect(legacyAsc.slice(2)).toContain("unset");
    const legacyDesc = ids(
      sortBranchRows(rows, BranchSortKey.Priority, BranchSortDir.Desc, false)
    );
    expect(legacyDesc.slice(2)).toEqual(["high", "low"]);
    expect(legacyDesc.slice(0, 2)).toContain("unknown");
    expect(legacyDesc.slice(0, 2)).toContain("unset");
  });

  it("uses canonical identity and then id to break equal-value ties", () => {
    const rows = [
      row({ id: "z", branchName: "same", canonicalIdentity: "one" }),
      row({ id: "a", branchName: "same", canonicalIdentity: "two" }),
      row({ id: "b", branchName: "same" }),
    ];
    expect(
      ids(sortBranchRows(rows, BranchSortKey.Name, BranchSortDir.Asc))
    ).toEqual(["b", "z", "a"]);
  });

  it("pins the legacy comparator for every legacy sort key", () => {
    const early = row({
      id: "early",
      branchName: "a",
      repo: "org/a",
      owner: "Ada",
      status: BranchRowStatus.Open,
      additions: null,
      deletions: 1,
      sessionCount: 1,
      lastActivityAt: "invalid",
      priority: Priority.Low,
    });
    const late = row({
      id: "late",
      branchName: "z",
      repo: "org/z",
      owner: "Zed",
      status: BranchRowStatus.Review,
      additions: 2,
      deletions: null,
      sessionCount: 2,
      lastActivityAt: "2026-08-20T00:00:00Z",
      priority: Priority.High,
    });
    const ascendingFirstByKey: Record<BranchSortKey, string> = {
      [BranchSortKey.Name]: "early",
      [BranchSortKey.Repo]: "early",
      [BranchSortKey.Owner]: "early",
      // ISS-9666: `early` is Open (rank 0) and `late` is Review (rank 1), so the
      // ranked comparator leads with `early`. Under the old label sort
      // "In review" < "Open" put `late` first.
      [BranchSortKey.Status]: "early",
      [BranchSortKey.Changes]: "early",
      [BranchSortKey.LastActivity]: "early",
      [BranchSortKey.Sessions]: "early",
      [BranchSortKey.PullRequest]: "early",
      // ISS-10332: `early` is LOW (ordinal 0) and `late` is HIGH (ordinal 2) on
      // the wire ordinal, so ascending leads with `early`.
      [BranchSortKey.Priority]: "early",
    };
    for (const key of Object.values(BranchSortKey)) {
      const ascendingFirst = ascendingFirstByKey[key];
      const descendingFirst = ascendingFirst === "early" ? "late" : "early";
      expect(
        ids(sortBranchRows([late, early], key, BranchSortDir.Asc, false)),
        key
      ).toEqual([ascendingFirst, descendingFirst]);
      expect(
        ids(sortBranchRows([early, late], key, BranchSortDir.Desc, false)),
        key
      ).toEqual([descendingFirst, ascendingFirst]);
    }
  });
});

describe("legacy-path window — boundary variants", () => {
  it("supports an end-only window and preserves rows for invalid boundaries", () => {
    const rows = [
      row({ id: "old", lastActivityAt: "2026-06-17T00:00:00Z" }),
      row({ id: "new", lastActivityAt: "2026-06-19T00:00:00Z" }),
    ];
    expect(
      ids(windowLegacyRows(rows, undefined, "2026-06-18T00:00:00Z"))
    ).toEqual(["old"]);
    // An unparseable bound is not applied, so every row stays (the shared
    // classifier's reading, ISS-11915).
    expect(windowLegacyRows(rows, "invalid", undefined)).toEqual(rows);
    expect(windowLegacyRows(rows, undefined, "invalid")).toEqual(rows);
  });
});

/**
 * ISS-9437 — the CLIENT comparator takes the same resolved ordering the server
 * page takes, so a row cannot band one way on a server page and another after a
 * client re-sort. Pinned per site: fixing only one of the two leaves the other
 * red.
 *
 * `BranchRowStatus` does not name an unranked value, but rows are adapted from a
 * wire payload a producer one build ahead can widen, so the cast below reaches a
 * state that is reachable at runtime.
 */
describe("sortBranchRows — resolved status ordering (ISS-9437)", () => {
  const UNRANKED = "not-a-branch-status" as BranchRowStatus;

  const statusRows = () => [
    row({ id: "closed", status: BranchRowStatus.Closed }),
    row({ id: "open", status: BranchRowStatus.Open }),
    row({ id: "draft", status: BranchRowStatus.Draft }),
    row({ id: "merged", status: BranchRowStatus.Merged }),
    row({ id: "blocked", status: BranchRowStatus.Blocked }),
    row({ id: "review", status: BranchRowStatus.Review }),
    row({ id: "unranked", status: UNRANKED }),
  ];

  it("keeps the default order byte-identical, including the descending float", () => {
    expect(
      ids(
        sortBranchRows(
          statusRows(),
          BranchSortKey.Status,
          BranchSortDir.Asc,
          true,
          DEFAULT_BRANCH_STATUS_ORDERING
        )
      )
    ).toEqual([
      "open",
      "review",
      "merged",
      "draft",
      "blocked",
      "closed",
      "unranked",
    ]);
    // The pre-existing quirk. The default rank returns a real number for an
    // unranked status, so descending negates it to the TOP. Flag-off must not
    // move a single row, so this stays exactly as it is today.
    expect(
      ids(
        sortBranchRows(
          statusRows(),
          BranchSortKey.Status,
          BranchSortDir.Desc,
          true,
          DEFAULT_BRANCH_STATUS_ORDERING
        )
      )
    ).toEqual([
      "unranked",
      "closed",
      "blocked",
      "draft",
      "merged",
      "review",
      "open",
    ]);
  });

  it("orders root-first and parks an unranked status last in BOTH directions", () => {
    expect(
      ids(
        sortBranchRows(
          statusRows(),
          BranchSortKey.Status,
          BranchSortDir.Asc,
          true,
          ROOT_FIRST_BRANCH_STATUS_ORDERING
        )
      )
    ).toEqual([
      "draft",
      "open",
      "review",
      "blocked",
      "merged",
      "closed",
      "unranked",
    ]);
    expect(
      ids(
        sortBranchRows(
          statusRows(),
          BranchSortKey.Status,
          BranchSortDir.Desc,
          true,
          ROOT_FIRST_BRANCH_STATUS_ORDERING
        )
      )
    ).toEqual([
      "closed",
      "merged",
      "blocked",
      "review",
      "open",
      "draft",
      "unranked",
    ]);
  });

  it("threads the ordering into the legacy arm too", () => {
    // `approved: false` is unreachable in production, and that is exactly why it
    // is pinned: left calling the module-level rank it would be a third
    // reference to the thing the resolved shape exists to replace, and nothing
    // else in the suite would notice.
    expect(
      ids(
        sortBranchRows(
          statusRows(),
          BranchSortKey.Status,
          BranchSortDir.Asc,
          false,
          ROOT_FIRST_BRANCH_STATUS_ORDERING
        )
      )
    ).toEqual([
      "draft",
      "open",
      "review",
      "blocked",
      "merged",
      "closed",
      "unranked",
    ]);
  });

  it("defaults to today's ordering when a caller resolves nothing", () => {
    // Every existing caller omits the argument. If the default ever stopped
    // being the vocabulary order, every un-migrated surface would silently
    // reorder — so the omitted call is pinned against the explicit one.
    expect(
      ids(sortBranchRows(statusRows(), BranchSortKey.Status, BranchSortDir.Asc))
    ).toEqual(
      ids(
        sortBranchRows(
          statusRows(),
          BranchSortKey.Status,
          BranchSortDir.Asc,
          true,
          DEFAULT_BRANCH_STATUS_ORDERING
        )
      )
    );
  });
});

function ids(rows: BranchRow[]): string[] {
  return rows.map((item) => item.id);
}

/**
 * ISS-9585 — the renderer mirror of the query-ordering ruling. This module is
 * the legacy-mode sort BOTH shells run (apps/app and the desktop renderer), so
 * a host-dependent comparator or window bound here reorders or re-populates the
 * same saved query per machine, exactly as it did in the two server compilers.
 */
describe("Branch list renderer ordering semantics (ISS-9585)", () => {
  // Unconditional, so a throw mid-case cannot leak a zone into a later test in
  // this worker.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * A pair whose collated order is the reverse of its UTF-16 order: every
   * uppercase letter precedes every lowercase one by code unit, and "ä" (0xe4)
   * follows all of them. A same-case ASCII fixture agrees under both and could
   * not fail. Sequences are written out, never derived from the comparator.
   */
  it("collates names rather than ranking them by code unit", () => {
    const rows = [
      row({ id: "Zeta", branchName: "Zeta" }),
      row({ id: "alpha", branchName: "alpha" }),
      row({ id: "arger", branchName: "ärger" }),
      row({ id: "Beta", branchName: "Beta" }),
    ];

    expect(
      sortBranchRows(rows, BranchSortKey.Name, BranchSortDir.Asc).map(
        (r) => r.id
      )
    ).toEqual(["alpha", "arger", "Beta", "Zeta"]);
  });

  it("reads a zone-less window bound as the same instant on every host", () => {
    const rows = [
      row({ id: "between", lastActivityAt: "2026-09-25T02:00:00.000Z" }),
    ];
    const unanchored: number[] = [];

    const kept = ["UTC", "America/Chicago", "Asia/Tokyo"].map((zone) => {
      vi.stubEnv("TZ", zone);
      unanchored.push(Date.parse("2026-09-25T00:00:00"));
      return windowLegacyRows(rows, "2026-09-25T00:00:00").length;
    });

    // The premise, asserted rather than assumed: the stub really moves the
    // clock, so an unanchored bound WOULD name three instants here and Chicago
    // would drop the row. Without this the agreement below passes vacuously.
    expect(new Set(unanchored).size).toBe(3);
    expect(kept).toEqual([1, 1, 1]);
  });

  it("still drops a row that falls before the anchored bound", () => {
    vi.stubEnv("TZ", "Asia/Tokyo");

    expect(
      windowLegacyRows(
        [row({ id: "before", lastActivityAt: "2026-09-24T23:00:00.000Z" })],
        "2026-09-25T00:00:00"
      )
    ).toEqual([]);
  });
});

/**
 * ISS-9585, the arms the block above left uncovered (marisolashgrove, PR #7954).
 *
 * That block drives `BranchSortKey.Name`, whose `sortValue` is a string and so
 * only ever reaches `compareAvailable`'s `String(left)` fallback. Three further
 * comparators in this module were swapped to the ruling and no case reached any
 * of them, so each could be reverted — or replaced outright — with the suite
 * green.
 *
 * What these DO pin is the class each arm ranks under: every fixture's collated
 * order is the reverse of its UTF-16 order, so an arm re-ranked by code unit
 * (the `C` collation the SQL mirror names for identifiers) reds it. What they
 * cannot pin is the ruling's OTHER half — that `Collated` is locale-pinned to
 * `"en"` rather than the host's — because the two agree on an `en` runner and
 * `Intl` reads its default locale once at startup, so no in-process stub moves
 * it. `LIST_QUERY_COLLATED_LOCALE`'s own suite owns that half.
 */
describe("Branch list renderer ordering semantics — remaining arms (ISS-9585)", () => {
  it("collates the canonical-identity tie-break between otherwise equal rows", () => {
    const rows = [
      row({ id: "z", canonicalIdentity: "Zeta", sessionCount: 1 }),
      row({ id: "a", canonicalIdentity: "alpha", sessionCount: 1 }),
      row({ id: "b", canonicalIdentity: "Beta", sessionCount: 1 }),
    ];

    // Written out, not derived: by code unit this is Beta, Zeta, alpha.
    expect(
      ids(sortBranchRows(rows, BranchSortKey.Sessions, BranchSortDir.Asc))
    ).toEqual(["a", "b", "z"]);
  });

  it("collates the repository half of a pull-request sort", () => {
    const rows = [
      row({ id: "z", prRepo: "Zeta/api", prNumber: 1 }),
      row({ id: "a", prRepo: "alpha/api", prNumber: 2 }),
      row({ id: "b", prRepo: "Beta/api", prNumber: 3 }),
    ];

    expect(
      ids(sortBranchRows(rows, BranchSortKey.PullRequest, BranchSortDir.Asc))
    ).toEqual(["a", "b", "z"]);
  });

  it("orders the pull-request number only within one repository", () => {
    const rows = [
      row({ id: "high", prRepo: "acme/api", prNumber: 9 }),
      row({ id: "low", prRepo: "acme/api", prNumber: 2 }),
    ];

    expect(
      ids(sortBranchRows(rows, BranchSortKey.PullRequest, BranchSortDir.Asc))
    ).toEqual(["low", "high"]);
  });

  it("collates the legacy arm, which no production caller reaches", () => {
    const rows = [
      row({ id: "z", branchName: "Zeta" }),
      row({ id: "a", branchName: "alpha" }),
      row({ id: "b", branchName: "Beta" }),
    ];

    expect(
      ids(sortBranchRows(rows, BranchSortKey.Name, BranchSortDir.Asc, false))
    ).toEqual(["a", "b", "z"]);
  });
});

function windowLegacyRows(
  rows: BranchRow[],
  startDate: string | undefined,
  endDate?: string,
  evaluationNow?: Date
): BranchRow[] {
  return resolveBranchDisplayRows(rows, {
    serverPageActive: false,
    startDate,
    endDate,
    sortKey: BranchSortKey.Name,
    sortDir: BranchSortDir.Asc,
    evaluationNow,
  }).visibleRows;
}
