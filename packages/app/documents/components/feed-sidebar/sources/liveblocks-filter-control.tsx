"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { History, SlidersHorizontal } from "lucide-react";
import {
  FeedFilterCommentType,
  FeedFilterVersionOfOrigin,
} from "../feed-filter-context";
import type { LiveblocksFilterState } from "./apply-liveblocks-filter";
import { useLiveblocksSourceContext } from "./liveblocks-source-provider";

export type LiveblocksFilterControlProps = {
  state: LiveblocksFilterState;
  onChange: (next: LiveblocksFilterState) => void;
};

/**
 * Sub-filter rendered below the kind selector when the Comments kind is
 * active. Two variants:
 *
 * - Historical (read-only). When `state.versionFilter !== undefined` the
 *   doc viewer is pinned to a non-latest version; the chip surfaces the
 *   pinned version and the dropdown is suppressed (anchored/document-level
 *   distinction is low value against a single-version slice).
 * - Live (interactive). Renders version-of-origin + comment-type radio
 *   groups, mirroring the legacy `feed-filter-bar.tsx` dropdown.
 */
export function LiveblocksFilterControl({
  state,
  onChange,
}: Readonly<LiveblocksFilterControlProps>) {
  const { latestVersion } = useLiveblocksSourceContext();
  if (state.versionFilter !== undefined) {
    return (
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1.5">
        <span className="inline-flex items-center gap-1 rounded border bg-muted/40 px-2 py-0.5 text-muted-foreground text-xs">
          <History className="h-3 w-3" />
          Viewing v{state.versionFilter}
          {latestVersion > state.versionFilter && (
            <span className="text-muted-foreground/70">
              {" "}
              (latest v{latestVersion})
            </span>
          )}
        </span>
      </div>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-2 px-3 pb-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label="Filter Liveblocks comments"
            className="inline-flex items-center gap-1 rounded border px-2 py-0.5 text-muted-foreground text-xs hover:bg-muted"
            type="button"
          >
            <SlidersHorizontal className="h-3 w-3" />
            Filter
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel>Version of origin</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            onValueChange={(value) =>
              onChange({
                ...state,
                versionOfOrigin: value as FeedFilterVersionOfOrigin,
              })
            }
            value={state.versionOfOrigin}
          >
            <DropdownMenuRadioItem value={FeedFilterVersionOfOrigin.All}>
              All versions
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value={FeedFilterVersionOfOrigin.Current}>
              Current version only
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value={FeedFilterVersionOfOrigin.Prior}>
              Prior versions only
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Comment type</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            onValueChange={(value) =>
              onChange({
                ...state,
                commentType: value as FeedFilterCommentType,
              })
            }
            value={state.commentType}
          >
            <DropdownMenuRadioItem value={FeedFilterCommentType.All}>
              All types
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value={FeedFilterCommentType.Anchored}>
              Anchored
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value={FeedFilterCommentType.DocumentLevel}>
              Document-level
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
