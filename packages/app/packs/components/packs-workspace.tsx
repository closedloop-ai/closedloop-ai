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
import { Link } from "@repo/navigation/link";
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
import { PackDetailUnavailable } from "./pack-detail-unavailable";
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
  /** The applied sort, or null when the grid is in the producer's own order. */
  sort: SortMode | null;
  /** `null` when the reader releases the applied mode — see the group below. */
  onSortChange: (value: SortMode | null) => void;
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
    {sortModes.length > 0 ? (
      <ToggleGroup
        aria-label="Sort packs"
        // An empty value is the group's own deselect. It used to be swallowed,
        // which was harmless while a mode was always applied — but now that
        // producer order is a state the grid can be IN, dropping the deselect
        // would make it one the reader can never get back to without a reload.
        onValueChange={(value) =>
          onSortChange(value ? (value as SortMode) : null)
        }
        type="single"
        // Empty when no offered mode is applied: the grid is in producer order,
        // and marking a mode active would claim an ordering that is not there.
        value={sort ?? ""}
        variant="outline"
      >
        {sortModes.map((mode) => (
          <ToggleGroupItem key={mode} value={mode}>
            {SORT_LABEL[mode]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    ) : null}
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
  /**
   * ISS-6925: the selected pack, when the HOST owns selection because the route
   * does. Supplying it (including as `null`) makes the workspace controlled;
   * omitting it entirely keeps the component-state selection that ships today.
   *
   * Controlled mode is what makes a detail addressable, and it is also what
   * makes the two states below reachable — a routed id can name a pack that is
   * still loading or is not in the catalog at all, neither of which component
   * state could ever produce.
   */
  selectedPackId?: string | null;
  /**
   * Discovery-grid href for the back affordance, so it renders as a real link
   * (middle-click, Cmd-click, "open in new tab") rather than a state reset.
   * Only meaningful alongside `selectedPackId`.
   */
  backHref?: string;
  /** The host's per-pack detail read is in flight (controlled mode only). */
  detailPending?: boolean;
  /** The host's per-pack detail read FAILED (controlled mode only). */
  detailFailed?: boolean;
  /** Retries the failed detail read, when the host can. */
  onDetailRetry?: () => void;
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
  /** The selected pack's bundled contents could not be refreshed. */
  detailContentsUnavailable?: boolean;
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
  selectedPackId,
  backHref,
  detailPending = false,
  detailFailed = false,
  onDetailRetry,
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
  detailContentsUnavailable,
  detailContentsSlot,
  memberTargetsLoading,
  memberTargetsError,
  memberTargetsDescription,
  memberTargetsInstall,
}: PacksWorkspaceProps) => {
  const showTeam = context.capabilities.showTeamUsage;
  // ISS-6767: a sort mode is offered only when its comparator can actually
  // order this catalog. `Popular`/`Trending` read `pack.teamUsage`, which no
  // producer of the grid's rows populates, so offering them unconditionally
  // gave every team surface toggles that reordered nothing — with `Popular`
  // presented as the applied sort while the grid sat in producer order.
  // Probed over the full catalog (not the current filter) so the control set
  // stays stable as the user types, and re-derived from `packs`, so the modes
  // return on their own once a list-level producer exists.
  const { sortModes, defaultSort } = useMemo(() => {
    const candidates = showTeam
      ? [SortMode.Popular, SortMode.Trending, SortMode.Stars]
      : [SortMode.Stars, SortMode.Name];
    const offered = candidates.filter((mode) => canOrder(mode, packs));
    return {
      sortModes: offered,
      // The leading candidate is the surface's intended default. When it cannot
      // order the catalog the grid stays in producer order rather than silently
      // promoting the next mode: nobody asked for that ranking, and adopting it
      // would re-order every grid as a side effect of dropping a dead control.
      defaultSort: offered[0] === candidates[0] ? candidates[0] : null,
    };
  }, [showTeam, packs]);

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);
  // Derived, not stored: the offered set depends on the corpus, so a preference
  // the corpus can no longer be ordered by falls back to the surface default
  // instead of pinning the grid to a comparator that ranks nothing.
  const [sortPreference, setSortPreference] = useState<SortMode | null>(null);
  const sort =
    sortPreference && sortModes.includes(sortPreference)
      ? sortPreference
      : defaultSort;
  // ISS-6925: `selectedPackId` present (even as null) means the route owns
  // selection and this state is unused; absent means the component owns it, the
  // behavior that ships today.
  const routed = selectedPackId !== undefined;
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(
    null
  );
  const selectedId = routed ? selectedPackId : internalSelectedId;

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
    return sort ? [...filtered].sort(SORT_COMPARATORS[sort]) : filtered;
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
    if (!routed) {
      setInternalSelectedId(packId);
    }
    onSelectPack?.(packId);
  };

  const selectLocalInstall = onInstall
    ? (packId: string) => onInstall(packId)
    : undefined;

  const backSlot = (
    <BackToGrid backHref={backHref} onBack={() => select(null)} />
  );

  if (selectedId) {
    const listItem = packs.find((pack) => pack.id === selectedId);
    const resolved =
      detailPack && detailPack.id === selectedId ? detailPack : listItem;
    if (resolved) {
      return (
        <div className="mx-auto w-full max-w-4xl px-6 pt-4">
          {backSlot}
          <PackDetail
            contentsSlot={detailContentsSlot}
            contentsUnavailable={detailContentsUnavailable}
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
    // Falling through to the discovery grid is right only while selection is
    // component state, where an unresolvable id cannot be reached. At a detail
    // URL it would answer a stale link with the catalog and a still-loading
    // direct load with "here is everything" — so a routed selection commits to
    // one of the two honest states instead.
    if (routed) {
      return (
        <div className="mx-auto w-full max-w-4xl px-6 pt-4">
          <PackDetailUnavailable
            backSlot={backSlot}
            failed={detailFailed}
            onRetry={onDetailRetry}
            pending={detailPending}
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
            onSortChange={setSortPreference}
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

/**
 * True when `mode`'s comparator can actually order `packs` — it separates at
 * least one pair. Probing the comparator itself (rather than a parallel key
 * accessor) is what makes the answer agree with the ordering the grid applies:
 * these comparators are consistent, so ranking every pack equal to the first
 * means ranking every pair equal, and the control would reorder nothing.
 */
function canOrder(mode: SortMode, packs: readonly PackView[]): boolean {
  const head = packs[0];
  if (!head) {
    return false;
  }
  const compare = SORT_COMPARATORS[mode];
  return packs.some((pack) => compare(head, pack) !== 0);
}

/**
 * The detail view's way back to the grid. A real anchor once the detail is
 * addressable (ISS-6925), so middle-click, Cmd-click and "open in new tab"
 * work; a button while selection is component state, where there is no href to
 * put on a link and the control is a state reset rather than a destination.
 */
function BackToGrid({
  backHref,
  onBack,
}: {
  backHref?: string;
  onBack: () => void;
}) {
  if (backHref) {
    return (
      <Button asChild className="gap-1.5" size="sm" variant="ghost">
        <Link href={backHref}>
          <ArrowLeftIcon className="size-4" />
          All plugins
        </Link>
      </Button>
    );
  }
  return (
    <Button className="gap-1.5" onClick={onBack} size="sm" variant="ghost">
      <ArrowLeftIcon className="size-4" />
      All plugins
    </Button>
  );
}
