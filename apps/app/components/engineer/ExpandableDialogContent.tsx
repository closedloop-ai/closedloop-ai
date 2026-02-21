"use client";

import { DialogContent } from "@repo/design-system/components/ui/dialog";
import { cn } from "@repo/design-system/lib/utils";
import { Maximize2, Minimize2 } from "lucide-react";
import { type ComponentProps, forwardRef } from "react";

type BaseDialogContentProps = ComponentProps<typeof DialogContent>;

interface ExpandableDialogContentProps extends BaseDialogContentProps {
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  showOverlay?: boolean;
}

/**
 * DialogContent wrapper that adds fullscreen expand/collapse support.
 * Drop-in replacement for the custom DialogContent in closedloop-dev.
 */
export const ExpandableDialogContent = forwardRef<
  HTMLDivElement,
  ExpandableDialogContentProps
>(
  (
    { className, children, isExpanded, onToggleExpand, showOverlay, ...props },
    ref
  ) => {
    return (
      <DialogContent
        className={cn(
          isExpanded &&
            "!w-[100vw] !h-[100vh] !max-w-none !max-h-none !rounded-none",
          className
        )}
        ref={ref}
        showOverlay={showOverlay}
        {...props}
      >
        {children}
        {onToggleExpand && (
          <button
            className="absolute top-4 right-12 cursor-pointer rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
            onClick={onToggleExpand}
            type="button"
          >
            {isExpanded ? (
              <Minimize2 className="size-4" />
            ) : (
              <Maximize2 className="size-4" />
            )}
            <span className="sr-only">
              {isExpanded ? "Exit fullscreen" : "Fullscreen"}
            </span>
          </button>
        )}
      </DialogContent>
    );
  }
);
ExpandableDialogContent.displayName = "ExpandableDialogContent";
