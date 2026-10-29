"use client";

/**
 * The Agents card's headline attributes — the values `AgentCard` promotes out of
 * the key/value body and up beside the component name (ISS-5532).
 *
 * Its own module rather than more weight on `agents-table.tsx`, which is already
 * well past the 500-line smell: this is one responsibility (what the card header
 * says about a row, and how) with no reach into the grid path, so it splits on a
 * real seam.
 */

import type { AgentComponent } from "@repo/api/src/types/agent-component";
import {
  LOC_METRIC_DEFINITION,
  LocMetricDefinitionId,
} from "@repo/api/src/types/loc-metric-definitions";
import {
  buildGridTableCardHeaderFields,
  GridTableCardHeaderFields,
  type GridTableColumn,
} from "@repo/design-system/components/ui/grid-table";
import type { ReactNode } from "react";

/**
 * The promoted attributes, in the order the card header states them.
 *
 * THE list, not a copy of one: `agents-table.tsx` derives the body's exclusion
 * set from this array plus the row-actions id, so an attribute promoted here
 * cannot also appear in the body, and a fourth one added later cannot be
 * promoted in one place and left in the other.
 */
export const AGENT_CARD_HEADER_ATTRIBUTE_IDS = ["type", "metric"] as const;

/**
 * The card's headline attributes under the name lead, rendered through the
 * table's own cell renderer so the chip and the value are identical to the grid
 * row.
 *
 * ISS-5532, ON: each value is paired with its own COLUMN's label in a `dt`/`dd`
 * relationship. The card has no header row, so a promoted value otherwise
 * arrives anonymous — the card opened `Tool —`. Sourcing the terms from
 * `columns` rather than from literals is what stops the card and the grid header
 * naming the same column two different ways.
 *
 * OFF, the pre-ISS-5532 line: a bare Type chip and a hand-built label/value span
 * for the metric.
 *
 * `showMetric` is threaded in rather than left to the shared builder's emptiness
 * filter because the metric's `—` is produced INSIDE `MetricCell`, where
 * `isEmptyCellValue` (which matches on element type) cannot see it — the
 * ISS-5475 contract that the whole labelled group goes when the metric is
 * unavailable, rather than the header reading `LOC / $ —`.
 */
export function AgentCardHeaderAttributes({
  columns,
  item,
  labelledAttributes,
  renderCellForItem,
  showMetric,
  showType,
}: {
  columns: readonly GridTableColumn[];
  item: AgentComponent;
  labelledAttributes?: boolean;
  renderCellForItem: (columnId: string, item: AgentComponent) => ReactNode;
  showMetric: boolean;
  showType: boolean;
}): ReactNode {
  if (labelledAttributes) {
    const shown = { metric: showMetric, type: showType };
    return (
      <GridTableCardHeaderFields
        fields={buildGridTableCardHeaderFields(
          columns,
          AGENT_CARD_HEADER_ATTRIBUTE_IDS.filter((id) => shown[id]),
          renderCellForItem,
          item
        )}
      />
    );
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {showType ? renderCellForItem("type", item) : null}
      {showMetric ? (
        <span className="flex min-w-0 items-center gap-1">
          <span className="text-muted-foreground text-xs">
            {
              LOC_METRIC_DEFINITION[LocMetricDefinitionId.ComponentLinesChanged]
                .label
            }
          </span>
          {renderCellForItem("metric", item)}
        </span>
      ) : null}
    </div>
  );
}
