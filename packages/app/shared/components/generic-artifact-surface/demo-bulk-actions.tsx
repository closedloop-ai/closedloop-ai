"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { TABLE_BULK_ACTION_BUTTON_CLASS_NAME } from "@repo/design-system/components/ui/table-bulk-action-bar";
import {
  type TableBulkActionDescriptor,
  type TableBulkActionOption,
  TableBulkActionUndo,
} from "@repo/design-system/components/ui/table-bulk-actions";
import type { TablePerson } from "@repo/design-system/components/ui/table-cell-primitives";
import { StarIcon, UserRoundIcon } from "lucide-react";
import { selectionSentence } from "./bulk-action-bar";

/**
 * The parity demo's own bulk operations, as descriptors (ISS-9329 AC2). They
 * used to be markup inside `ArtifactBulkActionBar`; expressing them here is
 * what lets that bar carry a production host's operations instead.
 *
 * Both declare `NotImplemented` rather than `Unsupported`: neither is
 * destructive, so under DOC-36 R12 both are reversible in principle and the
 * missing undo is a gap rather than a decision (R6).
 */
export function demoArtifactBulkActions({
  count,
  onAssignOwner,
  onFavorite,
  people,
}: {
  count: number;
  onAssignOwner: (owner: TablePerson) => void;
  onFavorite: () => void;
  people: readonly TablePerson[];
}): readonly TableBulkActionDescriptor[] {
  const assignOwnerLabel = `Assign owner of ${selectionSentence(count)}`;
  const ownerOptions: readonly TableBulkActionOption[] = people.map(
    (person) => ({ id: person.name, label: person.name })
  );
  // One body for both entry points below, so the descriptor's handler and the
  // menu's items cannot come to mean different things.
  const applyOwner = (option: TableBulkActionOption): boolean => {
    const owner = people.find((person) => person.name === option.id);
    if (!owner) {
      return false;
    }
    onAssignOwner(owner);
    return true;
  };

  return [
    {
      icon: <StarIcon />,
      id: "demo-favorite",
      kind: "command",
      label: `Favorite ${selectionSentence(count)}`,
      onSelect: onFavorite,
      undo: TableBulkActionUndo.NotImplemented,
    },
    {
      // Read only by the rail's own picker, which `render` below replaces here.
      // It matches the Sessions rail's wording so a host that drops `render`
      // inherits that empty state rather than a second phrasing of it.
      emptyLabel: "No matches",
      icon: <UserRoundIcon />,
      id: "demo-assign-owner",
      kind: "picker",
      label: assignOwnerLabel,
      onSelect: (_rowIds, option) => applyOwner(option),
      options: ownerOptions,
      undo: TableBulkActionUndo.NotImplemented,
      // A MENU rather than the rail's popover, kept deliberately: a menu walks
      // its items with the arrow keys, and this demo is where that keyboard
      // contract is pinned. The rail's popover is plain buttons with no roving
      // tab stop, so adopting it would silently retire arrow-key navigation
      // over the owner list.
      render: () => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={assignOwnerLabel}
              className={TABLE_BULK_ACTION_BUTTON_CLASS_NAME}
              size="icon"
              variant="ghost"
            >
              <UserRoundIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center">
            {ownerOptions.map((option) => (
              <DropdownMenuItem
                key={option.id}
                onSelect={() => applyOwner(option)}
              >
                {option.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];
}
