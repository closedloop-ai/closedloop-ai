"use client";

import {
  readTableCollapsedGroupParams,
  TABLE_COLLAPSED_GROUP_PARAM,
  type TableCollapsedGroups,
  writeTableCollapsedGroupParams,
} from "@repo/app/shared/lib/table-collapsed-groups";
import {
  TABLE_GROUP_EMPTY_PARAM,
  TABLE_GROUP_PARAM,
} from "@repo/app/shared/lib/table-group-view-params";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import type { TableGroupingState } from "@repo/design-system/components/ui/table-toolbar-model";
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useRef, useState } from "react";
import { genericArtifactStatusRouteKey } from "../../generic-artifact-status";
import { isArtifactKind } from "../fixtures";
import {
  type ArtifactDateDimension,
  DEFAULT_ARTIFACT_DATE_RANGE,
  isArtifactDateRange,
} from "./artifact-date-dimension";
import type {
  ArtifactFilters,
  ArtifactGroupOrder,
  ArtifactListLayout,
  CustomFieldFilter,
} from "./artifact-list-model";

type RouteStateOptions = {
  routeState?: { search: string; replace: (query: string) => void };
  activeSavedViewId: string;
  collapsedGroups: TableCollapsedGroups;
  customFieldFilters: Record<string, CustomFieldFilter>;
  /**
   * The surface's date dimension. The absent variant carries no range, so
   * `range` is neither read from nor written to the URL on a surface that
   * declares it has none (ISS-10479).
   */
  dateDimension: ArtifactDateDimension;
  /**
   * The surface's configured grouping when the URL says nothing. An absent
   * `group` param means "no saved selection", not "ungrouped" — only an
   * explicit `group=none` means that.
   */
  defaultGroupBy?: string;
  extensionFilters: Record<string, CustomFieldFilter>;
  filters: ArtifactFilters;
  groupBy: string;
  groupOrder: ArtifactGroupOrder;
  secondaryGroupBy: string;
  secondaryGroupOrder: ArtifactGroupOrder;
  showEmptyGroups: boolean;
  showEmptySubgroups: boolean;
  layout: ArtifactListLayout;
  legacyColumnAliases?: Readonly<Record<string, readonly string[]>>;
  legacyMetricAliases?: Readonly<Record<string, readonly string[]>>;
  setActiveSavedViewId: Dispatch<SetStateAction<string>>;
  setCollapsedGroups: Dispatch<SetStateAction<TableCollapsedGroups>>;
  setCustomFieldFilters: Dispatch<
    SetStateAction<Record<string, CustomFieldFilter>>
  >;
  setExtensionFilters: Dispatch<
    SetStateAction<Record<string, CustomFieldFilter>>
  >;
  setFilters: Dispatch<SetStateAction<ArtifactFilters>>;
  setGroupBy: Dispatch<SetStateAction<string>>;
  setGroupOrder: Dispatch<SetStateAction<ArtifactGroupOrder>>;
  setSecondaryGroupBy: Dispatch<SetStateAction<string>>;
  setSecondaryGroupOrder: Dispatch<SetStateAction<ArtifactGroupOrder>>;
  setShowEmptyGroups: Dispatch<SetStateAction<boolean>>;
  setShowEmptySubgroups: Dispatch<SetStateAction<boolean>>;
  setLayout: Dispatch<SetStateAction<ArtifactListLayout>>;
  setSortActive: Dispatch<SetStateAction<boolean>>;
  setSortBy: Dispatch<SetStateAction<string>>;
  setSortDir: Dispatch<SetStateAction<SortDirection>>;
  setVisibleColumnIds: Dispatch<SetStateAction<Set<string>>>;
  setVisibleMetricKeys: Dispatch<SetStateAction<Set<string>>>;
  sortActive: boolean;
  sortBy: string;
  sortDir: SortDirection;
  visibleColumnIds: Set<string>;
  visibleMetricKeys: Set<string>;
};

const parseList = (params: URLSearchParams, key: string) =>
  (params.get(key) ?? "").split(",").filter(Boolean);

