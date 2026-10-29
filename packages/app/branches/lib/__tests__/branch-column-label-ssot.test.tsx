import { describe, expect, it, vi } from "vitest";
import { APPROVED_BRANCH_COLUMN_SPECS } from "../../components/approved-branches-grid-adapter";
import { BRANCHES_TABLE_COLUMN_SPECS } from "../../components/branches-table";
import {
  APPROVED_BRANCH_TOGGLEABLE_COLUMNS,
  BRANCH_TOGGLEABLE_COLUMNS,
} from "../../hooks/use-branch-view-state";
import {
  BRANCH_COLUMN_VIEW_MODEL,
  type BranchColumnViewModelId,
  branchColumnLabel,
} from "../branch-column-view-model";
import { legacyBranchFilterFacetGroups } from "../branch-filter-adapter";
import { DEFAULT_BRANCH_FILTERS } from "../branch-row";
import { branchRow } from "./branch-row-fixture";

// A changed owner must flow through every consumer. Equal copied literals would
// fail this test even when they happen to match today's approved wording.
vi.mock("../branch-column-view-model", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../branch-column-view-model")>();
  return {
    ...actual,
    branchColumnLabel: (id: BranchColumnViewModelId) =>
      `Canonical ${actual.branchColumnLabel(id)}`,
  };
});

/** Headers, view menus, and filters consume the canonical column label owner. */

/**
 * The one toggleable id the view model does not own, named rather than skipped.
 *
 * A test that silently passed over unknown ids would let the next added column
 * drift exactly as `sessions` did. This set is asserted to be EXACTLY the
 * outside ids below, so adding a column to a menu without adding it to the view
 * model fails here instead of opting itself out of the SSOT.
 */
const IDS_OUTSIDE_VIEW_MODEL: readonly string[] = ["checks"];

const VIEW_MODEL_IDS = new Set<string>(
  BRANCH_COLUMN_VIEW_MODEL.map((column) => column.id)
);

function isViewModelId(id: string): id is BranchColumnViewModelId {
  return VIEW_MODEL_IDS.has(id);
}

function labelSitesOf(
  specs: readonly { id: string; label: unknown }[]
): { id: string; label: string }[] {
  return specs.map((spec) => ({ id: spec.id, label: String(spec.label) }));
}

const LABEL_DECLARATIONS: readonly {
  name: string;
  sites: { id: string; label: string }[];
}[] = [
  {
    name: "BRANCH_TOGGLEABLE_COLUMNS (legacy View menu)",
    sites: labelSitesOf(BRANCH_TOGGLEABLE_COLUMNS),
  },
  {
    name: "APPROVED_BRANCH_TOGGLEABLE_COLUMNS (approved View menu)",
    sites: labelSitesOf(APPROVED_BRANCH_TOGGLEABLE_COLUMNS),
  },
  {
    name: "BRANCHES_TABLE_COLUMN_SPECS (legacy table headers)",
    sites: labelSitesOf(BRANCHES_TABLE_COLUMN_SPECS),
  },
  {
    name: "APPROVED_BRANCH_COLUMN_SPECS (approved table headers)",
    sites: labelSitesOf(APPROVED_BRANCH_COLUMN_SPECS),
  },
];

describe("Branches column label SSOT (ISS-10265)", () => {
  it.each(LABEL_DECLARATIONS)(
    "$name spells every view-model column exactly as branchColumnLabel does",
    ({ sites }) => {
      const checked: string[] = [];
      for (const site of sites) {
        if (!isViewModelId(site.id)) {
          continue;
        }
        checked.push(site.id);
        expect(site.label).toBe(branchColumnLabel(site.id));
      }
      // Without this the loop would pass vacuously if an import ever resolved
      // to an empty array or every id fell outside the view model.
      expect(checked.length).toBeGreaterThan(0);
    }
  );

  it("names every id that opts out of the SSOT, so a new one cannot opt itself out", () => {
    const outside = new Set<string>();
    for (const declaration of LABEL_DECLARATIONS) {
      for (const site of declaration.sites) {
        if (!isViewModelId(site.id)) {
          outside.add(site.id);
        }
      }
    }
    expect([...outside].sort()).toEqual([...IDS_OUTSIDE_VIEW_MODEL].sort());
  });

  it("agrees on one spelling of the Linked sessions column across every declaration", () => {
    // The ISS-10265 defect stated as its own case: the two View menus and the
    // two header declarations, on one screen-visible label, in one assertion.
    const spellings = new Set(
      LABEL_DECLARATIONS.flatMap((declaration) =>
        declaration.sites
          .filter((site) => site.id === "sessions")
          .map((site) => site.label)
      )
    );
    expect([...spellings]).toEqual([branchColumnLabel("sessions")]);
  });

  it("labels the Linked sessions FILTER facet from the same owner as the column", () => {
    // The facet's id is `session`, not the column id `sessions`, so it cannot be
    // held by id the way the declarations above are — but it is the same word on
    // the same screen, and it drifted with them.
    const groups = legacyBranchFilterFacetGroups(
      [branchRow({ branchName: "feature/iss-10265" })],
      DEFAULT_BRANCH_FILTERS,
      () => undefined
    );
    const sessionFacet = groups.find((group) => group.id === "session");
    expect(sessionFacet).toBeDefined();
    expect(sessionFacet?.label).toBe(branchColumnLabel("sessions"));
  });
});
