// biome-ignore-all lint/performance/noBarrelFile: The v2 adapter intentionally preserves the approved prototype surface.
"use client";

// Grid Table v2 promotion candidate, copied from the approved Generic Artifact prototype.

import { TooltipContent as DesignSystemTooltipContent } from "@closedloop-ai/design-system/components/ui/tooltip";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import type { ComponentProps } from "react";

function TooltipContent({
  className,
  sideOffset = 6,
  hideArrow = true,
  ...props
}: ComponentProps<typeof DesignSystemTooltipContent>) {
  return (
    <DesignSystemTooltipContent
      className={cn(
        "border border-border bg-popover px-2.5 py-1.5 text-popover-foreground shadow-md [&>svg]:bg-transparent [&>svg]:fill-popover [&>svg]:stroke-border",
        className
      )}
      hideArrow={hideArrow}
      sideOffset={sideOffset}
      {...props}
    />
  );
}

export {
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
} from "@closedloop-ai/design-system/components/ui/tooltip";
export { TooltipContent };
