import {
  AgentComponentSortDir,
  AgentComponentSortKey,
} from "@repo/api/src/types/agent-component";
import { describe, expect, it } from "vitest";
import {
  AGENTS_SAVED_VIEW_UNVERSIONED,
  AGENTS_SAVED_VIEW_VERSION,
  LEGACY_AGENTS_DEFAULT_SORT,
  migrateSavedSort,
  USAGE_AGENTS_DEFAULT_SORT,
} from "../agents-saved-view-migration";

/**
 * ISS-5005: the one-time promotion of a persisted Agents view still carrying the
 * untouched alphabetical default onto the usage-bearing one — as a pure function,
 * with no React, storage, or DOM in the way.
 *
 * The two properties that keep this narrow are asserted directly: it rewrites
 * ONLY the exact legacy pair (anything else is a choice the user made), and it
 * runs at most ONCE per stored view (guarded on the version, so reversing it by
 * hand sticks).
 */

describe("migrateSavedSort (ISS-5005)", () => {
  it("promotes the untouched legacy default to the usage default and stamps it", () => {
    const result = migrateSavedSort(
      { ...LEGACY_AGENTS_DEFAULT_SORT },
      AGENTS_SAVED_VIEW_UNVERSIONED
    );

    expect(result.sort).toEqual(USAGE_AGENTS_DEFAULT_SORT);
    expect(result.version).toBe(AGENTS_SAVED_VIEW_VERSION);
  });

  it("targets a usage-bearing column, not the sparsely-populated LOC/$ metric", () => {
    // The finding was a first screen that answered nothing: sorting by a column
    // measured on ~1% of rows would have replaced one empty landing view with
    // another. Invocations is populated for every component kind.
    expect(USAGE_AGENTS_DEFAULT_SORT.sortKey).toBe(
      AgentComponentSortKey.Invocations
    );
    expect(USAGE_AGENTS_DEFAULT_SORT.sortDir).toBe(AgentComponentSortDir.Desc);
    expect(USAGE_AGENTS_DEFAULT_SORT.sortKey).not.toBe(
      AgentComponentSortKey.Metric
    );
  });

  // Every one of these is a sort the user actively selected. Rewriting any of
  // them would be the migration overreaching past the default it exists to fix.
  it.each([
    [
      "Component descending (same column, opposite direction)",
      {
        sortDir: AgentComponentSortDir.Desc,
        sortKey: AgentComponentSortKey.Name,
      },
    ],
    [
      "Sessions descending",
      {
        sortDir: AgentComponentSortDir.Desc,
        sortKey: AgentComponentSortKey.Sessions,
      },
    ],
    [
      "Type ascending",
      {
        sortDir: AgentComponentSortDir.Asc,
        sortKey: AgentComponentSortKey.Type,
      },
    ],
    [
      "Invocations ASCENDING (least-used first — a deliberate inversion)",
      {
        sortDir: AgentComponentSortDir.Asc,
        sortKey: AgentComponentSortKey.Invocations,
      },
    ],
  ])("leaves a user-chosen sort alone: %s", (_label, sort) => {
    const result = migrateSavedSort(sort, AGENTS_SAVED_VIEW_UNVERSIONED);

    expect(result.sort).toEqual(sort);
    // Still stamped: there is nothing to repair, and stamping means the next
    // load skips the check instead of re-deriving the same no-op.
    expect(result.version).toBe(AGENTS_SAVED_VIEW_VERSION);
  });

  it("does not fight a user who sorted back to Component ascending after migrating", () => {
    const result = migrateSavedSort(
      { ...LEGACY_AGENTS_DEFAULT_SORT },
      AGENTS_SAVED_VIEW_VERSION
    );

    expect(result.sort).toEqual(LEGACY_AGENTS_DEFAULT_SORT);
    expect(result.version).toBe(AGENTS_SAVED_VIEW_VERSION);
  });

  it("preserves a version from a NEWER build rather than rolling it back", () => {
    const futureVersion = AGENTS_SAVED_VIEW_VERSION + 5;

    const result = migrateSavedSort(
      { ...LEGACY_AGENTS_DEFAULT_SORT },
      futureVersion
    );

    expect(result.sort).toEqual(LEGACY_AGENTS_DEFAULT_SORT);
    expect(result.version).toBe(futureVersion);
  });

  it("keeps the legacy pair equal to what the catalog defaulted to before ISS-5005", () => {
    // Pins the flag-OFF contract: the dark path must land on exactly the sort
    // that shipped, or the closed-by-default guarantee is void.
    expect(LEGACY_AGENTS_DEFAULT_SORT).toEqual({
      sortDir: AgentComponentSortDir.Asc,
      sortKey: AgentComponentSortKey.Name,
    });
  });
});
