import { BranchSessionPresence } from "@repo/api/src/types/branch";
import { describe, expect, it } from "vitest";
import {
  normalizeBranchFiltersForMode,
  parseBranchFilterParams,
  writeBranchFilterParams,
} from "../branch-filter-params";
import {
  type BranchFilters,
  DEFAULT_BRANCH_FILTERS,
  RENDER_MISSING,
  RENDER_UNATTRIBUTED,
} from "../branch-row";

/**
 * FEA-3560 / FEA-4003: the Branches list URL mirrors the active facet selections
 * (incl. linked-session presence and the LOC-change range) so a detail→back (or
 * reload / shared link) restores the filtered view. The generic codec is covered
 * in shared/lib/__tests__/facet-filter-params.test.ts; these pin the Branches
 * param mapping itself.
 */
describe("branch facet filter URL params", () => {
  it("round-trips every facet — incl. session presence + LOC range — through the URL", () => {
    const filters: BranchFilters = {
      ...DEFAULT_BRANCH_FILTERS,
      statuses: ["open", "merged"],
      owners: ["Alex"],
      repos: ["acme/web"],
      sessionPresence: [BranchSessionPresence.Has],
      locMin: 10,
      locMax: 500,
    };
    const params = new URLSearchParams("github=connected");

    writeBranchFilterParams(params, filters);
    const reparsed = parseBranchFilterParams(
      new URLSearchParams(params.toString())
    );

    expect(reparsed).toEqual(filters);
    // The GitHub connect-return param is owned by the page and passes through.
    expect(params.get("github")).toBe("connected");
  });

  it("returns the shared default object when no filter param is present", () => {
    const reparsed = parseBranchFilterParams(new URLSearchParams("github=x"));
    expect(reparsed).toBe(DEFAULT_BRANCH_FILTERS);
  });

  it("clamps an inverted LOC range read from the URL (min ≤ max)", () => {
    const reparsed = parseBranchFilterParams(
      new URLSearchParams("locMin=900&locMax=100")
    );
    expect(reparsed.locMin).toBe(100);
    expect(reparsed.locMax).toBe(100);
  });

  it("floors a negative LOC min read from the URL at 0", () => {
    const reparsed = parseBranchFilterParams(
      new URLSearchParams("locMin=-5&locMax=50")
    );
    expect(reparsed.locMin).toBe(0);
    expect(reparsed.locMax).toBe(50);
  });

  it("drops a stale/unknown sessionPresence value at the URL boundary", () => {
    // A hand-edited or stale `?sessionPresence=maybe` must not become an active
    // selection no row can satisfy (which would blank the table + cards); it is
    // filtered out, degrading to "all rows".
    const reparsed = parseBranchFilterParams(
      new URLSearchParams("sessionPresence=maybe")
    );
    expect(reparsed.sessionPresence).toEqual([]);
    // Degrades to the default (empty) filter set — no active facet survives.
    expect(reparsed).toEqual(DEFAULT_BRANCH_FILTERS);
  });

  it("keeps a real sessionPresence value while dropping an unknown sibling", () => {
    const reparsed = parseBranchFilterParams(
      new URLSearchParams("sessionPresence=has&sessionPresence=bogus")
    );
    expect(reparsed.sessionPresence).toEqual([BranchSessionPresence.Has]);
  });

  it("leaves the LOC bound UNSET for a blank URL value (no max-0 filter)", () => {
    // `?locMax=` (empty) must not activate a spurious max-0 filter.
    const reparsed = parseBranchFilterParams(
      new URLSearchParams("locMin=&locMax=")
    );
    expect(reparsed.locMin).toBeUndefined();
    expect(reparsed.locMax).toBeUndefined();
    expect(reparsed).toBe(DEFAULT_BRANCH_FILTERS);
  });

  it("writes only the active facets, leaving a clean URL for defaults", () => {
    const params = new URLSearchParams();
    writeBranchFilterParams(params, {
      ...DEFAULT_BRANCH_FILTERS,
      locMin: 25,
    });
    expect(params.get("locMin")).toBe("25");
    expect(params.has("locMax")).toBe(false);
    expect(params.has("sessionPresence")).toBe(false);
    expect(params.has("status")).toBe(false);
  });

  it("preserves approved compatibility identities while clearing legacy-only facets", () => {
    const mixed: BranchFilters = {
      ...DEFAULT_BRANCH_FILTERS,
      names: ["feature/ui"],
      owners: ["Alex", "github:alex"],
      collaborators: ["github:kris"],
      repos: ["web", "acme/web", RENDER_MISSING],
      pullRequests: ["linked"],
      sessionPresence: [BranchSessionPresence.Has],
    };

    expect(normalizeBranchFiltersForMode(mixed, true)).toMatchObject({
      owners: ["Alex", "github:alex"],
      repos: ["web", "acme/web", RENDER_MISSING],
      sessionPresence: [],
    });
    expect(normalizeBranchFiltersForMode(mixed, false)).toMatchObject({
      names: [],
      owners: ["Alex"],
      collaborators: [],
      repos: ["web", RENDER_MISSING],
      pullRequests: [],
      sessionPresence: [BranchSessionPresence.Has],
    });
  });

  it("preserves the approved Unattributed owner identity from URL or saved state", () => {
    const parsed = parseBranchFilterParams(
      new URLSearchParams(`owner=${RENDER_UNATTRIBUTED}`)
    );

    expect(normalizeBranchFiltersForMode(parsed, true).owners).toEqual([
      RENDER_UNATTRIBUTED,
    ]);
  });
});
