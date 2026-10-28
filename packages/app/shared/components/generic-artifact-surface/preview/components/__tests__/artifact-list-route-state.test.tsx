// @vitest-environment jsdom

import {
  ARTIFACT_STATUS_DETAIL,
  ARTIFACT_STATUS_ROOT,
} from "@repo/api/src/types/artifact-status";
import {
  TABLE_COLLAPSED_GROUP_PARAM,
  type TableCollapsedGroups,
  tableGroupingAxisKey,
} from "@repo/app/shared/lib/table-collapsed-groups";
import { TableGroupOrder } from "@repo/design-system/components/ui/table-toolbar-model";
import { buildSubgroupKey } from "@repo/design-system/lib/grid-table-v2-rows";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GenericArtifactStatus,
  genericArtifactStatusRouteKey,
} from "../../../generic-artifact-status";
import { ArtifactKind } from "../../fixtures";
import type { ArtifactDateDimension } from "../artifact-date-dimension";
import type { ArtifactFilters } from "../artifact-list-model";
import {
  artifactRouteGrouping,
  useArtifactListRouteState,
} from "../artifact-list-route-state";

const NO_DATE_DIMENSION: ArtifactDateDimension = { present: false };

function presentDateDimension(
  range: string,
  setRange = vi.fn()
): ArtifactDateDimension {
  return { present: true, range, setRange };
}

const emptyFilters: ArtifactFilters = {
  favoritesOnly: false,
  kinds: [],
  mineOnly: false,
  owners: [],
  statuses: [],
  tags: [],
  updatedPreset: null,
};

function renderRouteState(search: string) {
  window.history.replaceState({}, "", `/p/generic-artifact${search}`);
  const setFilters = vi.fn();
  const setCustomFieldFilters = vi.fn();
  const setExtensionFilters = vi.fn();
  renderHook(() =>
    useArtifactListRouteState({
      activeSavedViewId: "default",
      collapsedGroups: {},
      setCollapsedGroups: vi.fn(),
      customFieldFilters: {},
      dateDimension: presentDateDimension("30d"),
      extensionFilters: {},
      filters: emptyFilters,
      groupBy: "none",
      groupOrder: "custom",
      layout: "list",
      secondaryGroupBy: "none",
      secondaryGroupOrder: "asc",
      setActiveSavedViewId: vi.fn(),
      setCustomFieldFilters,
      setExtensionFilters,
      setFilters,
      setGroupBy: vi.fn(),
      setGroupOrder: vi.fn(),
      setLayout: vi.fn(),
      setSecondaryGroupBy: vi.fn(),
      setSecondaryGroupOrder: vi.fn(),
      setShowEmptyGroups: vi.fn(),
      setShowEmptySubgroups: vi.fn(),
      setSortActive: vi.fn(),
      setSortBy: vi.fn(),
      setSortDir: vi.fn(),
      setVisibleColumnIds: vi.fn(),
      setVisibleMetricKeys: vi.fn(),
      showEmptyGroups: true,
      showEmptySubgroups: true,
      sortActive: false,
      sortBy: "name",
      sortDir: "asc",
      visibleColumnIds: new Set<string>(),
      visibleMetricKeys: new Set<string>(),
    })
  );
  return {
    customFieldFilters: setCustomFieldFilters.mock.calls.at(0)?.at(0),
    extensionFilters: setExtensionFilters.mock.calls.at(0)?.at(0),
    filters: setFilters.mock.calls.at(0)?.at(0) as ArtifactFilters | undefined,
  };
}

beforeEach(() => {
  window.history.replaceState({}, "", "/p/generic-artifact");
});

