import { cn } from "@repo/design-system/lib/utils";

type Segment = {
  key: string;
  label: string;
  value: number;
  colorClassName: string;
  textClassName?: string;
};

type SegmentedBarProps = {
  segments: Segment[];
  total: number;
  className?: string;
};

export function SegmentedBar({
  segments,
  total,
  className,
}: SegmentedBarProps) {
  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted/50">
        {segments.map((segment) => {
          const pct = total > 0 ? (segment.value / total) * 100 : 0;
          if (pct <= 0) {
            return null;
          }
          return (
            <div
              className={cn(
                segment.colorClassName,
                "opacity-85 transition-opacity hover:opacity-100"
              )}
              key={segment.key}
              style={{ width: `${pct}%` }}
              title={`${segment.label}: ${segment.value.toLocaleString()} (${pct.toFixed(1)}%)`}
            />
          );
        })}
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {segments.map((segment) => {
          const pct = total > 0 ? (segment.value / total) * 100 : 0;
          return (
            <div className="flex items-center gap-2" key={segment.key}>
              <span
                className={cn(
                  "block size-2 rounded-full",
                  segment.colorClassName
                )}
              />
              <span className="text-[11px] text-muted-foreground">
                {segment.label}
              </span>
              <span
                className={cn(
                  "ml-auto font-mono text-xs",
                  segment.textClassName
                )}
              >
                {segment.value.toLocaleString()}
                {pct > 0 ? (
                  <span className="ml-1 text-[10px] text-muted-foreground">
                    {pct >= 1 ? Math.round(pct) : pct.toFixed(1)}%
                  </span>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
