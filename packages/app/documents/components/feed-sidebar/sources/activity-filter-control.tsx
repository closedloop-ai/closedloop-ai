"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { SlidersHorizontal } from "lucide-react";
import { ActivityFilterKind, type ActivityFilterState } from "./activity-types";

const ACTOR_KIND_OPTIONS: readonly {
  value: ActivityFilterKind;
  label: string;
}[] = [
  { value: ActivityFilterKind.All, label: "All actors" },
  { value: ActivityFilterKind.Human, label: "Human" },
  { value: ActivityFilterKind.Agent, label: "Agent" },
  { value: ActivityFilterKind.System, label: "System" },
];

/**
 * Actor-kind sub-filter rendered when the Activity kind is active in the feed
 * filter bar. Narrows the timeline to human / agent / system attribution.
 *
 * Uses the same compact "Filter" dropdown-button shape as the Liveblocks
 * sub-filter that shares this slot (`liveblocks-filter-control.tsx`), so
 * switching feed kinds does not swap the control shape underneath the user.
 */
export function ActivityFilterControl({
  state,
  onChange,
}: Readonly<{
  state: ActivityFilterState;
  onChange: (next: ActivityFilterState) => void;
}>) {
  return (
    <div className="flex shrink-0 items-center gap-2 px-3 pb-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label="Filter activity by actor"
            className="inline-flex items-center gap-1 rounded border px-2 py-0.5 text-muted-foreground text-xs hover:bg-muted"
            type="button"
          >
            <SlidersHorizontal className="h-3 w-3" />
            Filter
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel>Actor</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            onValueChange={(value) =>
              onChange({ actorKind: value as ActivityFilterKind })
            }
            value={state.actorKind}
          >
            {ACTOR_KIND_OPTIONS.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
