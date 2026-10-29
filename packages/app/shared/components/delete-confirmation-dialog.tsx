"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { useResponsiveModal } from "@repo/design-system/hooks/use-responsive-modal";
import { cn } from "@repo/design-system/lib/utils";
import {
  DeletionScopeReview,
  type DeletionScopeReviewProps,
} from "./deletion-scope-review";

type DeleteConfirmationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  itemName: string;
  /**
   * With `scopeReview` set, called with the ids actually in scope: the
   * selected ids that are present in `scopeReview.items`, in `items` order.
   * Act on those, not on the host's own `selectedIds`, which can still hold
   * ids that a refresh removed from `items` and the user can no longer see.
   * Without `scopeReview` it is called with no argument, as before.
   */
  onConfirm: (scopeIds?: string[]) => Promise<boolean>;
  isPending?: boolean;
  /**
   * Overrides the default "Are you sure…? This action cannot be undone."
   * body. Use when the default copy would mislead — e.g. branch/PR deletes,
   * which only remove the Closedloop record, not the upstream GitHub PR.
   */
  description?: string;
  /**
   * ISS-12537: review what the deletion covers before confirming: the items
   * in scope, which the user can narrow, and the four effect statements
   * (local copies, server data, shared access, future re-upload). Omitted by
   * every existing caller, which therefore renders exactly as before. While it
   * is set and nothing is in scope, Delete is disabled. "In scope" means a
   * selected id that is present in `items`; a selected id that is no longer
   * in `items` counts for nothing.
   *
   * While it is set the dialog caps its height to the viewport and scrolls the
   * review between a fixed header and footer, so Delete and Cancel stay
   * reachable however long the list is.
   */
  scopeReview?: DeletionScopeReviewProps;
};

/** The selected ids that are present in `items`, in `items` order. */
function scopeIdsInItems({
  items,
  selectedIds,
}: Pick<DeletionScopeReviewProps, "items" | "selectedIds">): string[] {
  const selected = new Set(selectedIds);
  return items.filter((item) => selected.has(item.id)).map((item) => item.id);
}

export function DeleteConfirmationDialog({
  open,
  onOpenChange,
  title,
  itemName,
  onConfirm,
  isPending = false,
  description,
  scopeReview,
}: Readonly<DeleteConfirmationDialogProps>) {
  // Dialog on desktop, bottom Sheet below `sm` — one markup tree, the hook
  // swaps the catalog primitive family and keeps focus trap / Escape / a11y.
  const { Root, Content, Header, Footer, Title, Description, isMobile } =
    useResponsiveModal();
  // The review is the only part that scrolls: the content is capped to the
  // viewport (the Sheet already is) and laid out as a column, so header and
  // footer keep their height and Delete stays on screen. The Sheet's slots
  // carry their own padding and its body does not, so the bottom-sheet layout
  // also pads the review to match them.
  const scopeReviewClassName = cn(
    "min-h-0 overflow-y-auto",
    isMobile && "px-4"
  );
  const scopeLayout = scopeReview
    ? { content: "flex max-h-[90vh] flex-col", fixed: "shrink-0" }
    : undefined;
  // The review below takes `className` and `disabled` AFTER the `scopeReview`
  // spread, so no key on `scopeReview` can unlock the scope while a deletion
  // is in flight.
  //
  // Only selected ids the user can see count: a host that refreshes `items`
  // can leave ids in `selectedIds` that no longer render a checkbox.
  const scopeIds = scopeReview ? scopeIdsInItems(scopeReview) : [];
  const scopeIsEmpty = scopeReview !== undefined && scopeIds.length === 0;

  const handleDelete = async () => {
    try {
      const success = await (scopeReview ? onConfirm(scopeIds) : onConfirm());
      // Only close on success: a falsy/failed result keeps the dialog open for
      // retry, matching the sibling ConfirmationDialog convention.
      if (success) {
        onOpenChange(false);
      }
    } catch {
      // The failure is already surfaced by the global mutation onError handler;
      // swallow it here so the unawaited onClick promise never rejects.
    }
  };

  return (
    <Root onOpenChange={onOpenChange} open={open}>
      <Content className={scopeLayout?.content}>
        <Header className={scopeLayout?.fixed}>
          <Title>Delete {title}</Title>
          <Description>
            {description ??
              `Are you sure you want to delete "${itemName}"? This action cannot be undone.`}
          </Description>
        </Header>
        {scopeReview ? (
          <DeletionScopeReview
            {...scopeReview}
            className={scopeReviewClassName}
            disabled={isPending}
          />
        ) : null}
        <Footer className={scopeLayout?.fixed}>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            Cancel
          </Button>
          <Button
            disabled={isPending || scopeIsEmpty}
            onClick={handleDelete}
            variant="destructive"
          >
            {isPending ? "Deleting..." : "Delete"}
          </Button>
        </Footer>
      </Content>
    </Root>
  );
}
