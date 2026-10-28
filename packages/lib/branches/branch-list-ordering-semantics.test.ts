import {
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBranchServerPage, compareFacetOptions } from "./branch-list-page";
import {
  branchRow,
  branchServerPageQuery,
} from "./branch-list-page.test-fixtures";

/**
 * ISS-9585 — the kernel half of the ordering ruling, driven through the real
 * page builder that the desktop main process and the cloud both execute.
 *
 * Every expected sequence is written out. Deriving one from the comparator
 * under test would agree with that comparator however it is retuned.
 */
const NOW = "2026-09-26T00:00:00.000Z";

/**
 * Four names whose collated order is their primary letters — a, a, b, z — and
 * whose UTF-16 order is nothing like it, because every uppercase letter sorts
 * ahead of every lowercase one and "ä" (0xe4) sorts after all of them. A
 * same-case ASCII fixture agrees under both classes and could not fail.
 */
const NAMES = ["Zeta", "alpha", "ärger", "Beta"] as const;

/**
 * A zone-less bound is 00:00Z anchored absolutely and 05:00Z anchored to
 * Chicago, so a row at 02:00Z is inside the window under one reading and
 * outside under the other.
 */
const ZONELESS_START = "2026-09-25T00:00:00";
const BETWEEN_THE_TWO_READINGS = "2026-09-25T02:00:00.000Z";

function namedRows() {
  return NAMES.map((name) => branchRow({ id: name, branchName: name }));
}

describe("Branch list kernel text ordering (ISS-9585)", () => {
  it("sorts names by collation rather than by code unit", () => {
    const page = buildBranchServerPage(
      namedRows(),
      branchServerPageQuery({
        sortKey: BranchListSortKey.Name,
        sortDir: BranchListSortDirection.Asc,
      }),
      NOW
    );

    expect(page.items.map((row) => row.branchName)).toEqual([
      "alpha",
      "ärger",
      "Beta",
      "Zeta",
    ]);
  });

  it("still reverses that order when the direction is descending", () => {
    const page = buildBranchServerPage(
      namedRows(),
      branchServerPageQuery({
        sortKey: BranchListSortKey.Name,
        sortDir: BranchListSortDirection.Desc,
      }),
      NOW
    );

    expect(page.items.map((row) => row.branchName)).toEqual([
      "Zeta",
      "Beta",
      "ärger",
      "alpha",
    ]);
  });

  it("collates facet options the same way it collates the rows", () => {
    const page = buildBranchServerPage(
      NAMES.map((name) => branchRow({ id: name, owner: name })),
      branchServerPageQuery(),
      NOW
    );

    expect(page.facets.owners.options.map((option) => option.label)).toEqual([
      "alpha",
      "ärger",
      "Beta",
      "Zeta",
    ]);
  });
});

/**
 * Two options carrying the SAME label, whose ids differ only by case. The label
 * comparison cannot separate them, so the tie-break is the only thing that
 * orders this pair — and the two classes order it OPPOSITE ways, because the
 * root collation ranks lowercase first and code units rank uppercase first.
 */
const SHARED_LABEL = "web";
const COLLIDING_IDS = ["closedloop/Web", "closedloop/web"] as const;

describe("Branch list facet option ordering (ISS-9585)", () => {
  it("breaks a shared-label tie by code unit, not by collation", () => {
    const options = [...COLLIDING_IDS]
      .map((id) => ({ id, label: SHARED_LABEL, count: 0 }))
      .sort(compareFacetOptions);

    // Written out rather than derived. The collated class puts "closedloop/web"
    // first, so this sequence is the one it cannot produce.
    expect(options.map((option) => option.id)).toEqual([
      "closedloop/Web",
      "closedloop/web",
    ]);
  });

  it("still collates the label, which is the prose a reader alphabetizes", () => {
    const options = ["Zeta", "alpha", "ärger", "Beta"]
      .map((label) => ({ id: label, label, count: 0 }))
      .sort(compareFacetOptions);

    expect(options.map((option) => option.label)).toEqual([
      "alpha",
      "ärger",
      "Beta",
      "Zeta",
    ]);
  });
});

/**
 * The zone moves with `vi.stubEnv` rather than `process.env` because this
 * package sets `"types": []` — a `process` reference in anything it compiles,
 * test files included, fails typecheck, and that is the guard keeping
 * `@repo/lib` browser-safe.
 */
describe("Branch list kernel window anchoring (ISS-9585)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("selects the same population for a zone-less bound on every host", () => {
    const rows = [
      branchRow({ id: "between", lastActivityAt: BETWEEN_THE_TWO_READINGS }),
    ];
    const query = branchServerPageQuery({ startDate: ZONELESS_START });

    const unanchored: number[] = [];
    const totals = ["UTC", "America/Chicago", "Asia/Tokyo"].map((zone) => {
      vi.stubEnv("TZ", zone);
      unanchored.push(Date.parse(ZONELESS_START));
      return buildBranchServerPage(rows, query, NOW).total;
    });

    // The premise, asserted rather than assumed: the stub really moves the
    // clock `Date` reads, so an unanchored bound WOULD name three instants
    // here. Without this the agreement below also holds on a runner where the
    // zone never moved, which is the one way this case could pass vacuously.
    expect(new Set(unanchored).size).toBe(3);
    // Anchored absolutely the row is inside the window, so the agreement below
    // is the helper's doing and not an empty window agreeing with itself.
    expect(totals).toEqual([1, 1, 1]);
  });

  it("still excludes a row that falls before the anchored bound", () => {
    vi.stubEnv("TZ", "Asia/Tokyo");
    const page = buildBranchServerPage(
      [
        branchRow({
          id: "before",
          lastActivityAt: "2026-09-24T23:00:00.000Z",
        }),
      ],
      branchServerPageQuery({ startDate: ZONELESS_START }),
      NOW
    );

    expect(page.total).toBe(0);
  });
});
