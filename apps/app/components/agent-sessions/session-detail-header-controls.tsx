"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { PanelRightIcon } from "lucide-react";

type SessionDetailActionsProps = {
  commentsRailOpen: boolean;
  onToggleCommentsRail: () => void;
};

/** Primary session detail actions pinned to the right side of the header. */
export function SessionDetailActions({
  commentsRailOpen,
  onToggleCommentsRail,
}: Readonly<SessionDetailActionsProps>) {
  const commentsLabel = commentsRailOpen
    ? "Hide comments rail"
    : "Show comments rail";

  return (
    <Button
      aria-label={commentsLabel}
      aria-pressed={commentsRailOpen}
      onClick={onToggleCommentsRail}
      size="icon-sm"
      title={commentsLabel}
      variant="ghost"
    >
      <PanelRightIcon className="h-4 w-4" />
    </Button>
  );
}
