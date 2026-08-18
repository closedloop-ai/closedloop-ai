"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Input } from "@repo/design-system/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { BlocksIcon, SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";
import {
  installCount,
  mockActivity,
  mockPacks,
  type Pack,
  PackCategory,
} from "../mock";
import { AppShell, type Crumb } from "./app-shell";
import { PackCard } from "./pack-card";
import { PackDetail } from "./pack-detail";
import { TeamRail } from "./team-rail";

const SortMode = {
  Popular: "popular",
  Trending: "trending",
  Stars: "stars",
} as const;

type SortMode = (typeof SortMode)[keyof typeof SortMode];

const ALL_CATEGORIES = "all";

// Slope of the install trend: how fast adoption is climbing this window.
const trendSlope = (pack: Pack): number => {
  const trend = pack.installTrend;
  if (trend.length < 2) {
    return 0;
  }
  const last = trend.at(-1) ?? 0;
  const first = trend.at(0) ?? 0;
  return last - first;
};

const SORT_COMPARATORS: Record<SortMode, (a: Pack, b: Pack) => number> = {
  [SortMode.Popular]: (a, b) => installCount(b) - installCount(a),
  [SortMode.Trending]: (a, b) => trendSlope(b) - trendSlope(a),
  [SortMode.Stars]: (a, b) => b.stars - a.stars,
};

const matchesQuery = (pack: Pack, query: string): boolean => {
  if (!query) {
    return true;
  }
  const haystack =
    `${pack.name} ${pack.publisher} ${pack.description}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
};

const FilterBar = ({
  query,
  onQueryChange,
  category,
  onCategoryChange,
  sort,
  onSortChange,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  category: string;
  onCategoryChange: (value: string) => void;
  sort: SortMode;
  onSortChange: (value: SortMode) => void;
}) => (
  <div className="flex flex-wrap items-center gap-3">
    <div className="relative min-w-[200px] flex-1">
      <SearchIcon
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        size={16}
      />
      <Input
        aria-label="Search packs"
        className="pl-9"
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Search packs by name, publisher, or description"
        value={query}
      />
    </div>
    <Select onValueChange={onCategoryChange} value={category}>
      <SelectTrigger aria-label="Category" className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
        {Object.values(PackCategory).map((value) => (
          <SelectItem key={value} value={value}>
            {value}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
    <ToggleGroup
      aria-label="Sort packs"
      onValueChange={(value) => {
        if (value) {
          onSortChange(value as SortMode);
        }
      }}
      type="single"
      value={sort}
      variant="outline"
    >
      <ToggleGroupItem value={SortMode.Popular}>Popular</ToggleGroupItem>
      <ToggleGroupItem value={SortMode.Trending}>Trending</ToggleGroupItem>
      <ToggleGroupItem value={SortMode.Stars}>Stars</ToggleGroupItem>
    </ToggleGroup>
  </div>
);

export const PacksWorkspace = () => {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);
  const [sort, setSort] = useState<SortMode>(SortMode.Popular);
  const [selected, setSelected] = useState<Pack | null>(null);

  const visiblePacks = useMemo(() => {
    const filtered = mockPacks.filter(
      (pack) =>
        matchesQuery(pack, query) &&
        (category === ALL_CATEGORIES || pack.category === category)
    );
    return [...filtered].sort(SORT_COMPARATORS[sort]);
  }, [query, category, sort]);

  const clearSelection = () => setSelected(null);

  const selectById = (packId: string) => {
    const match = mockPacks.find((pack) => pack.id === packId);
    if (match) {
      setSelected(match);
    }
  };

  const breadcrumbs: readonly Crumb[] = selected
    ? [
        { label: "Packs", onClick: clearSelection },
        { label: selected.name, isCurrent: true },
      ]
    : [{ label: "Packs", isCurrent: true }];

  return (
    <AppShell breadcrumbs={breadcrumbs} onNavigatePacks={clearSelection}>
      {selected ? (
        <PackDetail pack={selected} />
      ) : (
        <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
          <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
            <div className="space-y-4">
              <FilterBar
                category={category}
                onCategoryChange={setCategory}
                onQueryChange={setQuery}
                onSortChange={setSort}
                query={query}
                sort={sort}
              />
              {visiblePacks.length > 0 ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,350px),1fr))] gap-4">
                  {visiblePacks.map((pack) => (
                    <PackCard
                      key={pack.id}
                      onSelect={setSelected}
                      pack={pack}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState
                  action={
                    <Button
                      onClick={() => {
                        setQuery("");
                        setCategory(ALL_CATEGORIES);
                      }}
                      size="sm"
                      variant="outline"
                    >
                      Clear filters
                    </Button>
                  }
                  className="py-16"
                  icon={BlocksIcon}
                  title="No packs match your filters"
                />
              )}
            </div>

            <TeamRail activity={mockActivity} onSelectPackId={selectById} />
          </div>
        </div>
      )}
    </AppShell>
  );
};
