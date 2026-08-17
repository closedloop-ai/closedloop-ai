"use client";

import { InfoHint } from "@repo/design-system/components/ui/primitives/info-hint";
import { getMetricInfo } from "../lib/metric-info";

/**
 * The (i) info button shown on every insights tile. Surfaces what a metric
 * measures and how it is computed. No-op when the tile id has no registered
 * definition. Behaviour comes from the shared `InfoHint` primitive: hover/focus
 * reveals it and pointer-out dismisses it, with no click required (FEA-3819).
 */
export function InfoTip({ tileId }: { tileId: string }) {
  const info = getMetricInfo(tileId);
  if (!info) {
    return null;
  }
  return (
    <InfoHint
      align="end"
      contentClassName="w-72 space-y-2 text-sm"
      label="Metric details"
      // `insights-widget-control` is the dashboard grid's drag `cancel` selector
      // (dashboard-grid.tsx), so a press on the info button is never read as the
      // start of a tile drag. The ghost colors + hover chip match the sibling
      // edit/pin/expand controls in the tile's control cluster (button.tsx
      // `ghost` variant) so the info icon isn't the odd one out; a later class
      // here wins the `cn` merge over the primitive's muted-`/60` resting color.
      triggerClassName="insights-widget-control size-6 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
    >
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
    </InfoHint>
  );
}