const expandAliases = (
  values: readonly string[],
  aliases?: Readonly<Record<string, readonly string[]>>
) => values.flatMap((value) => aliases?.[value] ?? [value]);

const FILTER_KEYS = new Set(["selectedValues", "min", "max"]);

const parseFilterRecord = (
  params: URLSearchParams,
  key: string
): Record<string, CustomFieldFilter> => {
  try {
    const parsed: unknown = JSON.parse(params.get(key) ?? "{}");
    if (!isPlainRecord(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, CustomFieldFilter] =>
          isCustomFieldFilter(entry[1])
      )
    );
  } catch {
    return {};
  }
};

export function useArtifactListRouteState(options: RouteStateOptions) {
  const [restored, setRestored] = useState(false);
  const sourceSearch = options.routeState?.search;
  const [appliedSearch, setAppliedSearch] = useState<string | undefined>(
    undefined
  );
  const lastWrittenSearch = useRef<string | undefined>(undefined);
  const appliedOwnedParams = useRef<string | undefined>(undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: React state setters are stable and URL restoration intentionally runs once on mount.
  useEffect(() => {
    const params = new URLSearchParams(
      sourceSearch ?? globalThis.window.location.search
    );
    const ownedParams = ownedRouteParams(params);
    if (
      sourceSearch !== undefined &&
      (lastWrittenSearch.current === sourceSearch ||
        appliedOwnedParams.current === ownedParams)
    ) {
      // Either this list's own write coming back, or a URL that only another
      // writer changed (the hierarchy expansion). Re-deriving state from the
      // latter would undo a local change the list has not written yet.
      appliedOwnedParams.current = ownedParams;
      setAppliedSearch(sourceSearch);
      return;
    }
    appliedOwnedParams.current = ownedParams;
    restoreDateDimension(params, options.dateDimension);
    const sortBy = params.get("sort");
    if (sortBy) {
      options.setSortActive(true);
      options.setSortBy(sortBy);
      options.setSortDir(params.get("direction") === "desc" ? "desc" : "asc");
    }
    restoreArtifactGrouping(params, options);
    options.setLayout(params.get("layout") === "board" ? "board" : "list");
    options.setActiveSavedViewId(params.get("view") ?? "default");
    options.setFilters({
      favoritesOnly: params.get("favorites") === "true",
      kinds: parseList(params, "kinds").filter(isArtifactKind),
      mineOnly: params.get("mine") === "true",
      owners: parseList(params, "owners"),
      statuses: parseList(params, "statuses")
        .map(genericArtifactStatusRouteKey)
        .filter((key): key is string => key !== null),
      tags: parseList(params, "tags"),
      updatedPreset:
        (params.get("updated") as ArtifactFilters["updatedPreset"]) ?? null,
    });
    const columns = expandAliases(
      parseList(params, "columns"),
      options.legacyColumnAliases
    );
    if (columns.length > 0) {
      options.setVisibleColumnIds(new Set(columns));
    }
    const metrics = expandAliases(
      parseList(params, "metrics"),
      options.legacyMetricAliases
    );
    if (metrics.length > 0) {
      options.setVisibleMetricKeys(new Set(metrics));
    }
    options.setCustomFieldFilters(
      parseFilterRecord(params, "customFieldFilters")
    );
    options.setExtensionFilters(parseFilterRecord(params, "extensionFilters"));
    setAppliedSearch(sourceSearch);
    setRestored(true);
  }, [sourceSearch]);

  useEffect(() => {
    if (!restored || appliedSearch !== sourceSearch) {
      return;
    }
    const url = new URL(globalThis.window.location.href);
    if (sourceSearch !== undefined) {
      url.search = sourceSearch;
    }
    const setList = (key: string, values: readonly string[]) => {
      if (values.length > 0) {
        url.searchParams.set(key, values.join(","));
      } else {
        url.searchParams.delete(key);
      }
    };
    const setBoolean = (key: string, value: boolean) => {
      if (value) {
        url.searchParams.set(key, "true");
      } else {
        url.searchParams.delete(key);
      }
    };
    const setDefaulted = (key: string, value: string, fallback: string) => {
      if (value === fallback) {
        url.searchParams.delete(key);
      } else {
        url.searchParams.set(key, value);
      }
    };
    const setRecord = (key: string, value: Record<string, unknown>) => {
      if (Object.keys(value).length > 0) {
        url.searchParams.set(key, JSON.stringify(value));
      } else {
        url.searchParams.delete(key);
      }
    };
    // A surface with no date dimension leaves the key entirely alone: it is
    // not this shell's param to own, and deleting it would be a write the
    // route contract says must not happen.
    if (options.dateDimension.present) {
      setDefaulted(
        "range",
        options.dateDimension.range,
        DEFAULT_ARTIFACT_DATE_RANGE
      );
    }
    if (options.sortActive) {
      url.searchParams.set("sort", options.sortBy);
      url.searchParams.set("direction", options.sortDir);
    } else {
      url.searchParams.delete("sort");
      url.searchParams.delete("direction");
    }
    // Omit the param only at the surface's OWN default; a project route whose
    // default is "status" must still serialize `group=none` when the user
    // deliberately ungroups, or the next hydration silently re-groups them.
    setDefaulted("group", options.groupBy, options.defaultGroupBy ?? "none");
    setDefaulted("groupOrder", options.groupOrder, "custom");
    setDefaulted("subgroup", options.secondaryGroupBy, "none");
    setDefaulted("subgroupOrder", options.secondaryGroupOrder, "asc");
    writeTableCollapsedGroupParams(
      url.searchParams,
      artifactRouteGrouping(
        options.groupBy,
        options.secondaryGroupBy,
        options.groupOrder,
        options.secondaryGroupOrder
      ),
      options.collapsedGroups
    );
    if (options.showEmptyGroups) {
      url.searchParams.delete("emptyGroups");
    } else {
      url.searchParams.set("emptyGroups", "false");
    }
    if (options.showEmptySubgroups) {
      url.searchParams.delete("emptySubgroups");
    } else {
      url.searchParams.set("emptySubgroups", "false");
    }
    setDefaulted("layout", options.layout, "list");
    setDefaulted("view", options.activeSavedViewId, "default");
    setBoolean("mine", options.filters.mineOnly);
    setBoolean("favorites", options.filters.favoritesOnly);
    setList("owners", options.filters.owners);
    setList("statuses", options.filters.statuses);
    setList("kinds", options.filters.kinds);
    setList("tags", options.filters.tags);
    setDefaulted("updated", options.filters.updatedPreset ?? "", "");
    setList("columns", [...options.visibleColumnIds]);
    setList("metrics", [...options.visibleMetricKeys]);
    setRecord("customFieldFilters", options.customFieldFilters);
    setRecord("extensionFilters", options.extensionFilters);
    commitArtifactRoute(
      url,
      { routeState: options.routeState, dateDimension: options.dateDimension },
      { appliedOwnedParams, lastWrittenSearch },
      sourceSearch
    );
  }, [
    appliedSearch,
    sourceSearch,
    options.routeState,
    options.activeSavedViewId,
    options.collapsedGroups,
    options.customFieldFilters,
    options.dateDimension,
    options.defaultGroupBy,
    options.extensionFilters,
    options.filters,
    options.groupBy,
    options.groupOrder,
    options.secondaryGroupBy,
    options.secondaryGroupOrder,
    options.showEmptyGroups,
    options.showEmptySubgroups,
    options.layout,
    options.sortActive,
    options.sortBy,
    options.sortDir,
    options.visibleColumnIds,
    options.visibleMetricKeys,
    restored,
  ]);
}

/**
 * Every param this route state reads and writes. A URL that differs from the
 * last applied one only outside these keys carries no list state to restore.
 */
const OWNED_ROUTE_PARAM_KEYS = [
  "columns",
  "customFieldFilters",
  "direction",
  "emptyGroups",
  "emptySubgroups",
  "extensionFilters",
  "favorites",
  "groupOrder",
  "kinds",
  "layout",
  "metrics",
  "mine",
  "owners",
  "range",
  "sort",
  "statuses",
  "subgroup",
  "subgroupOrder",
  "tags",
  "updated",
  "view",
  TABLE_COLLAPSED_GROUP_PARAM,
  TABLE_GROUP_EMPTY_PARAM,
  TABLE_GROUP_PARAM,
] as const;

function ownedRouteParams(params: URLSearchParams): string {
  return OWNED_ROUTE_PARAM_KEYS.map(
    (key) => `${key}=${params.getAll(key).join(",")}`
  ).join("&");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCustomFieldFilter(value: unknown): value is CustomFieldFilter {
  if (!isPlainRecord(value)) {
    return false;
  }
  if (Object.keys(value).some((key) => !FILTER_KEYS.has(key))) {
    return false;
  }
  const selectedValues = value.selectedValues;
  if (
    selectedValues !== undefined &&
    !(
      Array.isArray(selectedValues) &&
      selectedValues.every((item) => typeof item === "string")
    )
  ) {
    return false;
  }
  return isOptionalFiniteNumber(value.min) && isOptionalFiniteNumber(value.max);
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return (
    value === undefined || (typeof value === "number" && Number.isFinite(value))
  );
}

function parseGroupOrder(
  value: string | null,
  fallback: ArtifactGroupOrder
): ArtifactGroupOrder {
  return value === "asc" || value === "desc" || value === "custom"
    ? value
    : fallback;
}

/** Adapt the shell's existing route fields to the shared grouping contract. */
export function artifactRouteGrouping(
  primary: string,
  secondary: string,
  primaryOrder: ArtifactGroupOrder,
  secondaryOrder: ArtifactGroupOrder
): TableGroupingState {
  return {
    primary: {
      fieldId: primary === "none" ? null : primary,
      order: primaryOrder,
      showEmptyGroups: false,
    },
    secondary: {
      fieldId: secondary === "none" ? null : secondary,
      order: secondaryOrder,
      showEmptyGroups: false,
    },
  };
}

/** Restore grouping and collapse atomically before URL serialization is enabled. */
function restoreArtifactGrouping(
  params: URLSearchParams,
  options: RouteStateOptions
) {
  const linkedGrouping = artifactRouteGrouping(
    params.get("group") ?? options.defaultGroupBy ?? "none",
    params.get("subgroup") ?? "none",
    parseGroupOrder(params.get("groupOrder"), "custom"),
    parseGroupOrder(params.get("subgroupOrder"), "asc")
  );
  options.setCollapsedGroups(
    readTableCollapsedGroupParams(params, linkedGrouping)
  );
  options.setGroupBy(params.get("group") ?? options.defaultGroupBy ?? "none");
  options.setGroupOrder(parseGroupOrder(params.get("groupOrder"), "custom"));
  options.setSecondaryGroupBy(params.get("subgroup") ?? "none");
  options.setSecondaryGroupOrder(
    parseGroupOrder(params.get("subgroupOrder"), "asc")
  );
  options.setShowEmptyGroups(params.get("emptyGroups") !== "false");
  options.setShowEmptySubgroups(params.get("emptySubgroups") !== "false");
}

function restoreDateDimension(
  params: URLSearchParams,
  dateDimension: ArtifactDateDimension
) {
  if (dateDimension.present) {
    const range = params.get("range");
    if (isArtifactDateRange(range)) {
      dateDimension.setRange(range);
    }
  }
}

function commitArtifactRoute(
  url: URL,
  options: Pick<RouteStateOptions, "routeState" | "dateDimension">,
  written: {
    appliedOwnedParams: { current: string | undefined };
    lastWrittenSearch: { current: string | undefined };
  },
  sourceSearch: string | undefined
) {
  if (options.routeState) {
    if (!options.dateDimension.present) {
      url.searchParams.delete("range");
    }
    const query = url.searchParams.toString();
    if (query !== sourceSearch) {
      written.lastWrittenSearch.current = query;
      // What this list just wrote is the state it has applied; a later URL that
      // differs only outside the owned params restores nothing.
      written.appliedOwnedParams.current = ownedRouteParams(
        new URLSearchParams(query)
      );
      options.routeState.replace(query);
    }
  } else {
    globalThis.window.history.replaceState({}, "", url);
  }
}
