"use client";

import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useState } from "react";
import type { ArtifactKind, ArtifactStatus } from "../mock";
import {
  type ArtifactFilters,
  type ArtifactGroupOrder,
  type ArtifactListLayout,
  type CustomFieldFilter,
  DATE_RANGES,
} from "./artifact-list-model";

type RouteStateOptions = {
  activeSavedViewId: string;
  customFieldFilters: Record<string, CustomFieldFilter>;
  dateRange: string;
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
  setCustomFieldFilters: Dispatch<
    SetStateAction<Record<string, CustomFieldFilter>>
  >;
  setDateRange: Dispatch<SetStateAction<string>>;
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

const parseRecord = <T>(
  params: URLSearchParams,
  key: string
): Record<string, T> => {
  try {
    return JSON.parse(params.get(key) ?? "{}") as Record<string, T>;
  } catch {
    return {};
  }
};

export function useArtifactListRouteState(options: RouteStateOptions) {
  const [restored, setRestored] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: React state setters are stable and URL restoration intentionally runs once on mount.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const range = params.get("range");
    if (DATE_RANGES.some((candidate) => candidate.value === range)) {
      options.setDateRange(range ?? "30d");
    }
    const sortBy = params.get("sort");
    if (sortBy) {
      options.setSortActive(true);
      options.setSortBy(sortBy);
      options.setSortDir(params.get("direction") === "desc" ? "desc" : "asc");
    }
    options.setGroupBy(params.get("group") ?? "none");
    options.setGroupOrder(parseGroupOrder(params.get("groupOrder"), "custom"));
    options.setSecondaryGroupBy(params.get("subgroup") ?? "none");
    options.setSecondaryGroupOrder(
      parseGroupOrder(params.get("subgroupOrder"), "asc")
    );
    options.setShowEmptyGroups(params.get("emptyGroups") !== "false");
    options.setShowEmptySubgroups(params.get("emptySubgroups") !== "false");
    options.setLayout(params.get("layout") === "board" ? "board" : "list");
    options.setActiveSavedViewId(params.get("view") ?? "default");
    options.setFilters({
      favoritesOnly: params.get("favorites") === "true",
      kinds: parseList(params, "kinds") as ArtifactKind[],
      mineOnly: params.get("mine") === "true",
      owners: parseList(params, "owners"),
      statuses: parseList(params, "statuses") as ArtifactStatus[],
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
      parseRecord<CustomFieldFilter>(params, "customFieldFilters")
    );
    options.setExtensionFilters(
      parseRecord<CustomFieldFilter>(params, "extensionFilters")
    );
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) {
      return;
    }
    const url = new URL(window.location.href);
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
    setDefaulted("range", options.dateRange, "30d");
    if (options.sortActive) {
      url.searchParams.set("sort", options.sortBy);
      url.searchParams.set("direction", options.sortDir);
    } else {
      url.searchParams.delete("sort");
      url.searchParams.delete("direction");
    }
    setDefaulted("group", options.groupBy, "none");
    setDefaulted("groupOrder", options.groupOrder, "custom");
    setDefaulted("subgroup", options.secondaryGroupBy, "none");
    setDefaulted("subgroupOrder", options.secondaryGroupOrder, "asc");
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
    window.history.replaceState({}, "", url);
  }, [
    options.activeSavedViewId,
    options.customFieldFilters,
    options.dateRange,
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

function parseGroupOrder(
  value: string | null,
  fallback: ArtifactGroupOrder
): ArtifactGroupOrder {
  return value === "asc" || value === "desc" || value === "custom"
    ? value
    : fallback;
}
