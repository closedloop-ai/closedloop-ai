"use client";

import type { Harness } from "@repo/app/agents/lib/session-types";
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
import { ArrowLeftIcon, BlocksIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import {
  categoryDisplayLabel,
  installCount,
  type PackActivityEvent,
  type PackView,
  packDisambiguators,
  trendingPackIds,
  trendSlope,
} from "../lib/pack-view";
import type { PacksContext } from "../lib/packs-context";
import type { InstallPending } from "./install-controls";
import type { MemberTargetsInstall } from "./member-targets-block";
import { PackCard } from "./pack-card";
import { PackDetail } from "./pack-detail";
import { TeamRail } from "./team-rail";

const SortMode = {
  Popular: "popular",
  Trending: "trending",
  Stars: "stars",
  Name: "name",
} as const;
type SortMode = (typeof SortMode)[keyof typeof SortMode];

const ALL_CATEGORIES = "all";

const SORT_COMPARATORS: Record<SortMode, (a: PackView, b: PackView) => number> =
  {
    [SortMode.Popular]: (a, b) => installCount(b) - installCount(a),
    [SortMode.Trending]: (a, b) => trendSlope(b) - trendSlope(a),
    [SortMode.Stars]: (a, b) => (b.stars ?? 0) - (a.stars ?? 0),
    [SortMode.Name]: (a, b) => a.name.localeCompare(b.name),
  };

const SORT_LABEL: Record<SortMode, string> = {
  [SortMode.Popular]: "Popular",
  [SortMode.Trending]: "Trending",
  [SortMode.Stars]: "Stars",
  [SortMode.Name]: "Name",
};

const matchesQuery = (
  pack: PackView,
  query: string,
  disambiguator?: string
): boolean => {
  if (!query) {
    return true;
  }
  // Include the disambiguating qualifier: a user who reads "Agent" or "v2.3.1"
  // off a same-named card and types it into the box must still find that card
  // (FEA-3972), not get an empty grid.
  const haystack =
    `${pack.name} ${pack.publisher ?? ""} ${pack.description ?? ""} ${disambiguator ?? ""}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
};

const FilterBar = ({
  query,
  onQueryChange,
  category,
  onCategoryChange,
  categories,
  sort,
  onSortChange,
  sortModes,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  category: string;
  onCategoryChange: (value: string) => void;
  categories: readonly string[];
  sort: SortMode;
  onSortChange: (value: SortMode) => void;
  sortModes: readonly SortMode[];
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
        placeholder="Search by name, publisher, or description"
        value={query}
      />
    </div>
    {categories.length > 0 ? (
      <Select onValueChange={onCategoryChange} value={category}>
        <SelectTrigger aria-label="Category" className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
          {categories.map((value) => (
            <SelectItem key={value} value={value}>
              {categoryDisplayLabel(value)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : null}
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
      {sortModes.map((mode) => (
        <ToggleGroupItem key={mode} value={mode}>
          {SORT_LABEL[mode]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  </div>
);

export type PacksWorkspaceProps = {
  packs: PackView[];
  context: PacksContext;
  /** Fully-loaded detail for the selected pack (contents/team/perf/distribution).
   *  Falls back to the matching list item when absent. */
  detailPack?: PackView | null;
  /** Notified whenever the selected pack changes (so the host can fetch detail). */
  onSelectPack?: (packId: string | null) => void;
  /** Org-wide recent activity for the team rail (multiplayer surfaces). */
  activity?: PackActivityEvent[];
  emptyState?: ReactNode;
  /** Admin actions / toolbar rendered above the grid (e.g. "New plugin"). */
  toolbarSlot?: ReactNode;
  /** Extra content rendered below the grid (e.g. run history, opt-in banner). */
  footerSlot?: ReactNode;
  installPending?: InstallPending | null;
  installError?: string | null;
  onInstall?: (packId: string, harness?: Harness) => void;
  onUninstall?: (packId: string, harness: Harness) => void;
  onUpdate?: (packId: string, harness: Harness) => void;
  onManageDistribution?: (packId: string) => void;
  /**
   * Withdraw the selected pack's distribution — stop offering it to the
   * organization (ISS-5123). Forwarded straight to `PackDetail`; absent on every
   * surface that lacks the capability or has the flag off.
   */
  onWithdrawDistribution?: (distributionIds: string[]) => void;
  /** A withdrawal is in flight for the selected pack (ISS-5123). */
  withdrawDistributionPending?: boolean;
  /** Extra admin actions (e.g. Archive) for the selected pack's detail header. */
  detailHeaderActions?: ReactNode;
  /** Replaces the selected pack's read-only Contents (e.g. admin components manager). */
  detailContentsSlot?: ReactNode;
  /** Member per-machine read is in flight for the detail block (FEA-4077). */
  memberTargetsLoading?: boolean;
  /** Member per-machine read failed for the detail block (FEA-4077). */
  memberTargetsError?: boolean;
  /** Honest per-surface description for the member per-machine block (FEA-4077). */
  memberTargetsDescription?: string;
  /**
   * ISS-5125: the member per-machine block's ACT half, passed straight to
   * `PackDetail`. Omitted → that block stays read-only.
   */
  memberTargetsInstall?: MemberTargetsInstall | null;
};

export const PacksWorkspace = ({
  packs,
  context,
  detailPack,
  onSelectPack,
  activity = [],
  emptyState,
  toolbarSlot,
  footerSlot,
  installPending,
  installError,
  onInstall,
  onUninstall,
  onUpdate,
  onManageDistribution,
  onWithdrawDistribution,
  withdrawDistributionPending,
  detailHeaderActions,
  detailContentsSlot,
  memberTargetsLoading,
  memberTargetsError,
  memberTargetsDescription,
  memberTargetsInstall,
}: PacksWorkspaceProps) => {
  const showTeam = context.capabilities.showTeamUsage;
  const sortModes = useMemo<SortMode[]>(
    () =>
      showTeam
        ? [SortMode.Popular, SortMode.Trending, SortMode.Stars]
        : [SortMode.Stars, SortMode.Name],
    [showTeam]
  );

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);
  const [sort, setSort] = useState<SortMode>(sortModes[0]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const pack of packs) {
      if (pack.category) {
        set.add(pack.category);
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [packs]);

  // Qualifier per pack whose display name collides with another in the catalog,
  // so same-named grid cards stay distinguishable at a glance (FEA-3972).
  // Computed over the full set — a collision is a property of the catalog, not
  // the current filter.
  const disambiguators = useMemo(() => packDisambiguators(packs), [packs]);

  // Catalog-relative "trending" set (top movers vs. the field), computed once
  // over the full catalog so the badge is selective and stable across filters
  // rather than lighting up on every climbing card (FEA-3236).
  const trending = useMemo(() => trendingPackIds(packs), [packs]);

  const visiblePacks = useMemo(() => {
    const filtered = packs.filter(
      (pack) =>
        matchesQuery(pack, query, disambiguators.get(pack.id)) &&
        (category === ALL_CATEGORIES || pack.category === category)
    );
    return [...filtered].sort(SORT_COMPARATORS[sort]);
  }, [packs, query, category, sort, disambiguators]);

  const recommended = useMemo(() => {
    if (!showTeam) {
      return [];
    }
    return [...packs]
      .filter((pack) => !pack.installedByMe && installCount(pack) >= 3)
      .sort(SORT_COMPARATORS[SortMode.Popular])
      .slice(0, 3);
  }, [packs, showTeam]);

  const select = (packId: string | null) => {
    setSelectedId(packId);
    onSelectPack?.(packId);
  };

  const selectLocalInstall = onInstall
    ? (packId: string) => onInstall(packId)
    : undefined;

  if (selectedId) {
    const listItem = packs.find((pack) => pack.id === selectedId);
    const resolved =
      detailPack && detailPack.id === selectedId ? detailPack : listItem;
    if (resolved) {
      return (
        <div className="mx-auto w-full max-w-4xl px-6 pt-4">
          <Button
            className="gap-1.5"
            onClick={() => select(null)}
            size="sm"
            variant="ghost"
          >
            <ArrowLeftIcon className="size-4" />
            All plugins
          </Button>
          <PackDetail
            contentsSlot={detailContentsSlot}
            context={context}
            disambiguator={disambiguators.get(resolved.id)}
            headerActions={detailHeaderActions}
            installError={installError}
            installPending={installPending}
            memberTargetsDescription={memberTargetsDescription}
            memberTargetsError={memberTargetsError}
            memberTargetsInstall={memberTargetsInstall}
            memberTargetsLoading={memberTargetsLoading}
            onInstall={onInstall}
            onManageDistribution={onManageDistribution}
            onUninstall={onUninstall}
            onUpdate={onUpdate}
            onWithdrawDistribution={onWithdrawDistribution}
            pack={resolved}
            withdrawDistributionPending={withdrawDistributionPending}
          />
        </div>
      );
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      {toolbarSlot ? (
        <div className="flex items-center justify-between gap-3">
          {toolbarSlot}
        </div>
      ) : null}
      <div className={showTeam ? "grid gap-6 lg:grid-cols-[1fr_20rem]" : ""}>
        <div className="space-y-4">
          <FilterBar
            categories={categories}
            category={category}
            onCategoryChange={setCategory}
            onQueryChange={setQuery}
            onSortChange={setSort}
            query={query}
            sort={sort}
            sortModes={sortModes}
          />
          {visiblePacks.length > 0 ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,350px),1fr))] gap-4">
              {visiblePacks.map((pack) => (
                <PackCard
                  context={context}
                  disambiguator={disambiguators.get(pack.id)}
                  key={pack.id}
                  onInstall={selectLocalInstall}
                  onSelect={select}
                  pack={pack}
                  trending={trending.has(pack.id)}
                />
              ))}
            </div>
          ) : (
            (emptyState ?? (
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
            ))
          )}
        </div>

        {showTeam ? (
          <TeamRail
            activity={activity}
            context={context}
            disambiguators={disambiguators}
            onInstall={selectLocalInstall}
            onSelect={select}
            recommended={recommended}
          />
        ) : null}
      </div>
      {footerSlot}
    </div>
  );
};
