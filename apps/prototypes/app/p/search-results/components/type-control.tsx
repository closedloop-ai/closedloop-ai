"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { cn } from "@repo/design-system/lib/utils";
import { CheckIcon, ListFilterIcon } from "lucide-react";
import {
  ENTITY_KIND_LABELS,
  ENTITY_KIND_ORDER,
  type EntityKind,
} from "../search-model";
import { KIND_ICONS } from "./kind-visuals";

type TypeControlProps = {
  /** The kinds currently expressed as `type:` tokens in the query bar. */
  activeKinds: readonly EntityKind[];
  /** Toggle one kind - the parent splices the `type:` token in/out of the bar. */
  onToggleKind: (kind: EntityKind) => void;
};

// The mouse-first replacement for the old kind-pill strip. It does not hold its
// own state: it reads the active `type:` tokens out of the query bar and writes
// tokens back, so the bar stays the single source of truth (the JQL model).
export function TypeControl({ activeKinds, onToggleKind }: TypeControlProps) {
  const count = activeKinds.length;
  const summary = count === 0 ? "All types" : `${count} selected`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-label={`Filter by type, ${summary}`}
          className="gap-2"
          size="sm"
          type="button"
          variant="outline"
        >
          <ListFilterIcon aria-hidden="true" className="size-3.5" />
          Type
          <span className="text-muted-foreground text-xs">{summary}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1">
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
          Filter by type
        </div>
        <ul className="flex flex-col">
          {ENTITY_KIND_ORDER.map((kind) => {
            const Icon = KIND_ICONS[kind];
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
                    className="size-3.5 text-muted-foreground"
                  />
                  <span className="flex-1">{ENTITY_KIND_LABELS[kind]}</span>
                  <CheckIcon
                    aria-hidden="true"
                    className={cn(
                      "size-3.5 text-primary",
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
