"use client";

import {
  Card,
  CardContent,
  CardHeader,
} from "@repo/design-system/components/ui/card";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import type { ReactNode } from "react";

/** Default number of placeholder cards — enough to fill the grid above the fold
 *  without implying a specific catalog size. */
const DEFAULT_CARD_COUNT = 6;

type PacksWorkspaceSkeletonProps = {
  /** How many placeholder cards to render (defaults to {@link DEFAULT_CARD_COUNT}). */
  cardCount?: number;
  /**
   * Reserve the loaded workspace's two-column team shell — a `1fr 20rem` grid
   * with the card grid confined to the left and a rail placeholder on the right.
   * Defaults to `true` because every current caller mounts a `showTeamUsage`
   * surface (`WebMember` on the web dashboard, `DesktopTeam` in the plugins
   * panel), whose loaded {@link PacksWorkspace} renders that shell. A
   * single-column `DesktopSolo` surface passes `false` so the cards fill the
   * width, matching what actually loads. Reserving the real shape is the point:
   * a full-bleed skeleton that then snaps into a narrower main column with a
   * 20rem rail track is the exact reflow this component exists to prevent.
   */
  showTeamLayout?: boolean;
  /**
   * Static header rendered above the skeleton inside the same container the
   * loaded {@link PacksWorkspace} uses for its `toolbarSlot`. Pass the surface's
   * known-ahead-of-fetch heading here so it renders for real during loading and
   * stays put when the catalog resolves, instead of popping in and pushing the
   * grid down. Kept outside `aria-hidden` so its real text is announced.
   */
  header?: ReactNode;
};

/** One placeholder card mirroring {@link PackCard}'s header (name + publisher +
 *  stars) and body (two description lines, a content-summary line, and the
 *  footer action) at the same heights, so the real card drops into the same
 *  reserved space instead of growing as data fills in. */
const PackCardSkeleton = () => (
  <Card className="flex flex-col">
    <CardHeader className="gap-0">
      <div className="flex items-start justify-between gap-3">
        {/* Name (text-base ≈ 24px) over publisher (text-xs ≈ 16px), space-y-1 —
         *  matches PackCard's header block. */}
        <div className="min-w-0 space-y-1">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-20" />
        </div>
        <Skeleton className="h-5 w-10 shrink-0" />
      </div>
    </CardHeader>
    <CardContent className="flex flex-1 flex-col gap-4">
      {/* Two description lines (text-sm ≈ 20px, line-clamp-2) plus the shorter
       *  content-summary row (text-xs) PackCard shows under the description. */}
      <div className="space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-3 w-2/5" />
      </div>
      <div className="mt-auto flex items-center justify-between gap-3 border-border border-t pt-3">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-8 w-20 shrink-0" />
      </div>
    </CardContent>
  </Card>
);

/** Placeholder for the {@link TeamRail}'s Recommended/Activity cards, reserving
 *  the 20rem right track so the grid does not shift when the rail resolves. */
const TeamRailSkeleton = () => (
  <div className="space-y-4">
    <Card>
      <CardHeader className="gap-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-48" />
      </CardHeader>
      <CardContent className="space-y-3">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </CardContent>
    </Card>
  </div>
);

/**
 * Shared loading state for {@link PacksWorkspace}. Reserves the loaded
 * workspace's real layout — the filter bar, the card grid, and (by default) the
 * two-column team shell with its 20rem rail — so nothing shifts when the catalog
 * resolves. Both the web member dashboard and the desktop plugins panel mount
 * this so the same surface loads the same way (FEA-4068).
 *
 * Exposes an accessible loading status; the visual placeholders are hidden from
 * the accessibility tree so screen-reader users hear "Loading Packs" once rather
 * than a tree of empty decorative nodes.
 */
export const PacksWorkspaceSkeleton = ({
  cardCount = DEFAULT_CARD_COUNT,
  showTeamLayout = true,
  header,
}: PacksWorkspaceSkeletonProps) => {
  // Floor at 0 so a stray negative never throws a RangeError from Array.from.
  const cards = Math.max(0, cardCount);
  return (
    <div
      aria-busy="true"
      aria-label="Loading Packs"
      className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6"
      data-testid="packs-workspace-skeleton"
      role="status"
    >
      {/* Real (not decorative) heading, in the same container slot the loaded
       *  workspace renders `toolbarSlot`, so it does not move on load. */}
      {header ? (
        <div className="flex items-center justify-between gap-3">{header}</div>
      ) : null}
      {/* The visible placeholders are decorative — the accessible name above is
       *  the single announcement; hide the rest from assistive tech. */}
      <div
        aria-hidden="true"
        className={showTeamLayout ? "grid gap-6 lg:grid-cols-[1fr_20rem]" : ""}
      >
        {/* Filter bar + grid share the loaded workspace's `space-y-4` column so
         *  the grid lands where the real cards do (not 8px lower). */}
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Skeleton className="h-9 min-w-[200px] flex-1" />
            <Skeleton className="h-9 w-44" />
            <Skeleton className="h-9 w-48" />
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,350px),1fr))] gap-4">
            {Array.from({ length: cards }, (_, index) => (
              // Placeholder cards are a fixed, never-reordered, data-less list,
              // so a positional key is correct and stable here.
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder grid
              <PackCardSkeleton key={index} />
            ))}
          </div>
        </div>
        {showTeamLayout ? <TeamRailSkeleton /> : null}
      </div>
    </div>
  );
};
