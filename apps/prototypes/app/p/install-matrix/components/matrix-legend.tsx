"use client";

import { CellState } from "../mock";
import { CELL_STATUS } from "./cell-status";

// Decodes the cell glyphs once, so the matrix stays scannable without a glyph
// meaning being color-only. Order mirrors the lifecycle a cell moves through.
const LEGEND_ORDER: readonly CellState[] = [
  CellState.Installed,
  CellState.Updatable,
  CellState.Converting,
  CellState.NotInstalled,
  CellState.OfflineUnknown,
  CellState.Unsupported,
];

export const MatrixLegend = () => (
  <ul className="flex flex-wrap items-center gap-x-5 gap-y-2">
    {LEGEND_ORDER.map((state) => {
      const status = CELL_STATUS[state];
      return (
        <li
          className="flex items-center gap-1.5 text-muted-foreground text-xs"
          key={state}
        >
          {status.render(16)}
          {status.label}
        </li>
      );
    })}
  </ul>
);
