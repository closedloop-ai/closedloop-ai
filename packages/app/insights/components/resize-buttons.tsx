import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";

const RESIZE_OPTIONS = [
  { label: "1/2", width: 6 },
  { label: "Full", width: 12 },
] as const;

/**
 * Inline width controls overlaid on an Insights tile's hover affordances. Shared
 * by the KPI stat tile and the generic insights tile so the resize behavior and
 * option set stay in sync across both surfaces. The optional `className` lets a
 * call site tweak the wrapper (e.g. adding `bg-card`) without diverging the copy.
 */
export function ResizeButtons({
  onResize,
  className,
}: {
  onResize: (width: number) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "insights-widget-control hidden items-center rounded border p-0.5 md:flex",
        className
      )}
    >
      {RESIZE_OPTIONS.map((option) => (
        <Button
          className="h-6 px-1.5 text-[10px]"
          key={option.width}
          onClick={(event) => {
            event.stopPropagation();
            onResize(option.width);
          }}
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          size="sm"
          type="button"
          variant="ghost"
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}