describe("useArtifactListRouteState status restoration", () => {
  it("drops a retired status a saved URL still carries", () => {
    const restored = renderRouteState("?statuses=Needs%20you");

    // Not merely "the row count changed": an unrecognized status left in place
    // filters every row out, so the list reads as genuinely empty.
    expect(restored.filters?.statuses).toEqual([]);
  });

  it("keeps the live statuses beside a retired one", () => {
    const restored = renderRouteState("?statuses=Needs%20you,in_review");

    expect(restored.filters?.statuses).toEqual([ARTIFACT_STATUS_ROOT.InReview]);
  });

  it("restores a live status untouched", () => {
    const restored = renderRouteState("?statuses=in_review,issue.triage");

    expect(restored.filters?.statuses).toEqual([
      ARTIFACT_STATUS_ROOT.InReview,
      ARTIFACT_STATUS_DETAIL.IssueTriage,
    ]);
  });

  it("restores old fixture-word status bookmarks as exact legacy keys", () => {
    const restored = renderRouteState("?statuses=Active,In%20review");

    expect(restored.filters?.statuses).toEqual([
      genericArtifactStatusRouteKey(GenericArtifactStatus.Active),
      genericArtifactStatusRouteKey(GenericArtifactStatus.InReview),
    ]);
  });

  it("applies the same guard to kinds", () => {
    const restored = renderRouteState("?kinds=Epic,Issue");

    expect(restored.filters?.kinds).toEqual([ArtifactKind.Issue]);
  });

  it.each([
    ["null"],
    ["[]"],
    ["42"],
    ['{"broken":{"selectedValues":"not-an-array"}}'],
    ['{"broken":{"min":"not-a-number"}}'],
  ])("drops malformed custom and extension filter records: %s", (value) => {
    const encoded = encodeURIComponent(value);
    const restored = renderRouteState(
      `?customFieldFilters=${encoded}&extensionFilters=${encoded}`
    );

    expect(restored.customFieldFilters).toEqual({});
    expect(restored.extensionFilters).toEqual({});
  });

  it("keeps valid members while dropping malformed siblings", () => {
    const value = encodeURIComponent(
      JSON.stringify({
        invalid: { selectedValues: "nope" },
        valid: { max: 9, min: 1, selectedValues: ["ready"] },
      })
    );
    const restored = renderRouteState(`?customFieldFilters=${value}`);

    expect(restored.customFieldFilters).toEqual({
      valid: { max: 9, min: 1, selectedValues: ["ready"] },
    });
  });
});

/**
 * An ABSENT `group` param means "no saved selection", not "ungrouped". A
 * surface with a configured default (Project Detail requires Status) has to
 * keep it through hydration; only an explicit `group=none` ungroups.
 */
function renderGroupRouteState(
  search: string,
  defaultGroupBy?: string,
  groupByOverride?: string
) {
  window.history.replaceState({}, "", `/p/generic-artifact${search}`);
  const setGroupBy = vi.fn();
  renderHook(() =>
    useArtifactListRouteState({
      activeSavedViewId: "default",
      collapsedGroups: {},
      setCollapsedGroups: vi.fn(),
      customFieldFilters: {},
      dateDimension: presentDateDimension("30d"),
      defaultGroupBy,
      extensionFilters: {},
      filters: emptyFilters,
      groupBy: groupByOverride ?? defaultGroupBy ?? "none",
      groupOrder: "custom",
      layout: "list",
      secondaryGroupBy: "none",
      secondaryGroupOrder: "asc",
      setActiveSavedViewId: vi.fn(),
      setCustomFieldFilters: vi.fn(),
      setExtensionFilters: vi.fn(),
      setFilters: vi.fn(),
      setGroupBy,
      setGroupOrder: vi.fn(),
      setLayout: vi.fn(),
      setSecondaryGroupBy: vi.fn(),
      setSecondaryGroupOrder: vi.fn(),
      setShowEmptyGroups: vi.fn(),
      setShowEmptySubgroups: vi.fn(),
      setSortActive: vi.fn(),
      setSortBy: vi.fn(),
      setSortDir: vi.fn(),
      setVisibleColumnIds: vi.fn(),
      setVisibleMetricKeys: vi.fn(),
      showEmptyGroups: true,
      showEmptySubgroups: true,
      sortActive: false,
      sortBy: "name",
      sortDir: "asc",
      visibleColumnIds: new Set<string>(),
      visibleMetricKeys: new Set<string>(),
    })
  );
  return setGroupBy.mock.calls.at(0)?.at(0) as string | undefined;
}

