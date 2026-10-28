"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Trash2Icon } from "lucide-react";
import { useState } from "react";
import { DeleteConfirmationDialog } from "./delete-confirmation-dialog";
import type {
  DeletionEffects,
  DeletionScopeItem,
} from "./deletion-scope-review";

/**
 * ISS-12539 (PRD-808, data controls flow 4): where a user starts a deletion,
 * or a request for one. It is the same entry point on session detail (desktop
 * and web, AC-001) and in the Settings data controls surface (AC-002): a
 * button that opens the shipped `DeleteConfirmationDialog` with its ISS-12537
 * scope review (AC-003). It adds no dialog of its own, so confirm/cancel, the
 * pending state and the responsive Dialog/Sheet swap stay that one
 * implementation.
 *
 * The host says what is in scope: on session detail, that session; in
 * Settings, whatever the data controls surface lists. Every open starts from
 * `initialSelectedIds` (all of `items` when omitted), so a scope the user
 * narrowed and then cancelled does not carry over to the next open.
 *
 * Design-only. There is no deletion endpoint yet (PRD-808 "Non-component
 * dependencies"), so no live host mounts it; `onConfirm` is where a host will
 * send the request. This component authors no copy: every label is a prop,
 * and copy about what a deletion does is subject to technical verification
 * (PRD-796).
 */
export type DeletionEntryPointProps = {
  /** The trigger button's text, and its accessible name. */
  triggerLabel: string;
  /** Forwarded to the dialog: its title reads "Delete {title}". */
  title: string;
  /** Forwarded to the dialog: the item named by its default description. */
  itemName: string;
  /** Forwarded to the dialog: replaces its default description. */
  description?: string;
  /**
   * What the deletion could cover. When it is empty the trigger still opens
   * the dialog, with Delete disabled. Whether it should instead be hidden,
   * disabled or explained is open for the PRD-796 owners (PR #8878 review).
   */
  items: readonly DeletionScopeItem[];
  /** What starts in scope on every open. Defaults to all of `items`. */
  initialSelectedIds?: readonly string[];
  /** The scope list's legend and accessible name. */
  scopeLabel: string;
  /** The effects section's heading. */
  effectsLabel: string;
  effects: DeletionEffects;
  /**
   * Called with the ids in scope when the user confirms. Resolve `true` to
   * close the dialog; anything else keeps it open for a retry.
   */
  onConfirm: (scopeIds: string[]) => Promise<boolean>;
  /** A confirmed deletion is in flight: the dialog's own pending state. */
  isPending?: boolean;
  className?: string;
};

/**
 * The dialog passes the ids in scope whenever `scopeReview` is set, which it
 * always is here, and disables Delete while that scope is empty. Getting no
 * ids, or none, means that contract broke; on a delete path that must not
 * reach the host as a request with an empty scope (PR #8878 review). Throwing
 * keeps the dialog open: it swallows a rejected confirm and closes only on
 * success.
 */
function requireScopeIds(scopeIds: string[] | undefined): string[] {
  if (scopeIds === undefined || scopeIds.length === 0) {
    throw new Error(
      "DeletionEntryPoint: the dialog confirmed without any ids in scope"
    );
  }
  return scopeIds;
}

export function DeletionEntryPoint({
  triggerLabel,
  title,
  itemName,
  description,
  items,
  initialSelectedIds,
  scopeLabel,
  effectsLabel,
  effects,
  onConfirm,
  isPending = false,
  className,
}: Readonly<DeletionEntryPointProps>) {
  const [open, setOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);

  const openReview = () => {
    setSelectedIds(initialSelectedIds ?? items.map((item) => item.id));
    setOpen(true);
  };

  return (
    <>
      <Button
        className={className}
        data-testid="deletion-entry-point"
        onClick={openReview}
        size="sm"
        variant="outline"
      >
        <Trash2Icon aria-hidden="true" />
        {triggerLabel}
      </Button>
      <DeleteConfirmationDialog
        description={description}
        isPending={isPending}
        itemName={itemName}
        onConfirm={(scopeIds) => onConfirm(requireScopeIds(scopeIds))}
        onOpenChange={setOpen}
        open={open}
        scopeReview={{
          effects,
          effectsLabel,
          items,
          onSelectedIdsChange: setSelectedIds,
          scopeLabel,
          selectedIds,
        }}
        title={title}
      />
    </>
  );
}
