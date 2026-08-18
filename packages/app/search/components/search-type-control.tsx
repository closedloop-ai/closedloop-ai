"use client";

import type { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { cn } from "@repo/design-system/lib/utils";
import { CheckIcon, ListFilterIcon } from "lucide-react";
import {
  SEARCH_ENTITY_TYPE_ICONS,
  SEARCH_ENTITY_TYPE_LABELS,
  SEARCH_TYPE_CONTROL_ORDER,
} from "../lib/search-display";

type SearchTypeControlProps = {
  /** The kinds currently expressed as `type:` tokens in the query bar. */
  activeKinds: readonly SearchEntityType[];
  /** Toggle one kind — the parent splices the `type:` token in/out of the bar. */
  onToggleKind: (kind: SearchEntityType) => void;
};

/**
 * FEA-4134 — the mouse-first replacement for the old kind-facet chip strip. It
 * holds NO state of its own: it reads the active `type:` tokens out of the query
 * bar and writes tokens back, so the query string stays the single source of
 * truth (the JQL model). Faithful to the FEA-4031 prototype. Shared across the
 * web `/search` page via `@repo/app`.
 */
export function SearchTypeControl({
  activeKinds,
  onToggleKind,
}: SearchTypeControlProps) {
  const count = activeKinds.length;
  const summary = count === 0 ? "All types" : `${count} selected`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-label={`Filter by type, ${summary}`}
          className="h-11 gap-2"
          type="button"
          variant="outline"
        >
          <ListFilterIcon aria-hidden="true" className="size-4" />
          Type
          <span className="text-muted-foreground text-xs">{summary}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1">
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
          Filter by type
        </div>
        <ul className="flex flex-col">
          {SEARCH_TYPE_CONTROL_ORDER.map((kind) => {
            const Icon = SEARCH_ENTITY_TYPE_ICONS[kind];
            const isActive = activeKinds.includes(kind);
            return (
              <li key={kind}>
                <button
                  aria-pressed={isActive}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                  onClick={() => onToggleKind(kind)}
                  type="button"
                >
                  <Icon
                    aria-hidden="true"
                    className="size-4 text-muted-foreground"
                  />
                  <span className="flex-1">
                    {SEARCH_ENTITY_TYPE_LABELS[kind]}
                  </span>
                  <CheckIcon
                    aria-hidden="true"
                    className={cn(
                      "size-4 text-primary",
                      isActive ? "opacity-100" : "opacity-0"
                    )}
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