describe("useArtifactListRouteState grouping default", () => {
  it("keeps the configured default when the URL carries no group", () => {
    expect(renderGroupRouteState("", "status")).toBe("status");
  });

  it("ungroups only when the URL says so explicitly", () => {
    expect(renderGroupRouteState("?group=none", "status")).toBe("none");
  });

  it("still honours an explicit group that is not the default", () => {
    expect(renderGroupRouteState("?group=owner", "status")).toBe("owner");
  });

  it("falls back to ungrouped for a surface with no configured default", () => {
    expect(renderGroupRouteState("")).toBe("none");
  });

  it("serializes an explicit ungroup away from a non-none default", () => {
    // The user's own choice: the surface defaults to Status and they ungrouped.
    renderGroupRouteState("?group=none", "status", "none");
    expect(new URL(window.location.href).searchParams.get("group")).toBe(
      "none"
    );
  });
});

/**
 * ISS-10479. Every negative here is paired with its positive on the SAME
 * mechanism: a surface that HAS a date dimension must still read and write
 * `range` exactly as before, or "the param is absent" would be satisfied by a
 * hook that never ran.
 */
function renderDateRouteState(
  search: string,
  dateDimension: ArtifactDateDimension
) {
  window.history.replaceState({}, "", `/p/generic-artifact${search}`);
  renderHook(() =>
    useArtifactListRouteState({
      activeSavedViewId: "default",
      collapsedGroups: {},
      setCollapsedGroups: vi.fn(),
      customFieldFilters: {},
      dateDimension,
      extensionFilters: {},
      filters: emptyFilters,
      groupBy: "none",
      groupOrder: "custom",
      layout: "list",
      secondaryGroupBy: "none",
      secondaryGroupOrder: "asc",
      setActiveSavedViewId: vi.fn(),
      setCustomFieldFilters: vi.fn(),
      setExtensionFilters: vi.fn(),
      setFilters: vi.fn(),
      setGroupBy: vi.fn(),
      setGroupOrder: vi.fn(),
      setLayout: vi.fn(),
      setSecondaryGroupBy: vi.fn(),
      setSecondaryGroupOrder: vi.fn(),
      setShowEmptyGroups: vi.fn(),
      setShowEmptySubgroups: vi.fn(),
      setSortActive: vi.fn(),
      setSortBy: vi.fn(),
      setSortDir: vi.fn(),
      setVisibleColumnIds: vi.fn(),
      setVisibleMetricKeys: vi.fn(),
      showEmptyGroups: true,
      showEmptySubgroups: true,
      sortActive: false,
      sortBy: "name",
      sortDir: "asc",
      visibleColumnIds: new Set<string>(),
      visibleMetricKeys: new Set<string>(),
    })
  );
  return new URL(window.location.href).searchParams.get("range");
}

describe("useArtifactListRouteState date dimension", () => {
  it("reads an inbound range on a surface that has the dimension", () => {
    const setRange = vi.fn();

    renderDateRouteState("?range=7d", presentDateDimension("30d", setRange));

    expect(setRange).toHaveBeenCalledWith("7d");
  });

  it("leaves an inbound range untouched on a surface with no dimension", () => {
    // Named for what it observes. The absent shape has no setter to spy on, so
    // the read half cannot be asserted here at all; it is pinned end-to-end by
    // "ignores a range the URL carries when the surface has no dimension" in
    // artifact-date-dimension.test.tsx, which drives the real shell.
    expect(renderDateRouteState("?range=7d", NO_DATE_DIMENSION)).toBe("7d");
  });

  it("serializes a non-default range on a surface that has the dimension", () => {
    expect(renderDateRouteState("", presentDateDimension("7d"))).toBe("7d");
  });

  it("writes no range on a surface with no dimension", () => {
    expect(renderDateRouteState("", NO_DATE_DIMENSION)).toBeNull();
  });
});

/**
 * PRD-720 slice 3: a grouped artifact list carries its collapsed bands in the
 * link, keyed by the axis that cut them, so a refresh or a recipient restores
 * the same closed bands.
 */
