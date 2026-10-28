import { validateColumnDefinitions } from "@repo/design-system/lib/column-registry";
import { describe, expect, it } from "vitest";
import {
  APPROVED_BRANCH_COLUMN_DEFINITIONS,
  APPROVED_BRANCH_COLUMN_SPECS,
} from "../approved-branches-grid-adapter";

/**
 * ISS-9316 / PRD-716 phase 06. `createColumnRegistry` THROWS on a refused
 * declaration, and `approvedBranchColumnRegistry` builds it on first use rather
 * than at module scope — so the blast radius of a refusal is exactly the OPEN
 * arm of `branches-column-registry`, where it throws mid-render and blanks the
 * list. The closed arm never constructs a registry, so the gate really is the
 * rollback for a bad declaration as well as for the derivation.
 *
 * That boundary is what makes this suite load-bearing rather than redundant:
 * the failure it catches would otherwise reach only the users the flag is open
 * for, and nothing in the closed-arm suites would go red first.
 *
 * The declaration set is assembled from two files that no type links: a
 * column's `groupable` comes from `BRANCH_COLUMN_VIEW_MODEL`, its `kind` from
 * the adapter's own record, and `COLUMN_KIND_POLICY` refuses the pair for a
 * continuous kind. This runs that decision eagerly over the real declarations
 * so the next person to add a column gets the offending id and the rule in CI,
 * instead of a blank Branches list behind an opened flag.
 */
describe("the Branches column registry declarations", () => {
  it("validate clean, so opening the gate cannot throw mid-render", () => {
    expect(
      validateColumnDefinitions(APPROVED_BRANCH_COLUMN_DEFINITIONS)
    ).toEqual([]);
  });

  it("declare one column per rendered spec, carrying its width", () => {
    expect(APPROVED_BRANCH_COLUMN_DEFINITIONS.map((one) => one.id)).toEqual(
      APPROVED_BRANCH_COLUMN_SPECS.map((spec) => spec.id)
    );
    // 130px is the narrowest track this surface declares, so a definition set
    // that silently lost its widths would read as every column at the floor.
    expect(
      APPROVED_BRANCH_COLUMN_DEFINITIONS.map((one) => one.width?.default)
    ).toEqual([180, 120, 150, 140, 140, 145, 200, 130, 190, 210, 160]);
  });
});
