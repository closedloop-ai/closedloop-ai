"use client";

import {
  GridTable,
  type GridTableColumn,
} from "@repo/design-system/components/ui/grid-table";
import { CircleIcon } from "lucide-react";
import {
  type CellAction,
  cellStateFor,
  HARNESS_LABEL,
  HARNESS_ORDER,
  type Harness,
  type PackComponent,
  type Target,
} from "../mock";
import { MatrixCell } from "./matrix-cell";

// Rows = compute targets, columns = harnesses. The GridTable carries the grid
// structure (Parker: let the grid carry it, don't box every cell). The leading
// column is the target (machine name, platform, online dot); one data column per
// harness. Each data cell renders exactly one status via MatrixCell.
type InstallMatrixProps = {
  component: PackComponent;
  targets: readonly Target[];
  onCellAction: (
    targetId: string,
    harness: Harness,
    action: CellAction
  ) => void;
};

const COLUMNS: readonly GridTableColumn[] = HARNESS_ORDER.map((harness) => ({
  id: harness,
  label: HARNESS_LABEL[harness],
}));

// Lead (target) column, then one equal track per harness.
const GRID_TEMPLATE = "minmax(220px,1.2fr) repeat(3, minmax(200px,1fr))";

// The online/offline dot. Non-color-only: an outline ring reads as offline, a
// filled dot as online, and every row carries the platform text besides.
const OnlineDot = ({ online }: { online: boolean }) => (
  <CircleIcon
    aria-hidden="true"
    className={
      online
        ? "size-2.5 shrink-0 fill-success text-success"
        : "size-2.5 shrink-0 text-muted-foreground"
    }
  />
);

const TargetLead = ({ target }: { target: Target }) => (
  <div className="flex min-w-0 items-center gap-2">
    <OnlineDot online={target.online} />
    <div className="flex min-w-0 flex-col">
      <span className="truncate font-medium text-sm">{target.name}</span>
      <span className="truncate text-muted-foreground text-xs">
        {target.online ? target.platform : `${target.platform} · Offline`}
      </span>
    </div>
  </div>
);

export const InstallMatrix = ({
  component,
  targets,
  onCellAction,
}: InstallMatrixProps) => {
  const renderCell = (columnId: string, target: Target) => {
    const harness = columnId as Harness;
    const state = cellStateFor(component, target, harness);
    return (
      <MatrixCell
        harness={harness}
        onAction={onCellAction}
        state={state}
        target={target}
      />
    );
  };

  return (
    <div className="overflow-x-auto">
      <GridTable
        columns={COLUMNS}
        getRowId={(target) => target.id}
        gridTemplateColumns={GRID_TEMPLATE}
        items={[...targets]}
        leadingLabel="Target"
        renderCell={renderCell}
        renderLead={(target) => <TargetLead target={target} />}
      />
    </div>
  );
};
