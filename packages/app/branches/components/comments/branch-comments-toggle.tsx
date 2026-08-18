"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { PanelRightIcon } from "lucide-react";
import type { RefObject } from "react";

/** Prototype-faithful header affordance for the tab-scoped comments rail. */
export function BranchCommentsToggle({
  open,
  onOpenChange,
  toggleRef,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  toggleRef: RefObject<HTMLButtonElement | null>;
}>) {
  const label = open ? "Hide comments rail" : "Show comments rail";

  return (
    <Button
      aria-controls="branch-comments-workspace"
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
