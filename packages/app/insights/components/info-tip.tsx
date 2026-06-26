"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { InfoIcon } from "lucide-react";
import { getMetricInfo } from "../lib/metric-info";

/**
 * The (i) info button shown on every tile. Surfaces what a metric measures and
 * how it is computed. No-op when the tile id has no registered definition.
 */
export function InfoTip({ tileId }: { tileId: string }) {
  const info = getMetricInfo(tileId);
  if (!info) {
    return null;
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-label="Metric details"
          className="insights-widget-control size-6 text-muted-foreground"
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          size="icon"
          variant="ghost"
        >
          <InfoIcon className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-2 text-sm">
        <div>
          <div className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            What
          </div>
          <p>{info.what}</p>
        </div>
        <div>
          <div className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            How
          </div>
          <p className="text-muted-foreground">{info.how}</p>
        </div>
        <div>
          <div className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            From session logs
          </div>
          <p className="text-muted-foreground">{info.sessions}</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
