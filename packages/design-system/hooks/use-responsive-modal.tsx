"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@closedloop-ai/design-system/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@closedloop-ai/design-system/components/ui/sheet";
import { useMediaQuery } from "@closedloop-ai/design-system/hooks/use-media-query";
import type { ComponentProps, ComponentType } from "react";

/**
 * The component family a responsive modal renders through. Both the Dialog and
 * the Sheet catalog primitives expose the same header / footer / title /
 * description slots, so a consumer writes one markup tree and this hook swaps
 * the underlying primitive by pointer/viewport — a centered Dialog on desktop,
 * a bottom `Sheet` on a small touch screen where a centered modal is awkward to
 * reach and dismiss.
 */
export type ResponsiveModalParts = {
  Root: ComponentType<ComponentProps<typeof Dialog>>;
  /**
   * Content wrapper. On mobile this is the bottom `SheetContent` (already
   * pinned to `side="bottom"`); a caller does not pass `side`.
   */
  Content: ComponentType<Omit<ComponentProps<typeof DialogContent>, "side">>;
  Header: ComponentType<ComponentProps<typeof DialogHeader>>;
  Footer: ComponentType<ComponentProps<typeof DialogFooter>>;
  Title: ComponentType<ComponentProps<typeof DialogTitle>>;
  Description: ComponentType<ComponentProps<typeof DialogDescription>>;
};

const DIALOG_PARTS: ResponsiveModalParts = {
  Root: Dialog,
  Content: DialogContent,
  Header: DialogHeader,
  Footer: DialogFooter,
  Title: DialogTitle,
  Description: DialogDescription,
};

// The bottom sheet fills the width and rounds its top corners so it reads as a
// sheet rising from the edge rather than a full-height side panel. The rest of
// the slot styling (padding, gaps) is already shipped by the Sheet primitives,
// so only the delta is passed here.
function ResponsiveSheetContent({
  className,
  ...props
}: Omit<ComponentProps<typeof SheetContent>, "side">) {
  return (
    <SheetContent
      className={["max-h-[90vh] rounded-t-lg", className]
        .filter(Boolean)
        .join(" ")}
      side="bottom"
      {...props}
    />
  );
}

const SHEET_PARTS: ResponsiveModalParts = {
  Root: Sheet,
  Content: ResponsiveSheetContent,
  Header: SheetHeader,
  Footer: SheetFooter,
  Title: SheetTitle,
  Description: SheetDescription,
};

/**
 * Returns the modal primitive family to render for the current surface: a
 * centered `Dialog` on desktop, a bottom `Sheet` below the `sm` breakpoint.
 * Both families are catalog components with matching slots, so a consumer
 * writes the markup once and reads `isMobile` only when a slot genuinely needs
 * to differ (e.g. footer button order). Focus trap, Escape-to-close, and the
 * accessible title/description contract come from whichever primitive is
 * active — nothing is re-implemented here.
 *
 * `sm` is 640px, matching the design-system breakpoint scale. The server
 * snapshot is desktop (`false`), so SSR renders the Dialog and the client
 * swaps to the Sheet after mount without a hydration mismatch.
 */
export function useResponsiveModal(): ResponsiveModalParts & {
  isMobile: boolean;
} {
  const isMobile = useMediaQuery("(max-width: 639px)");
  const parts = isMobile ? SHEET_PARTS : DIALOG_PARTS;
  return { ...parts, isMobile };
}
