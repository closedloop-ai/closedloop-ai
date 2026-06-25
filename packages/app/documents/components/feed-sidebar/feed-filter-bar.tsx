"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  ArrowDownNarrowWide,
  ArrowUpNarrowWide,
  ChevronDown,
  ListTree,
} from "lucide-react";
import { useMemo } from "react";
import {
  ACTIVE_KIND_ALL,
  type ActiveKind,
  FeedFilterSort,
  useFeedFilter,
} from "./feed-filter-context";
import { useFeedSources } from "./feed-sources-context";
import { useAllSourceItems } from "./source-items-registry";

type KindOption = {
  key: ActiveKind;
  label: string;
  Icon: typeof ListTree;
  count: number;
};

/**
 * Top-of-feed filter bar.
 *
 * - Single-select kind dropdown lists `"All"` + one option per
 *   mounted source. Selecting a kind narrows the merged stream.
 * - Below the kind selector, the active source's `FilterControl` (if
 *   it has one) renders its sub-filter UI.
 * - Right-aligned sort toggle flips `FeedFilterSort` between Newest
 *   (default) and Oldest.
 *
 * **Reads items from the `SourceItemsContext` registry** to compute
 * per-kind counts — does NOT call `source.useItems()` directly.
 */
export function FeedFilterBar() {
  const sources = useFeedSources();
  const registry = useAllSourceItems();
  const {
    activeKind,
    setActiveKind,
    sort,
    setSort,
    getSourceState,
    setSourceState,
  } = useFeedFilter();

  const kindOptions = useMemo<KindOption[]>(() => {
    let allCount = 0;
    const perSource: KindOption[] = [];
    for (const source of sources) {
      const registered = registry.get(source.id);
      const items = registered?.result.items ?? [];
      const state = getSourceState(source.id) ?? source.defaultFilterState;
      const visible = source.applyFilter(items, state).length;
      allCount += visible;
      perSource.push({
        key: source.kind,
        label: source.label,
        Icon: source.Icon,
        count: visible,
      });
    }
    return [
      { key: ACTIVE_KIND_ALL, label: "All", Icon: ListTree, count: allCount },
      ...perSource,
    ];
  }, [sources, registry, getSourceState]);

  const active =
    kindOptions.find((opt) => opt.key === activeKind) ?? kindOptions[0];
  const ActiveIcon = active.Icon;

  const isNewest = sort === FeedFilterSort.Newest;
  const SortIcon = isNewest ? ArrowDownNarrowWide : ArrowUpNarrowWide;
  const nextSort = isNewest ? FeedFilterSort.Oldest : FeedFilterSort.Newest;
  const sortAriaLabel = isNewest ? "Sort oldest first" : "Sort newest first";

  const activeSource =
    activeKind === ACTIVE_KIND_ALL
      ? undefined
      : sources.find((s) => s.kind === activeKind);
  const ActiveFilterControl = activeSource?.FilterControl;

  return (
    <div className="flex shrink-0 flex-col gap-1 border-b">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="Filter feed by source"
              className="h-auto gap-1 rounded px-2 py-0.5 font-normal text-muted-foreground text-xs"
              size="sm"
              variant="outline"
            >
              <ActiveIcon className="h-3 w-3" />
              {active.label}{" "}
              <span className="font-medium text-foreground">
                {active.count}
              </span>
              <ChevronDown className="h-3 w-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            {kindOptions.map((opt) => {
              const OptIcon = opt.Icon;
              return (
                <DropdownMenuItem
                  key={opt.key}
                  onSelect={() => setActiveKind(opt.key)}
                >
                  <OptIcon className="mr-2 h-3 w-3" />
                  <span className="flex-1">{opt.label}</span>
                  <span className="text-muted-foreground text-xs">
                    {opt.count}
                  </span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          aria-label={sortAriaLabel}
          className="h-auto rounded px-1.5 py-0.5 text-muted-foreground"
          onClick={() => setSort(nextSort)}
          size="sm"
          variant="outline"
        >
          <SortIcon className="h-3 w-3" />
        </Button>
      </div>
      {ActiveFilterControl !== undefined && activeSource !== undefined && (
        <ActiveFilterControl
          onChange={(next) => setSourceState(activeSource.id, next)}
          state={
            getSourceState(activeSource.id) ?? activeSource.defaultFilterState
          }
        />
      )}
    </div>
  );
}
