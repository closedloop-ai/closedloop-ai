"use client";

import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { Columns3Icon, ListIcon } from "lucide-react";

export type ListLayout = "board" | "list";

/**
 * The one List/Board switch. Each page keeps its own accessible group name
 * (`ariaLabel`); the items, icons and words are shared.
 */
export function ListLayoutToggle({
  ariaLabel,
  className,
  itemClassName,
  onChange,
  showLabels,
  value,
}: {
  ariaLabel: string;
  className?: string;
  /** Applied to both items, for a host that sizes them (the wide toolbar). */
  itemClassName?: string;
  onChange: (layout: ListLayout) => void;
  showLabels: boolean;
  value: ListLayout;
}) {
  return (
    <ToggleGroup
      aria-label={ariaLabel}
      className={className}
      onValueChange={(next) => {
        if (next === "list" || next === "board") {
          onChange(next);
        }
      }}
      type="single"
      value={value}
      variant="outline"
    >
      <ToggleGroupItem
        aria-label="List view"
        className={itemClassName}
        value="list"
      >
        <ListIcon />
        {showLabels ? "List" : null}
      </ToggleGroupItem>
      <ToggleGroupItem
        aria-label="Board view"
        className={itemClassName}
        value="board"
      >
        <Columns3Icon />
        {showLabels ? "Board" : null}
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
