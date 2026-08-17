"use client";

import { Chip } from "@repo/design-system/components/ui/chip";
import { cn } from "@repo/design-system/lib/utils";
import { useContext, useEffect, useRef, useState } from "react";
import {
  TAG_COLOR_OPTIONS,
  type TagColor,
  TagEditorContext,
} from "./artifact-list-model";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./experimental/tooltip";

function tagColorClassName(color: TagColor): string | undefined {
  return TAG_COLOR_OPTIONS.find((item) => item.color === color)?.chipClassName;
}

export function TagsCell({ tags }: { tags: readonly string[] }) {
  const tagEditor = useContext(TagEditorContext);
  return (
    <ResponsiveChipList
      classNameForValue={(value) =>
        tagColorClassName(
          tagEditor?.definitions.find(
            (definition) => definition.label === value
          )?.color ?? "none"
        )
      }
      values={tags}
      variant="outline"
    />
  );
}

const CHIP_GAP_PX = 4;
const CHIP_OVERFLOW_WIDTH_PX = 30;

export function ResponsiveChipList({
  classNameForValue,
  values,
  variant,
}: {
  classNameForValue?: (value: string) => string | undefined;
  values: readonly string[];
  variant: "muted" | "outline";
}) {
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
      let usedWidth = 0;
      let nextVisibleCount = 0;
      for (let index = 0; index < widths.length; index += 1) {
        const gapWidth = nextVisibleCount > 0 ? CHIP_GAP_PX : 0;
        const overflowWidth =
          index < widths.length - 1 ? CHIP_GAP_PX + CHIP_OVERFLOW_WIDTH_PX : 0;
        if (
          usedWidth + gapWidth + widths[index] + overflowWidth >
          availableWidth
        ) {
          break;
        }
        usedWidth += gapWidth + widths[index];
        nextVisibleCount += 1;
      }
      setVisibleCount(nextVisibleCount);
    };
    updateVisibleCount();
    const observer = new ResizeObserver(updateVisibleCount);
    observer.observe(container);
    return () => observer.disconnect();
  }, [measurementKey]);

  const visibleValues = values.slice(0, visibleCount);
  const hiddenValues = values.slice(visibleCount);
  return (
    <span
      className="relative flex w-full min-w-0 items-center gap-1 overflow-hidden"
      ref={containerRef}
    >
      {visibleValues.map((value) => (
        <Chip
          className={cn("max-w-full shrink-0", classNameForValue?.(value))}
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
