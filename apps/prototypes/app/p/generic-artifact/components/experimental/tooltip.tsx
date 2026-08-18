// biome-ignore-all lint/performance/noBarrelFile: This isolated prototype adapter intentionally preserves the copied component surface.
"use client";

// Experimental variant scoped to Generic Artifact pending explicit promotion review.

import { TooltipContent as DesignSystemTooltipContent } from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
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
} from "@repo/design-system/components/ui/tooltip";
export { TooltipContent };
