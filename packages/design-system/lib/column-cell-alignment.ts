"use client";

/**
 * The registry-aware half of the ISS-9821 alignment channel: turning a COLUMN's
 * declared `ColumnAlignment` into the boolean a data cell publishes.
 *
 * Split from the context and hook in `table-cell-alignment.ts` (marisolashgrove,
 * review of #6901) because those are read by the leaf value primitives, which
 * every grid host bundles: keeping this resolver here is what keeps the
 * 629-line `column-registry` out of `table-cell-primitives`. Only
 * `grid-table-v2` — which already holds a column array — has a
 * `ColumnAlignment` to resolve.
 */

import { ColumnAlignment } from "@closedloop-ai/design-system/lib/column-registry";

/**
 * The value a data cell publishes for its column: `null` when the column states
 * no alignment or the gate is closed, otherwise whether that alignment is the
 * trailing edge.
 *
 * THE `undefined` CHECK IS LOAD-BEARING AND NARROWER THAN IT LOOKS. An absent
 * `align` means a HAND-BUILT column array — which is every production v2 host
 * today — and those must keep each primitive's own default, or opening the gate
 * would start-align every Number cell in the product at once. It does NOT mean
 * "the author stated nothing": a column emitted by `toGridColumn` always carries
 * a resolved alignment, its own or its kind's, so a registry-built set publishes
 * on every column and the kind default becomes authoritative for the value as
 * well as the header. That is the intended reading of a kind default, not a leak
 * — but it is the reason this cannot be described as "declared or not".
 */
export function resolveCellAlignEnd(
  align: ColumnAlignment | undefined,
  enabled: boolean
): boolean | null {
  if (enabled && align !== undefined) {
    return align === ColumnAlignment.End;
  }
  return null;
}
