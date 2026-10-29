"use client";

import { tagChipClassName } from "@repo/app/shared/components/tag-chip";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import { useContext, useEffect, useRef, useState } from "react";
import { TagEditorContext } from "./artifact-list-model";

export function TagsCell({ tags }: { tags: readonly string[] }) {
  const tagEditor = useContext(TagEditorContext);
  return (
    <ResponsiveChipList
      // ISS-6385: colours come from the canonical tag palette, not a local map.
      // A tag with no definition yields no colour class and keeps the outline
      // Chip's own muted default, which is what the deleted `"none"` entry drew.
      classNameForValue={(value) => {
        const color = tagEditor?.definitions.find(
          (definition) => definition.label === value
        )?.color;
        return color ? tagChipClassName(color) : undefined;
      }}
      values={tags}
      variant="outline"
    />
  );
}

const CHIP_GAP_PX = 4;
const CHIP_OVERFLOW_WIDTH_PX = 30;

/**
 * How many of `values` fit on one line of the container, measured from the
 * rendered chip widths and re-measured on resize. Leaves room for the `+N`
 * overflow chip whenever a later value would not fit. Shared by
 * {@link ResponsiveChipList} and the reference-list cell in
 * `artifact-list-custom-cells.tsx`.
 */
export function useResponsiveVisibleCount(values: readonly string[]) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const measurementRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [visibleCount, setVisibleCount] = useState(Math.min(2, values.length));
  const measurementKey = values.join("\u0000");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const updateVisibleCount = () => {
      const availableWidth = container.clientWidth;
      const measuredCount = measurementKey ? measurementRefs.current.length : 0;
      const widths = measurementRefs.current
        .slice(0, measuredCount)
        .map((element) => element?.offsetWidth ?? 0);
      setVisibleCount(fitVisibleChipCount(widths, availableWidth));
    };
    updateVisibleCount();
    const observer = new ResizeObserver(updateVisibleCount);
    observer.observe(container);
    return () => observer.disconnect();
  }, [measurementKey]);

  return { containerRef, measurementRefs, visibleCount };
}

export function ResponsiveChipList({
  classNameForValue,
  values,
  variant,
}: {
  classNameForValue?: (value: string) => string | undefined;
  values: readonly string[];
  variant: "muted" | "outline";
}) {
  const { containerRef, measurementRefs, visibleCount } =
    useResponsiveVisibleCount(values);

  const visibleValues = values.slice(0, visibleCount);
  const hiddenValues = values.slice(visibleCount);
  return (
    <span
      className="relative flex w-full min-w-0 items-center gap-1 overflow-hidden"
      ref={containerRef}
    >
      {visibleValues.map((value, index) => (
        <Chip
          className={cn(
            "max-w-full",
            index === 0 ? "min-w-0 shrink" : "shrink-0",
            classNameForValue?.(value)
          )}
          key={value}
          variant={variant}
        >
          <span className="truncate">{value}</span>
        </Chip>
      ))}
      {hiddenValues.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex h-5 shrink-0 cursor-pointer items-center rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">
              +{hiddenValues.length}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            <div className="flex flex-col gap-1">
              {hiddenValues.map((value) => (
                <span key={value}>{value}</span>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      ) : null}
      <span
        aria-hidden
        className="pointer-events-none absolute flex items-center gap-1 opacity-0"
      >
        {values.map((value, index) => (
          <Chip
            className={cn("shrink-0", classNameForValue?.(value))}
            key={value}
            ref={(element) => {
              measurementRefs.current[index] = element;
            }}
            variant={variant}
          >
            {value}
          </Chip>
        ))}
      </span>
    </span>
  );
}

/**
 * How many chips fit, leaving room for the `+N` chip whenever a later one would
 * not. Never zero while there is a value: a cell does not show only an
 * overflow count, so the first chip stays, truncated (ISS-12938 visual QA).
 */
export function fitVisibleChipCount(
  widths: readonly number[],
  availableWidth: number
): number {
  let usedWidth = 0;
  let visibleCount = 0;
  for (let index = 0; index < widths.length; index += 1) {
    const gapWidth = visibleCount > 0 ? CHIP_GAP_PX : 0;
    const overflowWidth =
      index < widths.length - 1 ? CHIP_GAP_PX + CHIP_OVERFLOW_WIDTH_PX : 0;
    if (usedWidth + gapWidth + widths[index] + overflowWidth > availableWidth) {
      break;
    }
    usedWidth += gapWidth + widths[index];
    visibleCount += 1;
  }
  return widths.length > 0 ? Math.max(1, visibleCount) : visibleCount;
}
