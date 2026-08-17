"use client";

import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { getRowTypeConfig } from "@repo/app/documents/components/table/row-type-registry";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  ArrowDownToLineIcon,
  ArrowUpToLineIcon,
  EllipsisIcon,
  Layers2Icon,
  SparklesIcon,
  TrashIcon,
} from "lucide-react";

type DocumentRowActionsProps = {
  /** The row this menu belongs to; gates the type-specific actions. */
  item: DocumentRowItem;
  /**
   * Offer Move-to-top / Move-to-bottom. True only on the active stack-rank
   * surface for a rankable root row (`isDndEnabled && isRankableMenuItem`),
   * resolved by the owning view.
   */
  showRankActions: boolean;
  /**
   * Offer "Generate PRD". Gated by `canGeneratePrdFromRow` in the owning view
   * (evergreen Document rows only).
   */
  canGeneratePrd: boolean;
  onMoveToTop: () => void;
  onMoveToBottom: () => void;
  onMove: () => void;
  onGeneratePrd: () => void;
  onDelete: () => void;
};

/**
 * Per-row overflow ("More actions") menu for the documents table (FEA-4242).
 *
 * Each row renders its own self-contained `DropdownMenu` whose trigger is the
 * row's real "More actions" button — matching the app-wide row-actions pattern
 * (`ProjectRowActions`, the branch/session/agent `*RowActionsMenu` family).
 * Radix anchors the popover to that trigger and returns focus to it on close,
 * so there is no view-level menu, no invisible anchor span, no manually
 * measured rect, and no `onCloseAutoFocus` focus-stranding — those failure
 * modes are eliminated by construction.
 */
export function DocumentRowActions({
  item,
  showRankActions,
  canGeneratePrd,
  onMoveToTop,
  onMoveToBottom,
  onMove,
  onGeneratePrd,
  onDelete,
}: Readonly<DocumentRowActionsProps>) {
  // Only DOCUMENT artifacts can be moved between projects; deletability comes
  // from the row-type registry (branches are deletable from the tree, etc.).
  const canMove = item.kind === "document";
  const canDelete = getRowTypeConfig(item)?.deletable === true;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="More actions"
          className="h-8 w-8 text-muted-foreground"
          size="icon"
          variant="ghost"
        >
          <EllipsisIcon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {showRankActions && (
          <>
            <DropdownMenuItem onClick={onMoveToTop}>
              <ArrowUpToLineIcon className="h-4 w-4" />
              Move to top
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onMoveToBottom}>
              <ArrowDownToLineIcon className="h-4 w-4" />
              Move to bottom
            </DropdownMenuItem>
          </>
        )}
        {canMove && (
          <DropdownMenuItem onClick={onMove}>
            <Layers2Icon className="h-4 w-4" />
            Move to Project
          </DropdownMenuItem>
        )}
        {canGeneratePrd && (
          <DropdownMenuItem onClick={onGeneratePrd}>
            <SparklesIcon className="h-4 w-4" />
            Generate PRD
          </DropdownMenuItem>
        )}
        {canDelete && (
          <DropdownMenuItem onClick={onDelete} variant="destructive">
            <TrashIcon className="h-4 w-4 text-destructive" />
            Delete
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
