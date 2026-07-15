"use client";

import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@closedloop-ai/design-system/components/ui/dropdown-menu";
import { toast } from "@closedloop-ai/design-system/components/ui/sonner";
import {
  CheckCheck,
  Copy,
  Ellipsis,
  MessageSquareIcon,
  Pencil,
  Trash2,
} from "lucide-react";

export type CommentActionMenuProps = {
  canEdit?: boolean;
  canDelete?: boolean;
  isResolvePending?: boolean;
  onEditToggle: () => void;
  onDelete: () => void;
  onChatAboutThis?: () => void;
  onResolveAction?: () => void;
  resolveLabel?: string;
  copyValue?: string | null;
  copySuccessMessage?: string;
  chatLabel?: string;
};

export function CommentActionMenu({
  canEdit = true,
  canDelete = true,
  isResolvePending = false,
  onEditToggle,
  onDelete,
  onChatAboutThis,
  onResolveAction,
  resolveLabel,
  copyValue,
  copySuccessMessage = "Copied link",
  chatLabel = "Chat About This",
}: Readonly<CommentActionMenuProps>) {
  const hasCopyValue = typeof copyValue === "string" && copyValue.length > 0;

  function copyLink(): void {
    if (!hasCopyValue || !globalThis.navigator.clipboard?.writeText) {
      return;
    }
    globalThis.navigator.clipboard
      .writeText(copyValue)
      .then(() => toast.success(copySuccessMessage))
      .catch(() => {
        // Keep clipboard failure silent to match existing menu behavior.
      });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="More actions"
          className="h-7 w-7 shrink-0 p-0"
          data-comment-control="true"
          onClick={(event) => event.stopPropagation()}
          size="icon"
          variant="ghost"
        >
          <Ellipsis className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {onResolveAction && resolveLabel ? (
          <DropdownMenuItem
            disabled={isResolvePending}
            onSelect={onResolveAction}
          >
            <CheckCheck className="mr-2 h-3.5 w-3.5" />
            {resolveLabel}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem disabled={!canEdit} onSelect={onEditToggle}>
          <Pencil className="mr-2 h-3.5 w-3.5" />
          Edit
        </DropdownMenuItem>
        {onChatAboutThis ? (
          <DropdownMenuItem onSelect={onChatAboutThis}>
            <MessageSquareIcon className="mr-2 h-3.5 w-3.5" />
            {chatLabel}
          </DropdownMenuItem>
        ) : null}
        {hasCopyValue ? (
          <DropdownMenuItem onSelect={copyLink}>
            <Copy className="mr-2 h-3.5 w-3.5" />
            Copy Link
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem disabled={!canDelete} onSelect={onDelete}>
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
