"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import {
  clampInlineImageWidth,
  InlineImageLayout,
} from "@repo/document-schema/inline-image-layout";
import {
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  Baseline,
  type LucideIcon,
} from "lucide-react";
import {
  type MouseEvent,
  type PointerEvent,
  type RefObject,
  useEffect,
  useRef,
} from "react";

// Labels approved by the operator in the image-layout request (2026-10-06).
const LAYOUT_OPTIONS: ReadonlyArray<{
  layout: InlineImageLayout;
  label: string;
  icon: LucideIcon;
}> = [
  { layout: InlineImageLayout.Inline, label: "Inline", icon: Baseline },
  {
    layout: InlineImageLayout.WrapLeft,
    label: "Wrap left",
    icon: AlignHorizontalJustifyStart,
  },
  {
    layout: InlineImageLayout.Center,
    label: "Center",
    icon: AlignHorizontalJustifyCenter,
  },
  {
    layout: InlineImageLayout.WrapRight,
    label: "Wrap right",
    icon: AlignHorizontalJustifyEnd,
  },
];

type InlineImageLayoutToolbarProps = {
  layout: InlineImageLayout;
  onLayoutChange: (layout: InlineImageLayout) => void;
};

export function InlineImageLayoutToolbar({
  layout,
  onLayoutChange,
}: Readonly<InlineImageLayoutToolbarProps>) {
  return (
    <span
      className="inline-image-toolbar flex gap-0.5 rounded-md border bg-popover p-0.5 shadow-sm"
      contentEditable={false}
    >
      {LAYOUT_OPTIONS.map(({ layout: option, label, icon: Icon }) => (
        <Tooltip key={option}>
          <TooltipTrigger asChild>
            <Button
              aria-label={label}
              aria-pressed={layout === option}
              className={cn(
                "h-7 w-7 p-0 text-foreground",
                layout === option && "bg-accent"
              )}
              onClick={() => onLayoutChange(option)}
              onMouseDown={keepEditorSelection}
              size="sm"
              type="button"
              variant="ghost"
            >
              <Icon className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{label}</p>
          </TooltipContent>
        </Tooltip>
      ))}
    </span>
  );
}

type InlineImageResizeHandleProps = {
  imageRef: RefObject<HTMLImageElement | null>;
  layout: InlineImageLayout;
  onPreview: (width: number | null) => void;
  onCommit: (width: number) => void;
};

type ResizeDrag = {
  startX: number;
  startWidth: number;
  maxWidth: number;
  direction: number;
  width: number;
};

export function InlineImageResizeHandle({
  imageRef,
  layout,
  onPreview,
  onCommit,
}: Readonly<InlineImageResizeHandleProps>) {
  const dragRef = useRef<ResizeDrag | null>(null);

  // A key press that moves the selection unmounts this handle mid-drag, so
  // `endDrag` never runs and the parent keeps showing the unsaved preview width
  // — which then masks every later width update. Releasing the preview on
  // unmount is the only place that covers it, since nothing else observes the
  // drag.
  useEffect(
    () => () => {
      if (dragRef.current) {
        dragRef.current = null;
        onPreview(null);
      }
    },
    [onPreview]
  );

  const handlePointerDown = (event: PointerEvent<HTMLSpanElement>) => {
    const image = imageRef.current;
    if (!image || event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startWidth = image.getBoundingClientRect().width;
    const maxWidth = getEditorContentWidth(image);
    dragRef.current = {
      startX: event.clientX,
      startWidth,
      maxWidth,
      direction: getResizeDirection(layout),
      // Clamped here, not only on move: a press and release with no movement
      // commits this value, and the raw rect width is fractional whenever the
      // page is zoomed or `max-width: 100%` squeezes the image. A fractional
      // width is one `parseInlineImageWidth` rejects, so the node would hold a
      // width nothing renders and the stored one would be gone from the
      // markdown on the next save.
      width: clampInlineImageWidth(startWidth, maxWidth),
    };
  };

  const handlePointerMove = (event: PointerEvent<HTMLSpanElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    drag.width = clampInlineImageWidth(
      drag.startWidth + (event.clientX - drag.startX) * drag.direction,
      drag.maxWidth
    );
    onPreview(drag.width);
  };

  const endDrag = (event: PointerEvent<HTMLSpanElement>, commit: boolean) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    onPreview(null);
    if (commit) {
      onCommit(drag.width);
    }
  };

  // Pointer-only affordance: there is no approved label for a keyboard slider,
  // so the handle stays out of the accessibility tree.
  return (
    <span
      aria-hidden="true"
      className="inline-image-resize-handle"
      contentEditable={false}
      data-side={layout === InlineImageLayout.WrapRight ? "start" : "end"}
      onPointerCancel={(event) => endDrag(event, false)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => endDrag(event, true)}
    />
  );
}

function keepEditorSelection(event: MouseEvent) {
  event.preventDefault();
}

// The handle sits on the left edge of a right-floated image, so dragging left
// grows it; a centered image grows on both sides, so it moves twice as fast.
function getResizeDirection(layout: InlineImageLayout): number {
  if (layout === InlineImageLayout.WrapRight) {
    return -1;
  }
  return layout === InlineImageLayout.Center ? 2 : 1;
}

function getEditorContentWidth(image: HTMLElement): number {
  const container = image.closest<HTMLElement>(".ProseMirror");
  return container?.clientWidth ?? Number.POSITIVE_INFINITY;
}
