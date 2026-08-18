import { cn } from "@repo/design-system/lib/utils";
import {
  leadIdlePct,
  leadLegend,
  leadPrOpenedPct,
  leadSegmentColor,
  leadSegments,
  leadTimeLabel,
} from "./mock";
import { SectionHead } from "./section-head";

const IDLE_SWATCH_CLASS =
  "bg-[repeating-linear-gradient(45deg,transparent,transparent_2px,var(--muted-foreground)_2px,var(--muted-foreground)_3px)]";

export function LeadTime() {
  return (
    <section className="mt-9">
      <SectionHead
        count={`${leadTimeLabel} · ${leadIdlePct}% idle`}
        title="Lead time for change"
      />
      <div className="relative">
        <div className="flex h-3 w-full gap-px overflow-hidden rounded-full bg-muted/40">
          {leadSegments.map((segment) => {
            const color = leadSegmentColor(segment.key);
            return (
              <span
                className={cn(
                  "block h-full",
                  color === null && IDLE_SWATCH_CLASS
                )}
                key={segment.key}
                style={{
                  width: `${segment.pct}%`,
                  ...(color === null ? {} : { background: color }),
                }}
              />
            );
          })}
        </div>
        <span
          aria-hidden
          className="absolute -top-1 h-5 border-foreground/50 border-l"
          style={{ left: `${leadPrOpenedPct}%` }}
        />
      </div>
      <div className="relative mt-1.5 flex justify-between text-muted-foreground text-xs">
        <span>First code pushed</span>
        <span
          className="absolute -translate-x-1/2 whitespace-nowrap"
          style={{ left: `${leadPrOpenedPct}%` }}
        >
          PR opened
        </span>
        <span>Now</span>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-4 text-muted-foreground text-xs">
        {leadLegend.map((item) => {
          const color = leadSegmentColor(item.key);
          return (
            <span className="flex items-center gap-1.5" key={item.key}>
              <span
                className={cn(
                  "size-2.5 rounded-[3px]",
                  color === null && IDLE_SWATCH_CLASS
                )}
                style={color === null ? undefined : { background: color }}
              />
              {item.label}
              <b className="font-mono text-foreground">{item.value}</b>
            </span>
          );
        })}
      </div>
    </section>
  );
}
