import {
  BRANCH_EVALUATION_NOW_PARAM,
  BRANCH_LOC_MIN_PARAM,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BranchListPageMode,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import {
  BRANCH_LIST_BLANK_OPERAND_SEMANTICS,
  type BranchListBlankOperand,
} from "@repo/api/src/types/branch-list-value-semantics";
import { ListQueryOperandDisposition } from "@repo/api/src/types/list-query-value-semantics";
import { describe, expect, it } from "vitest";
import {
  BRANCH_LIST_QUERY_PARAM_KEYS,
  branchListQuerySchema,
} from "./branch-list-query";

/**
 * Parameters `pageMode=server` refuses outright, so a blank one of these has to
 * be measured in legacy mode or the mode incompatibility, not the blank, is what
 * refuses it. `startDate`/`endDate` are accepted in both modes and need no base.
 */
const SERVER_INCOMPATIBLE_PARAMS = new Set<BranchListBlankOperand>([
  "repo",
  "repository",
  "status",
  "search",
  "projectId",
  "contributorUserId",
  "sessionPresence",
]);

/**
 * Drives the real Branch list parse boundary, because the failure this pins is
 * a request that SUCCEEDS with an operand quietly missing — which is
 * indistinguishable from a correct parse unless the parse itself is observed.
 */
function serverQuery(overrides: Record<string, unknown>) {
  return { pageMode: BranchListPageMode.Server, ...overrides };
}

describe("Branch list request operand semantics", () => {
  it("refuses an unknown status rather than answering the wider query", () => {
    const refused = branchListQuerySchema.safeParse(
      serverQuery({ statuses: ["not-a-status"] })
    );
    const accepted = branchListQuerySchema.safeParse(
      serverQuery({ statuses: [BranchStatus.Open] })
    );

    expect(refused.success).toBe(false);
    expect(accepted.success).toBe(true);
    expect(accepted.success && accepted.data.statuses).toEqual([
      BranchStatus.Open,
    ]);
  });

  it("refuses a malformed change bound rather than removing the bound", () => {
    const refused = branchListQuerySchema.safeParse(
      serverQuery({ [BRANCH_LOC_MIN_PARAM]: "abc" })
    );
    const accepted = branchListQuerySchema.safeParse(
      serverQuery({ [BRANCH_LOC_MIN_PARAM]: "5" })
    );

    expect(refused.success).toBe(false);
    expect(accepted.success && accepted.data.locMin).toBe(5);
  });

  it("refuses an unknown sort key rather than sorting by something else", () => {
    const refused = branchListQuerySchema.safeParse(
      serverQuery({ sortKey: "not-a-key" })
    );
    const accepted = branchListQuerySchema.safeParse(
      serverQuery({ sortKey: BranchListSortKey.Name })
    );

    expect(refused.success).toBe(false);
    expect(accepted.success).toBe(true);
  });

  it("reads a blank change bound as a bound the caller did not send", () => {
    const parsed = branchListQuerySchema.safeParse(
      serverQuery({ [BRANCH_LOC_MIN_PARAM]: "" })
    );

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.locMin).toBeUndefined();
  });

  it("declares a blank disposition for exactly the parameters the schema admits", () => {
    expect([...BRANCH_LIST_QUERY_PARAM_KEYS].sort()).toEqual(
      Object.keys(BRANCH_LIST_BLANK_OPERAND_SEMANTICS).sort()
    );
  });

  /**
   * The measurement tamsinb ran by hand (#7893), made permanent. A single
   * list-wide `Blank: TreatAsAbsent` claimed to cover the parse boundary and was
   * wrong for 22 of these 25, so what makes the declaration load-bearing is not
   * a predicate deriving from it — most parameters refuse through their own
   * bound — but this table being checked against the real schema, per parameter,
   * in both directions.
   */
  it.each(
    Object.entries(BRANCH_LIST_BLANK_OPERAND_SEMANTICS) as [
      BranchListBlankOperand,
      ListQueryOperandDisposition,
    ][]
  )(
    "parses a blank %s exactly as its declared disposition %s",
    (param, declared) => {
      const base = SERVER_INCOMPATIBLE_PARAMS.has(param)
        ? {}
        : { pageMode: BranchListPageMode.Server };
      const blank = branchListQuerySchema.safeParse({ ...base, [param]: "" });
      const omitted = branchListQuerySchema.safeParse(base);

      expect(blank.success).toBe(
        declared === ListQueryOperandDisposition.TreatAsAbsent
      );
      if (blank.success && omitted.success) {
        // "As if the caller had not sent it" asserted as exactly that, rather
        // than against a hand-written expected value: `offset` coerces `""` to
        // its own default instead of dropping the key, so the outcome that
        // matters is agreement with the omitted parse, not `undefined`.
        expect((blank.data as Record<string, unknown>)[param]).toEqual(
          (omitted.data as Record<string, unknown>)[param]
        );
      }
    }
  );

  it("strips the retired evaluation clock instead of refusing the read", () => {
    const parsed = branchListQuerySchema.safeParse(
      serverQuery({
        [BRANCH_EVALUATION_NOW_PARAM]: "2026-08-18T18:00:00.000Z",
        statuses: [BranchStatus.Open],
      })
    );

    expect(parsed.success).toBe(true);
    expect(parsed.success && BRANCH_EVALUATION_NOW_PARAM in parsed.data).toBe(
      false
    );
    expect(parsed.success && parsed.data.statuses).toEqual([BranchStatus.Open]);
  });
});
