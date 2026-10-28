import { describe, expect, it } from "vitest";
import {
  BRANCH_LIST_BLANK_OPERAND_SEMANTICS,
  BRANCH_LIST_DATE_WINDOW_VALUE_SEMANTICS,
  BRANCH_LIST_FILTER_VALUE_SEMANTICS,
  BRANCH_LIST_OPERAND_SEMANTICS,
  BRANCH_LIST_SORT_VALUE_SEMANTICS,
} from "../branch-list-value-semantics";
import {
  ListQueryFilterDisposition,
  listQueryFoldedRowDisposition,
} from "../list-query-value-semantics";

/**
 * Written out rather than derived from `BranchListFilterFacet`: a table built
 * from the very vocabulary it polices stays green when a member is deleted,
 * and what this table exists to pin is that the set is fixed.
 */
const DECLARED_FACET_DISPOSITIONS: Readonly<Record<string, string>> = {
  name: "total",
  owner: "selectable",
  collaborators: "exclude",
  changes: "exclude",
  status: "total",
  pullRequest: "selectable",
  lastActive: "exclude",
  repository: "selectable",
  tags: "exclude",
  priority: "selectable",
};

const DECLARED_SORT_KEYS = [
  "name",
  "owner",
  "sessions",
  "changes",
  "status",
  "pr",
  "lastActivity",
  "repo",
  "priority",
];

describe("Branch list value semantics", () => {
  it("declares a disposition for exactly the ten shipped filter facets", () => {
    expect(Object.keys(BRANCH_LIST_FILTER_VALUE_SEMANTICS).sort()).toEqual(
      Object.keys(DECLARED_FACET_DISPOSITIONS).sort()
    );
  });

  it("gives every facet the disposition the contract names", () => {
    for (const [facet, semantics] of Object.entries(
      BRANCH_LIST_FILTER_VALUE_SEMANTICS
    )) {
      expect(semantics.missing).toBe(DECLARED_FACET_DISPOSITIONS[facet]);
    }
  });

  /**
   * Asserted through the FOLD the facet predicates actually call, not as
   * `unavailable === missing` — that comparison holds whatever the record says
   * and pinned a field no predicate read (tamsinb, #7893). This fails if a facet
   * declares two answers its single nullable column cannot express.
   */
  it("gives every facet one disposition its folded predicate can honour", () => {
    for (const [facet, semantics] of Object.entries(
      BRANCH_LIST_FILTER_VALUE_SEMANTICS
    )) {
      expect(listQueryFoldedRowDisposition(semantics)).toBe(
        DECLARED_FACET_DISPOSITIONS[facet]
      );
    }
  });

  it("refuses a folded declaration that names two different answers", () => {
    expect(() =>
      listQueryFoldedRowDisposition({
        missing: ListQueryFilterDisposition.Retain,
        unavailable: ListQueryFilterDisposition.Exclude,
        evidence: "synthetic",
      })
    ).toThrow(TypeError);
  });

  it("retains a branch the date window cannot judge", () => {
    expect(BRANCH_LIST_DATE_WINDOW_VALUE_SEMANTICS.missing).toBe("retain");
    expect(BRANCH_LIST_DATE_WINDOW_VALUE_SEMANTICS.unavailable).toBe("retain");
  });

  it("orders an unrankable branch last on exactly the nine shipped sort keys", () => {
    expect(Object.keys(BRANCH_LIST_SORT_VALUE_SEMANTICS).sort()).toEqual(
      [...DECLARED_SORT_KEYS].sort()
    );
    for (const [, disposition] of Object.entries(
      BRANCH_LIST_SORT_VALUE_SEMANTICS
    )) {
      expect(disposition).toBe("last");
    }
  });

  it("decides the three list-wide request-operand situations, and no more", () => {
    expect(Object.keys(BRANCH_LIST_OPERAND_SEMANTICS).sort()).toEqual([
      "malformed",
      "retired",
      "unknown",
    ]);
  });

  /**
   * The list-wide record must NOT carry `blank`: it is the one case whose answer
   * differs per parameter, and stating it once is what made the record wrong for
   * 22 of 25 parameters. `branch-list-operand-semantics.test.ts` checks the
   * per-parameter table against the real schema.
   */
  it("declares blank per parameter rather than once for the list", () => {
    expect("blank" in BRANCH_LIST_OPERAND_SEMANTICS).toBe(false);
    expect(
      Object.values(BRANCH_LIST_BLANK_OPERAND_SEMANTICS).filter(
        (disposition) => disposition === "treatAsAbsent"
      )
    ).toEqual(["treatAsAbsent", "treatAsAbsent", "treatAsAbsent"]);
    expect(BRANCH_LIST_BLANK_OPERAND_SEMANTICS.search).toBe("refuse");
    expect(BRANCH_LIST_BLANK_OPERAND_SEMANTICS.startDate).toBe("refuse");
    expect(BRANCH_LIST_BLANK_OPERAND_SEMANTICS.names).toBe("refuse");
    expect(BRANCH_LIST_BLANK_OPERAND_SEMANTICS.locMin).toBe("treatAsAbsent");
  });

  it("refuses a malformed or unknown request operand rather than dropping it", () => {
    expect(BRANCH_LIST_OPERAND_SEMANTICS.malformed).toBe("refuse");
    expect(BRANCH_LIST_OPERAND_SEMANTICS.unknown).toBe("refuse");
  });

  it("names the operand the Branch list deliberately does not refuse", () => {
    expect(BRANCH_LIST_OPERAND_SEMANTICS.retired).toBe("ignore");
  });
});
