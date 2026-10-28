"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { PanelRightIcon } from "lucide-react";
import type { RefObject } from "react";
import {
  type CommentsPaneOpenKey,
  useCommentsPaneVisibility,
} from "./use-comments-pane-state";

type ToggleTarget = Readonly<{
  controlsId?: string;
  toggleRef?: RefObject<HTMLButtonElement | null>;
}>;

/**
 * ISS-12300 D3: the header's show/hide button for the pane saved under
 * `openKey`. Renders nothing on a tab without a comments pane.
 */
export function CommentsPaneToggle({
  openKey,
  paneOnTab,
  ...target
}: ToggleTarget &
  Readonly<{ openKey: CommentsPaneOpenKey; paneOnTab: boolean }>) {
  const { open, setOpen } = useCommentsPaneVisibility(openKey);
  if (!paneOnTab) {
    return null;
  }
  return (
    <CommentsPaneToggleButton {...target} onOpenChange={setOpen} open={open} />
  );
}

export function CommentsPaneToggleButton({
  controlsId,
  onOpenChange,
  open,
  toggleRef,
}: ToggleTarget &
  Readonly<{ onOpenChange: (open: boolean) => void; open: boolean }>) {
  const label = open ? "Hide comments rail" : "Show comments rail";

  return (
    <Button
      aria-controls={controlsId}
      aria-expanded={open}
      aria-label={label}
      aria-pressed={open}
      onClick={() => onOpenChange(!open)}
      ref={toggleRef}
      size="icon-sm"
      title={label}
      type="button"
      variant="ghost"
    >
      <PanelRightIcon aria-hidden />
    </Button>
  );
}
