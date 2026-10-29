"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { PanelRightIcon } from "lucide-react";

/** Shared route-chrome control for the generic artifact comments rail. */
export function ArtifactCommentsToggle({
  closeLabel = "Hide comments rail",
  onToggle,
  open,
  openLabel = "Show comments rail",
}: {
  closeLabel?: string;
  onToggle: () => void;
  open: boolean;
  openLabel?: string;
}) {
  return (
    <Button
      aria-label={open ? closeLabel : openLabel}
      aria-pressed={open}
      onClick={onToggle}
      size="icon-sm"
      type="button"
      variant="ghost"
    >
      <PanelRightIcon aria-hidden />
    </Button>
  );
}
