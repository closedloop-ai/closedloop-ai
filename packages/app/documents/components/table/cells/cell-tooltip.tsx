"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import type { ReactElement } from "react";

export function CellTooltip({
  children,
  text,
}: {
  children: ReactElement;
  text?: string | null;
}) {
  if (!text) {
    return children;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="max-w-xs text-pretty break-words text-left">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

export function TruncatedTitle({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block truncate font-medium text-base text-foreground">
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}