function renderCollapseRouteState(
  search: string,
  view: {
    collapsedGroups?: TableCollapsedGroups;
    groupBy?: string;
    secondaryGroupBy?: string;
  } = {}
) {
  window.history.replaceState({}, "", `/p/generic-artifact${search}`);
  const setCollapsedGroups = vi.fn();
  renderHook(() =>
    useArtifactListRouteState({
      activeSavedViewId: "default",
      collapsedGroups: view.collapsedGroups ?? {},
      setCollapsedGroups,
      customFieldFilters: {},
      dateDimension: NO_DATE_DIMENSION,
      extensionFilters: {},
      filters: emptyFilters,
      groupBy: view.groupBy ?? "none",
      groupOrder: "custom",
      layout: "list",
      secondaryGroupBy: view.secondaryGroupBy ?? "none",
      secondaryGroupOrder: "asc",
      setActiveSavedViewId: vi.fn(),
      setCustomFieldFilters: vi.fn(),
      setExtensionFilters: vi.fn(),
      setFilters: vi.fn(),
      setGroupBy: vi.fn(),
      setGroupOrder: vi.fn(),
      setLayout: vi.fn(),
      setSecondaryGroupBy: vi.fn(),
      setSecondaryGroupOrder: vi.fn(),
      setShowEmptyGroups: vi.fn(),
      setShowEmptySubgroups: vi.fn(),
      setSortActive: vi.fn(),
      setSortBy: vi.fn(),
      setSortDir: vi.fn(),
      setVisibleColumnIds: vi.fn(),
      setVisibleMetricKeys: vi.fn(),
      showEmptyGroups: true,
      showEmptySubgroups: true,
      sortActive: false,
      sortBy: "name",
      sortDir: "asc",
      visibleColumnIds: new Set<string>(),
      visibleMetricKeys: new Set<string>(),
    })
  );
  return {
    restored: setCollapsedGroups.mock.calls.at(0)?.at(0),
    url: new URL(window.location.href).searchParams,
  };
}

const STATUS_THEN_OWNER_AXIS =
  tableGroupingAxisKey(
    artifactRouteGrouping("status", "owner", "custom", "asc")
  ) ?? "";
const STATUS_AXIS =
  tableGroupingAxisKey(
    artifactRouteGrouping("status", "none", "custom", "asc")
  ) ?? "";
const DRAFT_ALEX = buildSubgroupKey("Draft", "Alex");

describe("useArtifactListRouteState collapsed bands", () => {
  it("restores a linked nested band under the linked axis", () => {
    const { restored } = renderCollapseRouteState(
      `?group=status&subgroup=owner&${TABLE_COLLAPSED_GROUP_PARAM}=${encodeURIComponent(DRAFT_ALEX)}`
    );

    expect(restored).toEqual({ [STATUS_THEN_OWNER_AXIS]: [DRAFT_ALEX] });
  });

  it("opens every band for an old link that carries no collapse", () => {
    const { restored } = renderCollapseRouteState(
      "?group=status&subgroup=owner"
    );

    expect(restored).toEqual({});
  });

  it("writes the active axis's bands as repeated values beside unrelated params", () => {
    const { url } = renderCollapseRouteState("?ref=shared-link", {
      collapsedGroups: {
        [STATUS_AXIS]: ["In review"],
        [STATUS_THEN_OWNER_AXIS]: [DRAFT_ALEX, buildSubgroupKey("Done", "Sam")],
      },
      groupBy: "status",
      secondaryGroupBy: "owner",
    });

    expect(url.getAll(TABLE_COLLAPSED_GROUP_PARAM)).toEqual([
      DRAFT_ALEX,
      buildSubgroupKey("Done", "Sam"),
    ]);
    expect(url.get("group")).toBe("status");
    expect(url.get("subgroup")).toBe("owner");
    expect(url.get("ref")).toBe("shared-link");
  });

  it("writes no collapse for an axis the list is not grouped by", () => {
    const { url } = renderCollapseRouteState("", {
      collapsedGroups: { [STATUS_THEN_OWNER_AXIS]: [DRAFT_ALEX] },
      groupBy: "status",
    });

    expect(url.has(TABLE_COLLAPSED_GROUP_PARAM)).toBe(false);
  });
});

describe("artifactRouteGrouping", () => {
  it("maps the shell's none sentinel to an ungrouped level", () => {
    expect(artifactRouteGrouping("status", "none", "desc", "asc")).toEqual({
      primary: {
        fieldId: "status",
        order: TableGroupOrder.Descending,
        showEmptyGroups: false,
      },
      secondary: {
        fieldId: null,
        order: TableGroupOrder.Ascending,
        showEmptyGroups: false,
      },
    });
    expect(
      artifactRouteGrouping("none", "none", "custom", "asc").primary.fieldId
    ).toBeNull();
  });
});
